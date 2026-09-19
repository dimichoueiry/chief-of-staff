import { describe, expect, it, vi } from "vitest";
import { LiveCommands } from "../src/brain/live.js";
import type { FastDecision } from "../src/brain/fastlane.js";

const open: FastDecision = { open: { kind: "url", url: "https://example.com", label: "Example", trusted: true }, model: "jev-test", sure: 0.99 };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("Live command sessions", () => {
  it("executes duplicate deliveries once, but allows deliberately repeated commands with new IDs", async () => {
    const execute = vi.fn(async () => "Opened Example.");
    const live = new LiveCommands(async () => open, execute);
    const id = live.start();
    const a = live.submit(id, 1, "open Example");
    expect(live.submit(id, 1, "open Example")).toBe(a);
    expect(await a).toMatchObject({ kind: "action" });
    await live.submit(id, 1, "open Example");
    expect(execute).toHaveBeenCalledTimes(1);
    await live.submit(id, 2, "open Example");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("stopping cancels pending decisions and queued commands", async () => {
    const decision = deferred<FastDecision>();
    const decide = vi.fn(() => decision.promise);
    const execute = vi.fn(async () => "Opened.");
    const live = new LiveCommands(decide, execute);
    const id = live.start();
    const a = live.submit(id, 1, "open Example");
    const b = live.submit(id, 2, "open Example");
    await Promise.resolve();
    live.stop(id);
    decision.resolve(open);
    expect(await a).toMatchObject({ kind: "skip" });
    expect(await b).toMatchObject({ kind: "skip" });
    expect(execute).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("new sessions invalidate old decisions; an old stop cannot stop a new session", async () => {
    const decision = deferred<FastDecision>();
    const execute = vi.fn(async () => "Opened.");
    const live = new LiveCommands(() => decision.promise, execute);
    const old = live.start();
    const pending = live.submit(old, 1, "open Example");
    await Promise.resolve();
    const current = live.start();
    live.stop(old);
    decision.resolve(open);
    expect(await pending).toMatchObject({ kind: "skip" });
    expect(await live.submit(current, 1, "open Example")).toMatchObject({ kind: "action" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects unstarted, expired, invalid and out-of-order commands", async () => {
    let now = 0;
    const execute = vi.fn(async () => "Opened.");
    const live = new LiveCommands(async () => open, execute, () => now);
    expect(await live.submit("missing", 1, "open Example")).toMatchObject({ kind: "skip" });
    const id = live.start();
    for (const seq of [0, NaN, 0.5]) expect(await live.submit(id, seq, "open Example")).toMatchObject({ kind: "skip" });
    await live.submit(id, 2, "open Example");
    expect(await live.submit(id, 1, "open Example")).toMatchObject({ kind: "skip" });
    now = 30 * 60_000;
    expect(await live.submit(id, 3, "open Example")).toMatchObject({ kind: "skip" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("skips uncertain phrases and never retries an action that fails", async () => {
    const decide = vi.fn(async (): Promise<FastDecision> => ({ skip: "uncertain" }));
    const execute = vi.fn(async (): Promise<string> => { throw new Error("open failed"); });
    const live = new LiveCommands(decide, execute);
    const id = live.start();
    expect(await live.submit(id, 1, "I wonder what to do")).toMatchObject({ kind: "skip" });
    expect(execute).not.toHaveBeenCalled();
    decide.mockResolvedValue(open);
    expect(await live.submit(id, 2, "open Example")).toMatchObject({ kind: "error" });
    await live.submit(id, 2, "open Example");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("bounds the queue and does not execute a rejected delivery if resent", async () => {
    const decision = deferred<FastDecision>();
    const execute = vi.fn(async () => "Opened.");
    const live = new LiveCommands(() => decision.promise, execute);
    const id = live.start();
    const tasks = [1, 2, 3, 4].map(n => live.submit(id, n, "open Example"));
    expect(await live.submit(id, 5, "open Example")).toMatchObject({ kind: "skip" });
    decision.resolve(open);
    await Promise.all(tasks);
    expect(await live.submit(id, 5, "open Example")).toMatchObject({ kind: "skip" });
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
