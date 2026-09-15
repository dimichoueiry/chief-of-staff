import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { playerBin, playerBuilt, readyPlayer, resetPlayer, type Compile } from "../src/voice/player.js";

describe.skipIf(process.platform !== "darwin")("audio player", () => {
  let home: string;
  let src: string;
  const saved = process.env.COS_HOME;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cos-player-"));
    process.env.COS_HOME = home;
    src = join(home, "cos-play.swift");
    await writeFile(src, "// v1");
    resetPlayer();
  });
  afterEach(async () => {
    process.env.COS_HOME = saved;
    resetPlayer();
    await rm(home, { recursive: true, force: true });
  });

  it("uses afplay while it builds once in the background, then the built player", async () => {
    const builds: string[] = [];
    const compile: Compile = async (_src, bin) => {
      builds.push(bin);
      await new Promise((r) => setTimeout(r, 30));
      await writeFile(bin, "binary");
    };
    expect(readyPlayer(compile, src)).toBeNull();
    expect(readyPlayer(compile, src)).toBeNull(); // still building: no second build
    await playerBuilt();
    expect(builds).toHaveLength(1);
    expect(readyPlayer(compile, src)).toBe(playerBin(src));
    expect(readdirSync(join(home, "bin"))).toEqual([playerBin(src).split("/").pop()]); // no half-built file left

    // A changed player is rebuilt, and the old build removed.
    await writeFile(src, "// v2");
    expect(readyPlayer(compile, src)).toBeNull();
    await playerBuilt();
    expect(readdirSync(join(home, "bin"))).toEqual([playerBin(src).split("/").pop()]);
  });

  it("keeps using afplay when the build fails, without retrying on every sentence", async () => {
    let tries = 0;
    const broken: Compile = async () => {
      tries++;
      throw new Error("xcrun: error: no developer tools");
    };
    expect(readyPlayer(broken, src)).toBeNull();
    await playerBuilt();
    expect(readyPlayer(broken, src)).toBeNull();
    await playerBuilt();
    expect(tries).toBe(1);
    expect(existsSync(join(home, "bin"))).toBe(true);
    expect(readdirSync(join(home, "bin"))).toEqual([]);
  });
});
