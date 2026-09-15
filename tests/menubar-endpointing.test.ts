import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const hasSwift = await exec("which", ["swiftc"]).then(() => true, () => false);

// When listening ends is Swift logic in the menubar app; compile its checks and run them.
describe("menubar: when you've finished talking", () => {
  it.skipIf(!hasSwift)("passes the Endpointing checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cos-endpointing-"));
    try {
      const bin = join(dir, "check");
      await exec("swiftc", ["-o", bin, "apps/menubar/Sources/ChiefOfStaff/Endpointing.swift", "apps/menubar/Sources/ChiefOfStaff/WakePhrase.swift", "apps/menubar/Checks/main.swift"], { timeout: 240_000 });
      const { stdout } = await exec(bin).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? String(err) }));
      expect(stdout.split("\n").filter((l) => l.startsWith("FAIL"))).toEqual([]);
      expect(stdout).toContain("all checks passed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
