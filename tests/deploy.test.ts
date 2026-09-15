import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { topLevelPackages } from "../src/cli/deploy.js";
import { loadEnvFile } from "../src/config.js";
import { scanActivity } from "../src/sensors/git.js";

describe("deploy helpers", () => {
  it("reduces npm ls output to top-level package folders, scoped or not", () => {
    const root = "/repo";
    const out = [
      "/repo",
      "/repo/node_modules/openai",
      "/repo/node_modules/@anthropic-ai/sdk",
      "/repo/node_modules/@anthropic-ai/sdk/node_modules/json-schema-to-ts",
      "/repo/node_modules/commander",
      "/elsewhere/node_modules/ignored",
    ].join("\n");
    expect(topLevelPackages(out, root)).toEqual(["node_modules/@anthropic-ai/sdk", "node_modules/commander", "node_modules/openai"]);
  });
});

describe("env files and unreadable folders", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-env-"));
  });
  afterEach(async () => {
    await chmod(join(dir, "locked"), 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it("never overrides a value that is already set", async () => {
    const file = join(dir, ".env");
    await writeFile(file, "COS_TEST_A=from-file\nCOS_TEST_B='quoted'\n# COS_TEST_C=commented\nCOS_TEST_D=\n");
    process.env.COS_TEST_A = "already";
    delete process.env.COS_TEST_B;
    try {
      loadEnvFile(file);
      expect(process.env.COS_TEST_A).toBe("already");
      expect(process.env.COS_TEST_B).toBe("quoted");
      expect(process.env.COS_TEST_C).toBeUndefined();
      expect(process.env.COS_TEST_D).toBeUndefined();
    } finally {
      delete process.env.COS_TEST_A;
      delete process.env.COS_TEST_B;
    }
    expect(() => loadEnvFile(join(dir, "missing.env"))).not.toThrow();
  });

  it("skips a project root it is not allowed to list instead of failing the brief", async () => {
    const locked = join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    await expect(scanActivity([locked, join(dir, "nope")])).resolves.toEqual([]);
  });
});
