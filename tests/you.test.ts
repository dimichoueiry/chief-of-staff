import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { git } from "../src/core/git.js";
import { Ledger } from "../src/core/ledger.js";
import { memoryFiles, readMemoryFile, resolveMemoryPath, saveMemoryFile, EditConflict, HEARTBEAT_TEMPLATE } from "../src/core/files.js";
import { createUiServer } from "../src/ui/server.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

describe("memory as files", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await makeTmpSelfhub());
    await cp(resolve("examples/selfhub-sample"), dir, { recursive: true });
  });
  afterEach(() => cleanup());

  it("lists who you are, the stores and the journal", async () => {
    const groups = await memoryFiles(dir);
    expect(groups.map((g) => g.name)).toEqual(["About you", "What it keeps", "Journal"]);
    expect(groups[1].files.map((f) => [f.path, f.exists])).toEqual([
      ["goals/projects.md", true], ["goals/reminders.md", true], ["notes/inbox.md", false], ["goals/heartbeat.md", false],
    ]);
    expect(groups[0].files.every((f) => !f.path.startsWith("goals/") && !f.path.startsWith("journal/"))).toBe(true);
  });

  it("refuses anything outside selfhub or not markdown", async () => {
    for (const bad of ["../x.md", "/etc/passwd", "goals/projects.txt", ".git/config.md", "a/../../x.md", ""]) {
      await expect(resolveMemoryPath(dir, bad)).rejects.toThrow("That isn't a memory file.");
    }
    const outside = await mkdtemp(join(tmpdir(), "cos-out-"));
    try {
      await writeFile(join(outside, "secret.md"), "x");
      await symlink(join(outside, "secret.md"), join(dir, "linked.md"));
      await expect(resolveMemoryPath(dir, "linked.md")).rejects.toThrow("That isn't a memory file.");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("saves and commits, starts the heartbeat rules from a template, and won't overwrite a newer file", async () => {
    const rules = await readMemoryFile(dir, "goals/heartbeat.md");
    expect(rules).toEqual({ path: "goals/heartbeat.md", text: HEARTBEAT_TEMPLATE, modified: null });
    const saved = await saveMemoryFile(dir, "goals/heartbeat.md", "# Heartbeat\n\n- Never on Sundays.", null);
    expect(await readFile(join(dir, "goals/heartbeat.md"), "utf8")).toBe("# Heartbeat\n\n- Never on Sundays.\n");
    expect(await git(dir, ["log", "-1", "--format=%s"])).toContain("cos: edited goals/heartbeat.md");

    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(dir, "goals/heartbeat.md"), "changed underneath\n");
    await expect(saveMemoryFile(dir, "goals/heartbeat.md", "mine", saved.modified)).rejects.toBeInstanceOf(EditConflict);
  });
});

describe("goals and memory in the app", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let home: string;
  let base: string;
  let close: () => Promise<void>;
  const post = async (path: string, b: unknown = {}) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, ...(await r.json()) };
  };
  const get = async (path: string) => (await fetch(`${base}${path}`)).json();

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTmpSelfhub());
    await cp(resolve("examples/selfhub-sample"), dir, { recursive: true });
    home = await mkdtemp(join(tmpdir(), "cos-home-"));
    process.env.COS_HOME = home;
    process.env.COS_CALENDAR = "none";
    const server = createUiServer({ config: loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent" }), today: "2026-09-22", offline: true, allowSpeech: false });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterEach(async () => {
    await close();
    await cleanup();
    await rm(home, { recursive: true, force: true });
    delete process.env.COS_HOME;
    delete process.env.COS_CALENDAR;
  });

  it("shows goals, changes a next action, and marks one done", async () => {
    const g = await get("/api/goals");
    expect(g.goals).toContainEqual(expect.objectContaining({ name: "drawcal", status: "active", deadline: "2026-09-30", next: "cut the export feature from v1" }));
    expect(g.goals.find((x: { name: string }) => x.name === "MLGuerrilla").deadline).toBe("");

    expect(await post("/api/goals/next", { project: "drawcal", next: "ship the beta to 5 friends" })).toMatchObject({ ok: true, next: "ship the beta to 5 friends" });
    expect((await new Ledger(dir).find("drawcal"))!.next).toBe("ship the beta to 5 friends");
    expect(await post("/api/goals/next", { project: "nope", next: "x" })).toMatchObject({ status: 404 });

    expect(await post("/api/decide", { project: "drawcal", choice: "done" })).toMatchObject({ status: "done", message: "drawcal is done. Well done." });
    expect((await get("/api/goals")).goals.find((x: { name: string }) => x.name === "drawcal").status).toBe("done");
  });

  it("opens and saves a memory file, and refuses a stale save or a bad path", async () => {
    const files = await get("/api/files");
    expect(files.soul).toMatchObject({ chars: 0 });
    const f = await get("/api/files/read?path=goals%2Freminders.md");
    expect(f.text).toContain("renew the domain");
    const ok = await post("/api/files/save", { path: "goals/reminders.md", text: `${f.text}- [ ] 2026-10-01 · new one\n`, base: f.modified });
    expect(ok).toMatchObject({ ok: true });
    expect(await post("/api/files/save", { path: "goals/reminders.md", text: "stale", base: f.modified })).toMatchObject({ status: 409 });
    expect(await post("/api/files/save", { path: "../escape.md", text: "x", base: null })).toMatchObject({ status: 400, error: "That isn't a memory file." });
    expect(await get("/api/files/read?path=..%2Fx.md")).toMatchObject({ error: "That isn't a memory file." });
  });

  it("serves the page", async () => {
    const html = await (await fetch(`${base}/you.html`)).text();
    expect(html).toContain('src="/you.js"');
    expect(await (await fetch(`${base}/you.js`)).text()).toContain("/api/goals");
  });
});
