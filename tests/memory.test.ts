import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Journal } from "../src/core/journal.js";
import { Ledger } from "../src/core/ledger.js";
import { commitPaths, ensureRepo, gitAvailability, gitCandidates, installDeveloperTools, isRepo, resetGit, resolveGit } from "../src/core/git.js";
import { catchUpHistory, ensureStores, ensureStoresOnFirstRun, memoryState } from "../src/core/memory.js";
import { createUiServer } from "../src/ui/server.js";

/** Pretend this machine has no usable git, without touching the machine. */
function noGit(): void {
  process.env.COS_GIT = "/nonexistent/git";
  resetGit();
}
function realGit(): void {
  delete process.env.COS_GIT;
  resetGit();
}

describe("finding a git that actually runs", () => {
  it("prefers one from PATH and leaves Apple's stub until last, because running it opens a dialog", () => {
    const candidates = gitCandidates("/opt/homebrew/bin:/usr/bin:/bin", undefined);
    expect(candidates).toEqual(["/opt/homebrew/bin/git", "/bin/git", "/usr/bin/git"]);
    expect(candidates.at(-1)).toBe("/usr/bin/git");
  });

  it("takes COS_GIT alone when it is set, and never repeats a path", () => {
    expect(gitCandidates("/usr/bin", "/my/git")).toEqual(["/my/git"]);
    expect(gitCandidates("/usr/bin:/usr/bin", undefined)).toEqual(["/usr/bin/git"]);
  });
});

describe("a Mac without the developer tools", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cos-nogit-"));
    noGit();
  });
  afterEach(async () => {
    realGit();
    await rm(dir, { recursive: true, force: true });
  });

  it("says so, and names the developer tools as the fix when Apple's stub is all there is", async () => {
    const have = await gitAvailability();
    expect(have.ok).toBe(false);
    if (!have.ok) expect(have.reason).toContain("memory is still written");

    // The real shape of a Mac without the tools: /usr/bin/git is there, xcode-select says no.
    const stubOnly = await resolveGit({ candidates: ["/usr/bin/git"], exists: async () => true, toolsInstalled: async () => false });
    expect(stubOnly).toMatchObject({ ok: false, fix: "install-tools" });
    if (!stubOnly.ok) expect(stubOnly.reason).toContain("command line developer tools");
  });

  it("never runs Apple's stub when the tools are missing, because that is what opens the dialog", async () => {
    const ran: string[] = [];
    await resolveGit({
      candidates: ["/usr/bin/git"],
      exists: async () => true,
      toolsInstalled: async () => false,
      version: async (p) => { ran.push(p); return "git version 2.0.0"; },
    });
    expect(ran).toEqual([]);

    // With the tools installed it is used like any other.
    const withTools = await resolveGit({ candidates: ["/usr/bin/git"], exists: async () => true, toolsInstalled: async () => true, version: async () => "git version 2.39.5\n" });
    expect(withTools).toMatchObject({ ok: true, path: "/usr/bin/git", version: "git version 2.39.5", apple: true });
  });

  it("still writes the journal entry: the history is what's missing, not the note", async () => {
    const hash = await new Journal(dir).append("2026-09-15", "shipped the installer");
    expect(hash).toBeNull(); // nothing committed
    expect(readFileSync(join(dir, "journal", "2026-09-15.md"), "utf8")).toContain("shipped the installer");
  });

  it("still writes the ledger, and makes the folder without a repo in it", async () => {
    await new Ledger(dir).writeProject("drawcal", { why: "a calendar that draws", next: "record the intro" });
    expect(readFileSync(join(dir, "goals", "projects.md"), "utf8")).toContain("drawcal");
    expect(await ensureRepo(dir)).toBe(false);
    expect(await commitPaths(dir, ["goals/projects.md"], "cos: test")).toBeNull();
  });

  it("scaffolds every store, uncommitted, and reports history as off", async () => {
    const r = await ensureStores(dir);
    expect(r.created).toEqual(["ledger", "reminders", "notes"]);
    expect(r.commit).toBeNull();
    const state = await memoryState(dir);
    expect(state).toMatchObject({ ready: true, missing: [], exists: true });
    expect(state.history.on).toBe(false);
  });
});

describe("with a git that works", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cos-git-"));
    realGit();
  });
  afterEach(async () => {
    realGit();
    await rm(dir, { recursive: true, force: true });
  });

  it("makes the repo, commits the stores, and says history is on", async () => {
    const r = await ensureStores(dir);
    expect(r.created).toEqual(["ledger", "reminders", "notes"]);
    expect(r.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(await isRepo(dir)).toBe(true);
    const state = await memoryState(dir);
    expect(state.ready).toBe(true);
    if (state.history.on) expect(state.history.lastCommit).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    else throw new Error("history should be on when git works");
  });

  it("never touches a store that is already there", async () => {
    await ensureStores(dir);
    writeFileSync(join(dir, "goals", "projects.md"), "# Projects\n\nmine, edited by hand\n");
    const again = await ensureStores(dir);
    expect(again.created).toEqual([]);
    expect(readFileSync(join(dir, "goals", "projects.md"), "utf8")).toContain("edited by hand");
  });

  it("takes what was written without git into the history the moment git works", async () => {
    noGit();
    await ensureStores(dir);
    await new Journal(dir).append("2026-09-15", "written with no history");
    expect(await isRepo(dir)).toBe(false);

    realGit();
    const commit = await catchUpHistory(dir);
    expect(commit).toMatch(/^[0-9a-f]{7,}$/);
    const { git } = await import("../src/core/git.js");
    const tracked = (await git(dir, ["ls-files"])).trim().split("\n").sort();
    expect(tracked).toEqual(["goals/projects.md", "goals/reminders.md", "journal/2026-09-15.md", "notes/inbox.md"]);
    // Nothing left to do the second time.
    expect(await catchUpHistory(dir)).toBeNull();
  });

  it("leaves anything else in the folder out of it", async () => {
    await ensureStores(dir);
    writeFileSync(join(dir, "my-own-file.md"), "not the app's\n");
    await catchUpHistory(dir);
    const { git } = await import("../src/core/git.js");
    expect((await git(dir, ["ls-files"])).trim()).not.toContain("my-own-file");
  });

  it("offers nothing to install when git already works", async () => {
    const r = await installDeveloperTools();
    expect(r.started).toBe(false);
    expect(r.message).toContain("already works");
  });
});

describe("the first run only", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cos-first-"));
    realGit();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sets up an empty folder, and a folder that isn't there yet", async () => {
    expect((await ensureStoresOnFirstRun(dir))?.created).toEqual(["ledger", "reminders", "notes"]);
    const fresh = join(dir, "not-yet");
    expect((await ensureStoresOnFirstRun(fresh))?.created).toEqual(["ledger", "reminders", "notes"]);
  });

  it("leaves a folder that already holds something alone, so a deleted store stays deleted", async () => {
    await ensureStores(dir);
    await rm(join(dir, "goals", "reminders.md"));
    expect(await ensureStoresOnFirstRun(dir)).toBeNull();
    const state = await memoryState(dir);
    expect(state.missing).toEqual(["reminders"]);

    const other = mkdtempSync(join(tmpdir(), "cos-notmine-"));
    mkdirSync(join(other, "something"));
    expect(await ensureStoresOnFirstRun(other)).toBeNull();
    await rm(other, { recursive: true, force: true });
  });
});

describe("the memory endpoint the menu draws", () => {
  let dir: string;
  let server: ReturnType<typeof createUiServer>;
  let url: string;

  const start = async () => {
    server = createUiServer({
      config: loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent" }),
      today: "2026-09-17", offline: true, allowSpeech: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "cos-mem-api-")), "selfhub");
  });
  afterEach(async () => {
    await new Promise((r) => server.close(() => r(undefined)));
    realGit();
    await rm(dir, { recursive: true, force: true });
  });

  it("sets the stores up when the server starts, so nobody has to run cos init", async () => {
    realGit();
    await start();
    // The setup finishes before the first answer, so one request is enough: no waiting around.
    const state = await (await fetch(`${url}/api/memory`)).json();
    expect(state).toMatchObject({ dir, exists: true, ready: true, missing: [] });
    expect(state.history.on).toBe(true);
    expect(readFileSync(join(dir, "goals", "projects.md"), "utf8")).toContain("One block per project");
  });

  it("offers the fix when history is off, and only then", async () => {
    noGit();
    await start();
    const state = await (await fetch(`${url}/api/memory`)).json();
    expect(state.history.on).toBe(false);
    const titles = state.actions.map((a: { title: string }) => a.title);
    expect(titles).toContain("Look for git again");
    expect(titles.at(-1)).toBe("Open the folder");

    realGit();
    const back = await (await fetch(`${url}/api/memory/recheck`, { method: "POST" })).json();
    expect(back).toMatchObject({ ok: true, message: "History is on" });
    // Whatever else is offered, nothing about git is: that is what came back.
    const after = back.actions.map((a: { title: string }) => a.title);
    expect(after).not.toContain("Look for git again");
    expect(after).not.toContain("Turn history on (install developer tools)…");
    expect(after.at(-1)).toBe("Open the folder");
  });

  it("sets the stores up on demand when the folder was not empty at startup", async () => {
    noGit();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "my own notes\n");
    await start();
    expect((await (await fetch(`${url}/api/memory`)).json()).ready).toBe(false);

    const r = await (await fetch(`${url}/api/memory/init`, { method: "POST" })).json();
    expect(r).toMatchObject({ ok: true, message: `Set up ${dir}`, ready: true });
    expect(r.detail).toContain("ledger, reminders, notes");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("my own notes\n");
  });
});

describe("two writes at once", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cos-race-"));
    realGit();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps every one of them, because commits queue instead of colliding", async () => {
    await ensureStores(dir);
    const journal = new Journal(dir);
    // Several surfaces writing at the same moment used to fight over git's index.lock.
    const days = ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"];
    const commits = await Promise.all(days.map((d) => journal.append(d, `entry for ${d}`)));
    expect(commits.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
    for (const d of days) expect(readFileSync(join(dir, "journal", `${d}.md`), "utf8")).toContain(`entry for ${d}`);

    const { git } = await import("../src/core/git.js");
    const tracked = (await git(dir, ["ls-files", "journal"])).trim().split("\n").sort();
    expect(tracked).toEqual(days.map((d) => `journal/${d}.md`));
    // A clean repo: nothing half-staged and nothing left behind.
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  }, 60_000);

  it("does nothing at all when the history is already up to date", async () => {
    await ensureStores(dir);
    await new Journal(dir).append("2026-09-15", "written and committed");
    expect(await catchUpHistory(dir)).toBeNull();
    const { uncommitted } = await import("../src/core/git.js");
    expect(await uncommitted(dir, ["goals/projects.md", "journal/2026-09-15.md"])).toEqual([]);
  });
});

describe("scaffolding while something else is writing", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cos-clobber-"));
    realGit();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("never puts an empty template over a note that arrived first", async () => {
    // The first launch and a first capture can happen in the same instant.
    const ledger = new Ledger(dir);
    const [, scaffold] = await Promise.all([
      ledger.writeProject("drawcal", { why: "a calendar that draws", next: "record the intro" }),
      ensureStores(dir),
    ]);
    expect(readFileSync(join(dir, "goals", "projects.md"), "utf8")).toContain("drawcal");
    // Whichever order they landed in, the project survives and the other stores still exist.
    expect(scaffold.created).not.toContain("ledger-overwritten");
    const state = await memoryState(dir);
    expect(state.ready).toBe(true);
  }, 30_000);
});
