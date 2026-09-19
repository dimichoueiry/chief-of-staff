import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function setup(post: (url: string, body: unknown) => Promise<unknown>) {
  const window: any = {};
  vm.runInNewContext(readFileSync("src/ui/web/live.js", "utf8"), { window });
  const events = { onStart: vi.fn(), onStop: vi.fn(), onResult: vi.fn(), onError: vi.fn() };
  return { live: window.cosLive.create({ post, ...events }), ...events };
}

describe("Live microphone bridge", () => {
  it("deduplicates native deliveries and serializes successive phrases", async () => {
    const post = vi.fn(async (url: string) => url.endsWith("start") ? { session: "test" } : { kind: "action", text: "Opened." });
    const { live, onResult } = setup(post);
    await live.start();
    await Promise.all([live.phrase("open X", "test", 1), live.phrase("open X", "test", 1), live.phrase("open Y", "test", 2)]);
    expect(post.mock.calls.filter(([url]) => url.endsWith("command"))).toHaveLength(2);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("stops a session that finishes starting after the user already cancelled", async () => {
    let resolve!: (r: unknown) => void;
    const post = vi.fn((url: string) => url.endsWith("start") ? new Promise(r => { resolve = r; }) : Promise.resolve({ ok: true }));
    const { live, onStart } = setup(post);
    const start = live.start();
    live.stop();
    resolve({ session: "late" });
    await start;
    expect(live.active).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("/api/live/stop", { session: "late" });
  });

  it("discards late replies and queued phrases when Live is turned off", async () => {
    let resolve!: (r: unknown) => void;
    const post = vi.fn((url: string) => url.endsWith("command") ? new Promise(r => { resolve = r; }) : Promise.resolve({ session: "test" }));
    const { live, onResult } = setup(post);
    await live.start();
    const first = live.phrase("open X", "test", 1);
    const second = live.phrase("open Y", "test", 2);
    await Promise.resolve();
    live.stop();
    resolve({ kind: "action", text: "Opened." });
    await Promise.all([first, second]);
    expect(post.mock.calls.filter(([url]) => url.endsWith("command"))).toHaveLength(1);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("does not start a microphone without a configured key", async () => {
    const { live, onStart, onError } = setup(async () => ({ error: "Add a TypeSafe API key" }));
    await live.start();
    expect(live.active).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Add a TypeSafe API key");
  });
});
