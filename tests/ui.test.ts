import { cp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { git } from "../src/core/git.js";
import { Ledger } from "../src/core/ledger.js";
import { Notes } from "../src/core/notes.js";
import { Reminders } from "../src/core/reminders.js";
import { decide } from "../src/logic/decide.js";
import { resolveDate, scribe } from "../src/logic/scribe.js";
import { createUiServer } from "../src/ui/server.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

const THU = "2026-09-17";

describe("resolveDate", () => {
  it("resolves relative and absolute dates from a known today", () => {
    expect(resolveDate("friday", THU)).toBe("2026-09-18");
    expect(resolveDate("thursday", THU)).toBe("2026-09-24");
    expect(resolveDate("next monday", THU)).toBe("2026-09-28");
    expect(resolveDate("tomorrow", THU)).toBe("2026-09-18");
    expect(resolveDate("2026-10-01", THU)).toBe("2026-10-01");
    expect(resolveDate("sept 19", THU)).toBe("2026-09-19");
    expect(resolveDate("jan 5", THU)).toBe("2027-01-05");
    expect(resolveDate("whenever", THU)).toBeNull();
  });
});

describe("offline scribe", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await makeTmpSelfhub()));
  afterEach(() => cleanup());

  it("files reminders, projects, status changes, cadences, next actions, journal lines and notes", async () => {
    expect(await scribe(dir, "remind me friday to email the advisor", THU)).toMatchObject({ where: "reminder", message: "Reminder set for 2026-09-18: email the advisor" });
    expect(await scribe(dir, "remind me to renew the domain on 2026-09-30", THU)).toMatchObject({ where: "reminder" });
    expect((await new Reminders(dir).list()).map((r) => r.date)).toEqual(["2026-09-18", "2026-09-30"]);

    const created = await scribe(dir, "starting a project: fampy academy course, it's for course revenue", THU);
    expect(created).toMatchObject({ where: "ledger", message: 'Created project "fampy academy course" (why: course revenue).' });
    expect(created.question).toBeUndefined();
    const noWhy = await scribe(dir, "new project called drawcal", THU);
    expect(noWhy.question).toMatch(/What is "drawcal" for/);

    expect((await scribe(dir, "drawcal every thursday", THU)).message).toContain('cadence set to "thursday"');
    expect((await scribe(dir, "drawcal next: cut the export feature", THU)).message).toContain("next → cut the export feature");
    expect((await scribe(dir, "park drawcal for now", THU)).message).toBe("drawcal → parked.");
    const d = await new Ledger(dir).find("drawcal");
    expect(d).toMatchObject({ status: "parked", cadence: "thursday", next: "cut the export feature", lastTouched: THU });

    expect((await scribe(dir, "touched the landing page, next is the pricing section", THU)).where).toBe("journal");
    expect((await scribe(dir, "an idea: a pill that floats over every app", THU)).where).toBe("note");
    expect((await new Notes(dir).list()).map((n) => n.text)).toEqual(["an idea: a pill that floats over every app"]);
    expect(await git(dir, ["log", "--format=%s"])).toContain('cos: parked "drawcal"');
  });
});

describe("decide", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await makeTmpSelfhub()));
  afterEach(() => cleanup());

  it("keeps, parks and kills, resetting last touched", async () => {
    const ledger = new Ledger(dir);
    await ledger.writeProject("nuonc_rag", { lastTouched: "2026-08-24" });
    expect((await decide(ledger, "nuonc rag", "keep", THU)).status).toBe("active");
    expect((await ledger.find("nuonc_rag"))?.lastTouched).toBe(THU);
    expect((await decide(ledger, "nuonc_rag", "park", THU)).message).toContain("review in a month");
    expect((await decide(ledger, "nuonc_rag", "kill", THU)).status).toBe("killed");
    await expect(decide(ledger, "nope", "keep", THU)).rejects.toThrow(/No project/);
  });
});

describe("ui server (offline)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let base: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTmpSelfhub());
    await cp(resolve("examples/selfhub-sample"), dir, { recursive: true });
    process.env.COS_CALENDAR = "none";
    const server = createUiServer({
      config: loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent", COS_NAME: "Dimitri" }),
      today: THU,
      hasApiKey: false,
      allowSpeech: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterEach(async () => {
    await close();
    await cleanup();
    delete process.env.COS_CALENDAR;
  });

  it("serves the page and static assets", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('id="pill"');
    const js = await (await fetch(`${base}/app.js`)).text();
    expect(js).toContain("window.cosShell");
    expect(js).toContain("messageHandlers.shell");
    expect((await fetch(`${base}/app.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${base}/../package.json`)).status).not.toBe(200);
  });

  it("returns a fresh rule-based brief with speech text, then answers decisions", async () => {
    const r = await (await fetch(`${base}/api/brief?refresh=1`)).json();
    expect(r.source).toBe("rules");
    expect(r.offline).toBe(true);
    expect(r.brief.focus[0].project).toBe("MLGuerrilla");
    expect(r.speech).toContain("Good");
    expect(r.brief.decisions.map((d: { project: string }) => d.project)).toEqual(["nuonc_rag"]);

    const d = await (await fetch(`${base}/api/decide`, { method: "POST", body: JSON.stringify({ project: "nuonc_rag", choice: "park" }) })).json();
    expect(d.status).toBe("parked");
    const bad = await fetch(`${base}/api/decide`, { method: "POST", body: JSON.stringify({ project: "x", choice: "maybe" }) });
    expect(bad.status).toBe(400);
  });

  it("files captures offline through the pill and explains that questions need a key", async () => {
    const filed = await (await fetch(`${base}/api/pill`, { method: "POST", body: JSON.stringify({ text: "remind me friday to call the bank" }) })).json();
    expect(filed).toMatchObject({ kind: "capture", where: "reminder" });
    const q = await (await fetch(`${base}/api/pill`, { method: "POST", body: JSON.stringify({ text: "what should I do today?" }) })).json();
    expect(q.kind).toBe("answer");
    expect(q.text).toContain("ANTHROPIC_API_KEY");
    const projects = await (await fetch(`${base}/api/projects`)).json();
    expect(projects.map((p: { name: string }) => p.name)).toContain("drawcal");
    const spoke = await (await fetch(`${base}/api/speak`, { method: "POST", body: JSON.stringify({ text: "hi" }) })).json();
    expect(spoke.muted).toBe(true);
  });

  it("answers focus for a known project offline and stops speech on request", async () => {
    const f = await (await fetch(`${base}/api/pill`, { method: "POST", body: JSON.stringify({ text: "drawcal", mode: "focus" }) })).json();
    expect(f).toMatchObject({ kind: "focus", project: "drawcal" });
    expect(f.text).toContain("Recorded next action: cut the export feature from v1.");
    const missing = await fetch(`${base}/api/pill`, { method: "POST", body: JSON.stringify({ text: "nope", mode: "focus" }) });
    expect(missing.status).toBe(404);
    const stop = await (await fetch(`${base}/api/speak/stop`, { method: "POST", body: "{}" })).json();
    expect(stop).toEqual({ ok: true, stopped: false });
  });
});
