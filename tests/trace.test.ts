import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatTurn, readTraces, step, traceFile, traced, tracesDir } from "../src/util/trace.js";

describe("tracing a turn", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cos-trace-"));
    process.env.COS_HOME = home;
    delete process.env.COS_TRACE;
  });
  afterEach(async () => {
    delete process.env.COS_HOME;
    delete process.env.COS_TRACE;
    await rm(home, { recursive: true, force: true });
  });

  const written = async () => (await readFile(traceFile(), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("writes what was said, the steps taken and how long each took", async () => {
    const out = await traced("open my email", "auto", async () => {
      step("jev", "fast lane opened Mail", { sure: 0.91 });
      step("reply", "Opened Mail.", { kind: "action" });
      return "done";
    });
    expect(out).toBe("done");
    const [turn] = await written();
    expect(turn).toMatchObject({ said: "open my email", mode: "auto" });
    expect(turn.steps.map((s: { kind: string; detail: string }) => [s.kind, s.detail])).toEqual([
      ["jev", "fast lane opened Mail"],
      ["reply", "Opened Mail."],
    ]);
    expect(turn.steps[0].data).toEqual({ sure: 0.91 });
    expect(typeof turn.ms).toBe("number");
    expect(typeof turn.steps[0].at).toBe("number");
  });

  it("keeps the trace of a turn that threw, with the error as its last step", async () => {
    await expect(traced("do the thing", undefined, async () => {
      step("tool", "browser_click {}");
      throw new Error("the page moved");
    })).rejects.toThrow("the page moved");
    const [turn] = await written();
    expect(turn.steps.map((s: { kind: string }) => s.kind)).toEqual(["tool", "error"]);
    expect(turn.steps[1].detail).toBe("the page moved");
  });

  it("does nothing outside a turn, so a step anywhere else is harmless", async () => {
    step("tool", "ran on its own");
    await expect(readFile(traceFile(), "utf8")).rejects.toThrow();
  });

  it("writes nothing at all with COS_TRACE=off", async () => {
    process.env.COS_TRACE = "off";
    await traced("open my email", "auto", async () => step("jev", "opened Mail"));
    await expect(readFile(traceFile(), "utf8")).rejects.toThrow();
  });

  it("cuts a long detail rather than keeping a whole page in the file", async () => {
    await traced("read it", "auto", async () => step("result", "x".repeat(5_000)));
    const [turn] = await written();
    expect(turn.steps[0].detail).toHaveLength(401);
    expect(turn.steps[0].detail.endsWith("…")).toBe(true);
  });

  it("reads back the newest turns across days, newest last, and skips a half-written line", async () => {
    await mkdir(tracesDir(), { recursive: true });
    const line = (said: string) => `${JSON.stringify({ at: "2026-09-20T10:00:00.000Z", ms: 1, said, steps: [] })}\n`;
    await writeFile(join(tracesDir(), "2026-09-19.jsonl"), line("older"));
    await writeFile(join(tracesDir(), "2026-09-20.jsonl"), `${line("newer")}${line("newest")}{"half-writt`);
    expect(readTraces(3).map((t) => t.said)).toEqual(["older", "newer", "newest"]);
    expect(readTraces(2).map((t) => t.said)).toEqual(["newer", "newest"]);
  });

  it("shows a turn as lines a person can read", async () => {
    const text = formatTurn({
      at: "2026-09-21T14:03:09.000Z", ms: 2574, said: "open the article about Microsoft", mode: "auto",
      steps: [{ at: 12, kind: "browser", detail: 'step 1: link "Microsoft"', data: { p: 0.43, of: 192 } }],
    });
    expect(text.split("\n")).toEqual([
      '14:03:09  "open the article about Microsoft"  2574ms',
      '      12ms  browser step 1: link "Microsoft"  p=0.43 of=192',
    ]);
  });
});
