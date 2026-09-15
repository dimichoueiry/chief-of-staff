import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LOOK_REQUEST, describeShot } from "../src/sensors/screen.js";

const exec = promisify(execFile);
const hasSwift = await exec("which", ["swiftc"]).then(() => true, () => false);

describe("hearing a request to look", () => {
  it("catches the ways people ask it to look", () => {
    for (const s of [
      "look at this", "Hey, look at this for a sec", "what am I looking at?", "What's on my screen", "can you see this?", "do you see my screen",
      "what does this say", "read this for me", "take a look", "what is this error", "what's this popup", "check out my screen", "look at what I'm seeing",
    ]) expect([s, LOOK_REQUEST.test(s)]).toEqual([s, true]);
  });

  it("leaves ordinary questions alone", () => {
    for (const s of [
      "what should I do today?", "what's this week look like", "what is this project for", "look up tauri", "what's on my calendar",
      "open slate", "look into the pricing", "what is the next action for ML Guerilla",
    ]) expect([s, LOOK_REQUEST.test(s)]).toEqual([s, false]);
  });

  it("describes a capture in one line", () => {
    expect(describeShot({ app: "Microsoft Edge", window: "Campuswire", width: 1600, height: 1039 })).toBe(
      "A screenshot of their screen, taken just now (1600×1039); in front: Microsoft Edge (“Campuswire”). Chief of Staff's own windows are left out.",
    );
    expect(describeShot({ app: "", window: "", width: 800, height: 600 })).toContain("in front: their screen.");
  });
});

describe("the capture helper", () => {
  it.skipIf(!hasSwift)("compiles and reports permission without capturing anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cos-screen-"));
    try {
      const bin = join(dir, "cos-screen");
      await exec("swiftc", ["-O", "-o", bin, "src/sensors/screen/cos-screen.swift"], { timeout: 240_000 });
      const { stdout } = await exec(bin, ["check"]);
      expect(typeof JSON.parse(stdout).permission).toBe("boolean");
      await expect(exec(bin, ["dance"])).rejects.toMatchObject({ stdout: expect.stringContaining('"error":"usage"') });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
