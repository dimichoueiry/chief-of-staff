import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRepo, git, topLevel } from "../src/core/git.js";
import { Ledger } from "../src/core/ledger.js";

describe("ensureRepo with a nested memory folder", () => {
  let parent: string;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "cos-parent-"));
    await git(parent, ["init", "-q", "-b", "main"]);
    await git(parent, ["config", "user.email", "t@example.com"]);
    await git(parent, ["config", "user.name", "T"]);
    await writeFile(join(parent, "README.md"), "parent");
    await git(parent, ["add", "."]);
    await git(parent, ["commit", "-q", "-m", "parent initial"]);
  });
  afterEach(() => rm(parent, { recursive: true, force: true }));

  it("gives a folder inside another repo its own repo so writes never commit to the parent", async () => {
    const memory = join(parent, "examples", "selfhub");
    await mkdir(memory, { recursive: true });
    expect(await topLevel(memory)).toBe(await topLevel(parent));

    await ensureRepo(memory);
    await git(memory, ["config", "user.email", "t@example.com"]);
    await git(memory, ["config", "user.name", "T"]);
    const ledger = new Ledger(memory);
    await ledger.writeProject("X", { why: "isolation" });

    const nestedLog = await git(memory, ["log", "--format=%s"]);
    expect(nestedLog.trim()).toBe('cos: add project "X"');
    const parentLog = await git(parent, ["log", "--format=%s"]);
    expect(parentLog.trim()).toBe("parent initial");
  });

  it("leaves a folder that is already a repo top level alone", async () => {
    await ensureRepo(parent);
    expect((await git(parent, ["log", "--format=%s"])).trim()).toBe("parent initial");
  });
});
