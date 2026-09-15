import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRepo, git } from "../src/core/git.js";
import { Ledger } from "../src/core/ledger.js";
import { applyActivity, matchProject, scanActivity } from "../src/sensors/git.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

async function repoWithCommit(dir: string, when: string) {
  await ensureRepo(dir);
  await git(dir, ["config", "user.email", "t@example.com"]);
  await git(dir, ["config", "user.name", "T"]);
  await writeFile(join(dir, "a.txt"), when);
  await git(dir, ["add", "."]);
  await git(dir, ["-c", `user.email=t@example.com`, "commit", "-q", "-m", "work", "--date", when]);
}

describe("git activity sensor", () => {
  let root: string;
  let selfhub: { dir: string; cleanup: () => Promise<void> };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cos-roots-"));
    selfhub = await makeTmpSelfhub();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await selfhub.cleanup();
  });

  it("finds child repos with their last commit time and skips plain folders", async () => {
    await repoWithCommit(join(root, "drawcal"), "2026-09-12T10:00:00-04:00");
    await mkdir(join(root, "not-a-repo"));
    const activity = await scanActivity([root, join(root, "does-not-exist")]);
    expect(activity).toHaveLength(1);
    expect(activity[0].path).toBe(join(root, "drawcal"));
    expect(activity[0].lastCommit.startsWith("2026-09-12")).toBe(true);
  });

  it("matches by path field first, then by folder name", () => {
    const projects = [
      { name: "MLGuerrilla", status: "active", path: "/x/mlguerrilla-teach", extra: [] },
      { name: "Draw Cal", status: "active", extra: [] },
    ];
    expect(matchProject(projects, "/x/mlguerrilla-teach")?.name).toBe("MLGuerrilla");
    expect(matchProject(projects, "/y/drawcal")?.name).toBe("Draw Cal");
    expect(matchProject(projects, "/y/other")).toBeUndefined();
  });

  it("touches matching projects and only moves dates forward", async () => {
    await repoWithCommit(join(root, "drawcal"), "2026-09-12T10:00:00-04:00");
    await repoWithCommit(join(root, "old"), "2026-01-01T10:00:00-04:00");
    const ledger = new Ledger(selfhub.dir);
    await ledger.writeProject("drawcal", { lastTouched: "2026-09-01" });
    await ledger.writeProject("old", { lastTouched: "2026-06-01" });
    const touched = await applyActivity(ledger, await scanActivity([root]));
    expect(touched).toEqual([{ project: "drawcal", path: join(root, "drawcal"), date: "2026-09-12" }]);
    expect((await ledger.find("old"))?.lastTouched).toBe("2026-06-01");
  });
});

describe("activityRoots", () => {
  it("adds each project's own folder to the places searched for commits, once", async () => {
    const { activityRoots } = await import("../src/sensors/git.js");
    const projects = [
      { name: "ML Guerilla", status: "active", path: "~/Documents/GitHub/mlguerilla", extra: [] },
      { name: "drawcal", status: "active", path: "/Users/x/Desktop/drawcal", extra: [] },
      { name: "no path", status: "active", extra: [] },
    ];
    const roots = activityRoots(["/Users/x/Desktop", "/Users/x/Desktop/drawcal"], projects as never);
    expect(roots).toHaveLength(3);
    expect(roots[2]).toMatch(/\/Documents\/GitHub\/mlguerilla$/);
    expect(roots[2].startsWith("~")).toBe(false);
  });
});
