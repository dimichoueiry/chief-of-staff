import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPath, findApp, openOrQueue, performOpen, resolveOpen, safeWebUrl, takePending, type Runner,
} from "../src/actions/open.js";
import { Shortcuts, findShortcut, parseShortcuts } from "../src/actions/shortcuts.js";
import { fetchBoards, findBoards, slateBoardUrl, slateHomeUrl, type SlateBoard } from "../src/actions/slate.js";
import { ToolRuntime } from "../src/brain/tools.js";
import { loadConfig } from "../src/config.js";
import { git } from "../src/core/git.js";
import type { Project } from "../src/core/ledger.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

const boards: SlateBoard[] = [
  { id: "a1", name: "Chief of Staff — UI/UX (desktop, voice-first)", projectName: null, updatedAt: 300 },
  { id: "b2", name: "Chief of Staff — Build Blueprint (for the coding agent)", projectName: null, updatedAt: 200 },
  { id: "c3", name: "Talk Like Me", projectName: null, updatedAt: 100 },
  { id: "c4", name: "Talk Like Me (conflict, Jul 23, 11:20 a.m.)", projectName: null, updatedAt: 400 },
];
const loader = async () => ({ boards, live: true });

function recorder() {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push(args);
  };
  return { run, calls };
}

describe("what may be opened", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cos-home-open-"));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it("allows only http and https addresses", () => {
    expect(safeWebUrl("https://slate-iota-lac.vercel.app/app")).toBe("https://slate-iota-lac.vercel.app/app");
    expect(safeWebUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/");
    expect(safeWebUrl("javascript:alert(1)")).toBeNull();
    expect(safeWebUrl("file:///etc/passwd")).toBeNull();
    expect(safeWebUrl("x-apple.systempreferences:com.apple.preference")).toBeNull();
    expect(safeWebUrl("not a url")).toBeNull();
  });

  it("opens folders and documents inside home, refuses anything that can run code or lives outside", async () => {
    await mkdir(join(home, "project"));
    await writeFile(join(home, "notes.md"), "hi");
    await writeFile(join(home, "run.command"), "echo hi");
    await writeFile(join(home, "tool.sh"), "echo hi");
    await writeFile(join(home, "sneaky.md"), "#!/bin/sh");
    await chmod(join(home, "sneaky.md"), 0o755);
    await mkdir(join(home, "Fake.app"));

    expect(await checkPath(join(home, "project"), home)).toEqual({ path: join(home, "project") });
    expect(await checkPath(join(home, "notes.md"), home)).toEqual({ path: join(home, "notes.md") });
    expect(await checkPath(join(home, "run.command"), home)).toMatchObject({ error: expect.stringMatching(/run code/) });
    expect(await checkPath(join(home, "tool.sh"), home)).toMatchObject({ error: expect.stringMatching(/run code/) });
    expect(await checkPath(join(home, "sneaky.md"), home)).toMatchObject({ error: expect.stringMatching(/run code/) });
    expect(await checkPath(join(home, "Fake.app"), home)).toMatchObject({ error: expect.stringMatching(/apps are opened by name/) });
    expect(await checkPath("/etc", home)).toMatchObject({ error: expect.stringMatching(/home folder/) });
    expect(await checkPath(join(home, "missing"), home)).toMatchObject({ error: expect.stringMatching(/nothing at/) });
  });

  it("finds installed apps by loose name", async () => {
    await mkdir(join(home, "Cursor.app"));
    await mkdir(join(home, "Visual Studio Code.app"));
    expect(findApp("cursor", [home])).toBe(join(home, "Cursor.app"));
    expect(findApp("VS Code", [home])).toBe(join(home, "Visual Studio Code.app"));
    expect(findApp("photoshop", [home])).toBeNull();
  });
});

describe("resolving what you asked for", () => {
  const shortcuts = parseShortcuts("# Shortcuts\n\n- gmail: https://mail.google.com\n- drawcal repo: https://github.com/dimichoueiry/drawcal\n");
  const projects: Project[] = [
    { name: "drawcal", status: "active", path: "~", extra: [] },
    { name: "nuonc_rag", status: "active", extra: [] },
  ];
  const resolve = (target: string, app?: string) => resolveOpen({ target, app, shortcuts, projects, boards: loader });

  it("handles Slate and Slate boards by name, preferring originals over conflict copies", async () => {
    expect(await resolve("open slate")).toEqual({ ok: true, action: { kind: "url", url: slateHomeUrl(), label: "Slate", trusted: true } });
    const ui = await resolve("open slate board chief of staff ui");
    expect(ui).toMatchObject({ ok: true, action: { url: slateBoardUrl("a1"), trusted: true } });
    expect(await resolve("the build blueprint board on slate")).toMatchObject({ ok: true, action: { url: slateBoardUrl("b2") } });
    expect(await resolve("open my talk like me slate board")).toMatchObject({ ok: true, action: { url: slateBoardUrl("c3") } });
    const missing = await resolve("slate board groceries");
    expect(missing).toMatchObject({ ok: false, reason: 'no Slate board matches "groceries"' });
    expect(!missing.ok && missing.candidates?.[0]).toBe("Talk Like Me (conflict, Jul 23, 11:20 a.m.)");
  });

  it("handles shortcuts, searches, projects in apps, and marks raw web addresses untrusted", async () => {
    expect(await resolve("open my Gmail")).toMatchObject({ ok: true, action: { url: "https://mail.google.com/", trusted: true } });
    expect(await resolve("search for tauri menubar")).toMatchObject({ ok: true, action: { url: "https://www.google.com/search?q=tauri%20menubar", trusted: true } });
    expect(await resolve("open https://example.com/x")).toMatchObject({ ok: true, action: { url: "https://example.com/x", trusted: false } });
    expect(await resolve("example.com")).toMatchObject({ ok: true, action: { url: "https://example.com/", trusted: false } });
    expect(await resolve("drawcal", "Cursor")).toMatchObject({ ok: true, action: { kind: "path", app: "Cursor", label: "drawcal in Cursor" } });
    expect(await resolve("nuonc_rag")).toMatchObject({ ok: false, reason: expect.stringMatching(/no path/) });
    expect(await resolve("zzzz unknown thing")).toMatchObject({ ok: false, candidates: expect.arrayContaining(["gmail", "drawcal", "Slate"]) });
  });

  it("ranks boards: exact, then prefix, then words; ties by most recent", () => {
    expect(findBoards(boards, "talk like me").map((b) => b.id)).toEqual(["c3", "c4"]);
    expect(findBoards(boards, "chief of staff").map((b) => b.id)).toEqual(["a1", "b2"]);
    expect(findBoards(boards, "")).toEqual([]);
    expect(findShortcut(shortcuts, "the drawcal repo")?.target).toBe("https://github.com/dimichoueiry/drawcal");
  });
});

describe("opening and confirming", () => {
  it("opens trusted things at once and queues untrusted addresses for a one-time confirmation", async () => {
    const { run, calls } = recorder();
    const base = { shortcuts: [], projects: [], boards: loader };
    expect(await openOrQueue({ ...base, target: "slate" }, run)).toEqual({ status: "opened", message: "Opened Slate." });
    expect(calls).toEqual([[slateHomeUrl()]]);

    const q = await openOrQueue({ ...base, target: "https://example.com" }, run);
    expect(q.status).toBe("confirm");
    expect(calls).toHaveLength(1);
    const id = q.status === "confirm" ? q.pending.id : "";
    const pending = takePending(id);
    expect(pending?.action).toMatchObject({ url: "https://example.com/" });
    expect(takePending(id)).toBeNull(); // single use
    await performOpen(pending!.action, run);
    expect(calls.at(-1)).toEqual(["https://example.com/"]);

    const failed = await openOrQueue({ ...base, target: "nothing I know" }, run);
    expect(failed.status).toBe("failed");
  });

  it("refuses to open a path that has become unsafe since it was resolved", async () => {
    const { run } = recorder();
    await expect(performOpen({ kind: "path", path: "/etc/hosts", label: "hosts" }, run)).rejects.toThrow(/home folder/);
    await expect(performOpen({ kind: "url", url: "javascript:alert(1)", label: "x", trusted: true }, run)).rejects.toThrow(/http/);
  });

  it("explains why Slate board names can't be fetched instead of hanging", async () => {
    await expect(fetchBoards({ token: null })).rejects.toThrow(/isn't paired/);
    await expect(fetchBoards({ token: "t", port: 1, timeoutMs: 1500 })).rejects.toThrow(/bridge/);
  });
});

describe("shortcuts store and the open tool", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await makeTmpSelfhub()));
  afterEach(() => cleanup());

  it("saves, updates and removes shortcuts as commits", async () => {
    const store = new Shortcuts(dir);
    expect(await store.set("gmail", "https://mail.google.com")).toEqual({ created: true });
    expect(await store.set("Gmail", "https://mail.google.com/mail/u/1")).toEqual({ created: false });
    expect(await readFile(store.file, "utf8")).toBe("# Shortcuts\n\n- gmail: https://mail.google.com/mail/u/1\n");
    expect(await store.remove("gmail")).toBe(true);
    expect(await store.remove("gmail")).toBe(false);
    expect(await git(dir, ["log", "--format=%s"])).toContain('cos: shortcut "Gmail"');
  });

  it("lets the model open trusted things, queue web addresses, and save shortcuts safely", async () => {
    const { run, calls } = recorder();
    const rt = new ToolRuntime(loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent" }), "2026-09-17", undefined, { run, slate: loader });
    expect((await rt.execute("open", { target: "slate board build blueprint" })).result).toBe("Opened Slate board “Chief of Staff — Build Blueprint (for the coding agent)”.");
    expect(calls).toEqual([[slateBoardUrl("b2")]]);

    const queued = await rt.execute("open", { target: "https://totally-legit.example/login" });
    expect(queued.isError).toBe(false);
    expect(queued.result).toMatch(/confirm/);
    expect(rt.pending).toHaveLength(1);
    expect(calls).toHaveLength(1);

    expect((await rt.execute("open", { target: "nothing at all" })).isError).toBe(true);
    expect((await rt.execute("add_shortcut", { name: "agent grid", target: "http://127.0.0.1:8787" })).result).toContain("Saved");
    expect((await rt.execute("add_shortcut", { name: "bad", target: "javascript:alert(1)" })).isError).toBe(true);
    expect((await rt.execute("open", { target: "agent grid" })).result).toBe("Opened agent grid.");
  });
});
