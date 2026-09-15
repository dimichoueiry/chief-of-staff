import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, LLMProvider } from "../src/brain/llm/types.js";
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
  let home: string;
  let opened: string[][];

  beforeEach(async () => {
    opened = [];
    ({ dir, cleanup } = await makeTmpSelfhub());
    await cp(resolve("examples/selfhub-sample"), dir, { recursive: true });
    process.env.COS_CALENDAR = "none";
    // App state (cached brief, model choice) goes to a throwaway folder, never the real ~/.cos.
    home = await mkdtemp(join(tmpdir(), "cos-home-"));
    process.env.COS_HOME = home;
    const server = createUiServer({
      config: loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent", COS_NAME: "Dimitri" }),
      today: THU,
      offline: true,
      allowSpeech: false,
      openRunner: async (args) => {
        opened.push(args);
      },
      slateLoader: async () => ({ boards: [{ id: "a1", name: "Chief of Staff — UI/UX", projectName: null, updatedAt: 1 }], live: true }),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterEach(async () => {
    await close();
    await cleanup();
    await rm(home, { recursive: true, force: true });
    delete process.env.COS_CALENDAR;
    delete process.env.COS_HOME;
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
    expect(q.text).toContain("needs a model");
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

  it("opens Slate boards instantly from the pill and asks before opening a web address", async () => {
    const post = (b: unknown, path = "/api/pill") => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(b) });
    const slate = await (await post({ text: "open slate board chief of staff ui" })).json();
    expect(slate).toMatchObject({ kind: "action", text: "Opened Slate board “Chief of Staff — UI/UX”." });
    expect(opened).toEqual([["https://slate-iota-lac.vercel.app/board/a1"]]);

    const link = await (await post({ text: "open https://example.com/page" })).json();
    expect(link.kind).toBe("confirm");
    expect(opened).toHaveLength(1);
    const ok = await (await post({ id: link.confirm[0].id }, "/api/actions/confirm")).json();
    expect(ok.text).toBe("Opened https://example.com/page.");
    expect(opened.at(-1)).toEqual(["https://example.com/page"]);
    expect((await post({ id: link.confirm[0].id }, "/api/actions/confirm")).status).toBe(410);

    const another = await (await post({ text: "go to https://example.org" })).json();
    const cancelled = await (await post({ id: another.confirm[0].id, cancel: true }, "/api/actions/confirm")).json();
    expect(cancelled.text).toBe("Cancelled.");
    expect(opened).toHaveLength(2);

    const unknown = await (await post({ text: "open the thing from yesterday" })).json();
    expect(unknown.kind).toBe("answer");
    expect(unknown.text).toMatch(/^Couldn't open that/);
  });

  it("reads a calendar range and reports bad ranges", async () => {
    const week = await (await fetch(`${base}/api/calendar?from=2026-09-17&to=2026-09-23`)).json();
    expect(week).toMatchObject({ from: "2026-09-17", to: "2026-09-23", provider: "none", error: null, events: [] });
    const defaulted = await (await fetch(`${base}/api/calendar`)).json();
    expect(defaulted).toMatchObject({ from: THU, to: "2026-09-23" });
    expect((await fetch(`${base}/api/calendar?from=2026-09-23&to=2026-09-17`)).status).toBe(422);
  });

  it("remembers the conversation across offline messages and starts over on request", async () => {
    const post = (b: unknown, path = "/api/pill") => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(b) });
    const first = await (await post({ text: "open slate" })).json();
    const second = await (await post({ text: "remind me friday to call the bank" })).json();
    expect(second.conversation).toBe(first.conversation);
    const c = await (await fetch(`${base}/api/conversation`)).json();
    expect(c.id).toBe(first.conversation);
    expect(c.turns.map((t: { role: string; text: string }) => `${t.role}: ${t.text}`)).toEqual([
      "user: open slate",
      "assistant: Opened Slate.",
      "user: remind me friday to call the bank",
      "assistant: Reminder set for 2026-09-18: call the bank",
    ]);
    const fresh = await (await post({}, "/api/conversation/new")).json();
    expect(fresh.id).not.toBe(first.conversation);
    expect(fresh.turns).toEqual([]);
    expect((await (await fetch(`${base}/api/conversation`)).json()).id).toBe(fresh.id);
  });

  it("lists presets and providers, and saves a model choice the next request picks up", async () => {
    const before = await (await fetch(`${base}/api/models`)).json();
    expect(before.default).toBeNull();
    expect(before.providers.map((p: { id: string }) => p.id)).toEqual(["anthropic", "openai", "openrouter", "compatible"]);
    expect(before.presets.map((p: { spec: string }) => p.spec)).toContain("openai:gpt-5.4");

    const post = (b: unknown) => fetch(`${base}/api/models`, { method: "POST", body: JSON.stringify(b) });
    const after = await (await post({ spec: "openrouter:openai/gpt-5.2" })).json();
    expect(after.default).toBe("openrouter:openai/gpt-5.2");
    expect(after.intents.ask.spec).toBe("openrouter:openai/gpt-5.2");
    const perIntent = await (await post({ spec: "anthropic:claude-haiku-4-5", intent: "capture" })).json();
    expect(perIntent.intents.capture.spec).toBe("anthropic:claude-haiku-4-5");
    expect(perIntent.intents.ask.spec).toBe("openrouter:openai/gpt-5.2");

    expect((await post({ spec: "llama3.2" })).status).toBe(400);
    expect((await post({ spec: "openai:gpt-5.4", intent: "dance" })).status).toBe(400);
    const cleared = await (await post({ spec: null })).json();
    expect(cleared.default).toBeNull();
  });
});

describe("ui server (scripted model)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let home: string;
  let base: string;
  let close: () => Promise<void>;
  let queue: ChatResponse[];
  let requests: ChatRequest[];

  const reply = (o: Partial<ChatResponse>): ChatResponse => ({ text: "", toolCalls: [], stop: "end", model: "scripted", ...o });
  const post = (b: unknown, path = "/api/pill") => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(b) });

  beforeEach(async () => {
    queue = [];
    requests = [];
    ({ dir, cleanup } = await makeTmpSelfhub());
    await cp(resolve("examples/selfhub-sample"), dir, { recursive: true });
    process.env.COS_CALENDAR = "none";
    home = await mkdtemp(join(tmpdir(), "cos-home-"));
    process.env.COS_HOME = home;
    const provider: LLMProvider = {
      id: "openai",
      async chat(req, onText) {
        requests.push(structuredClone(req));
        const r = queue.shift();
        if (!r) throw new Error("script exhausted");
        if (onText && r.text) onText(r.text);
        return r;
      },
    };
    const server = createUiServer({
      config: loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent", COS_NAME: "Dimitri" }),
      today: THU,
      allowSpeech: false,
      llm: { provider, spec: { provider: "openai", model: "gpt-test" } },
      openRunner: async () => {},
      slateLoader: async () => ({ boards: [], live: true }),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterEach(async () => {
    await close();
    await cleanup();
    await rm(home, { recursive: true, force: true });
    delete process.env.COS_CALENDAR;
    delete process.env.COS_HOME;
  });

  it("answers follow-ups with the earlier exchanges, including what the rules did", async () => {
    queue.push(reply({ text: "Record the intro video for MLGuerrilla." }));
    const first = await (await post({ text: "what should I do today?" })).json();
    expect(first).toMatchObject({ kind: "answer", text: "Record the intro video for MLGuerrilla.", model: "openai:gpt-test", user: "what should I do today?" });

    await post({ text: "open slate" }); // no model needed, but still part of the conversation

    queue.push(reply({ text: "Tomorrow is clear." }));
    const second = await (await post({ text: "and tomorrow?" })).json();
    expect(second.conversation).toBe(first.conversation);
    expect(requests.at(-1)!.messages).toEqual([
      { role: "user", content: "what should I do today?" },
      { role: "assistant", text: "Record the intro video for MLGuerrilla.", toolCalls: [] },
      { role: "user", content: "open slate" },
      { role: "assistant", text: "Opened Slate.", toolCalls: [] },
      { role: "user", content: "and tomorrow?" },
    ]);
    // "starting …" used to be filed blindly; with a model, it's part of the same conversation and can be a reply.
    queue.push(reply({ text: "Starting with the landing page, then." }));
    await post({ text: "start with the landing page" });
    expect(requests.at(-1)!.instructions).toContain("Short follow-ups continue the last exchange");
    expect(requests.at(-1)!.tools.map((t) => t.name)).toContain("open");

    await post({}, "/api/conversation/new");
    queue.push(reply({ text: "Hi." }));
    await post({ text: "hello" });
    expect(requests.at(-1)!.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("streams what it is doing, then the reply, and records tool steps for the next message", async () => {
    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "c1", name: "get_calendar", input: { from: "2026-09-18" } }] }),
      reply({ text: "Nothing on Friday." }),
    );
    const res = await post({ text: "what's on friday?", stream: true });
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(["start", "status", "text", "done"]);
    expect(events[0]).toMatchObject({ user: "what's on friday?" });
    expect(events[1].text).toBe("Checking your calendar…");
    expect(events[3].result).toMatchObject({ kind: "answer", text: "Nothing on Friday.", changes: 0 });

    queue.push(reply({ text: "Also nothing." }));
    await post({ text: "saturday?" });
    const replayed = requests.at(-1)!.messages;
    expect(replayed.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(replayed[2]).toMatchObject({ role: "tool", results: [{ id: "h1_c1", content: expect.stringContaining("Calendar 2026-09-18") }] });
    const visible = await (await fetch(`${base}/api/conversation`)).json();
    expect(visible.turns.every((t: Record<string, unknown>) => !("steps" in t))).toBe(true);
  });

  it("keeps a failed reply in the conversation so 'try again' has something to refer to", async () => {
    const failed = await (await post({ text: "what should I do today?" })).json();
    expect(failed).toMatchObject({ kind: "error", text: "That didn't work: script exhausted" });
    queue.push(reply({ text: "Record the intro video." }));
    await post({ text: "try again" });
    expect(requests.at(-1)!.messages.map((m) => (m.role === "user" ? m.content : m.role === "assistant" ? m.text : m.role))).toEqual([
      "what should I do today?",
      "That didn't work: script exhausted",
      "try again",
    ]);
  });
});
