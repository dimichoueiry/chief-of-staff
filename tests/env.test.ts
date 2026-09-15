import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEnv, reloadHomeEnv, syncProjectEnv } from "../src/util/env.js";

describe("parseEnv", () => {
  it("reads plain, exported, quoted and commented lines and ignores empty values", () => {
    const m = parseEnv([
      "OPENROUTER_API_KEY=sk-or-abc",
      "export OPENAI_API_KEY='sk-quoted'",
      'ANTHROPIC_API_KEY = "sk-ant x"',
      "COS_NAME=Dimitri   # my name",
      "# COMMENTED=1",
      "EMPTY=",
      "not a line",
    ].join("\n"));
    expect(Object.fromEntries(m)).toEqual({
      OPENROUTER_API_KEY: "sk-or-abc",
      OPENAI_API_KEY: "sk-quoted",
      ANTHROPIC_API_KEY: "sk-ant x",
      COS_NAME: "Dimitri",
    });
  });
});

describe("keys file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-envtest-"));
  });
  afterEach(async () => {
    for (const k of ["COS_T_ADDED", "COS_T_REAL", "COS_T_GONE"]) delete process.env[k];
    await rm(dir, { recursive: true, force: true });
  });

  it("applies changes to a running process, removes deleted keys, and never overrides real env vars", async () => {
    const file = join(dir, ".env");
    process.env.COS_T_REAL = "from-shell";
    await writeFile(file, "COS_T_GONE=first\nCOS_T_REAL=from-file\n");
    expect(reloadHomeEnv(file)).toBe(true);
    expect(process.env.COS_T_GONE).toBe("first");
    expect(process.env.COS_T_REAL).toBe("from-shell");
    expect(reloadHomeEnv(file)).toBe(false); // unchanged file is not re-read

    await writeFile(file, "COS_T_ADDED=new-key\n");
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    expect(reloadHomeEnv(file)).toBe(true);
    expect(process.env.COS_T_ADDED).toBe("new-key");
    expect(process.env.COS_T_GONE).toBeUndefined();
    expect(process.env.COS_T_REAL).toBe("from-shell");
  });

  it("copies this project's .env when newer, privately, and ignores other projects", async () => {
    const project = join(dir, "project");
    const other = join(dir, "other");
    const target = join(dir, "home", ".env");
    await import("node:fs/promises").then((fs) => Promise.all([fs.mkdir(project), fs.mkdir(other)]));
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "chief-of-staff" }));
    await writeFile(join(other, "package.json"), JSON.stringify({ name: "something-else" }));
    await writeFile(join(other, ".env"), "SECRET=nope\n");
    expect(syncProjectEnv(other, target)).toBe("none");
    expect(syncProjectEnv(project, target)).toBe("none"); // no .env yet

    await writeFile(join(project, ".env"), "OPENROUTER_API_KEY=sk-or-1\n");
    expect(syncProjectEnv(project, target)).toBe("copied");
    expect(await readFile(target, "utf8")).toBe("OPENROUTER_API_KEY=sk-or-1\n");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(syncProjectEnv(project, target)).toBe("unchanged");

    await writeFile(join(project, ".env"), "OPENROUTER_API_KEY=sk-or-2\n");
    const later = new Date(Date.now() + 5000);
    await utimes(join(project, ".env"), later, later);
    expect(syncProjectEnv(project, target)).toBe("copied");
    expect(await readFile(target, "utf8")).toContain("sk-or-2");
  });
});
