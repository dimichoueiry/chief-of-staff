import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, LLMProvider } from "../src/brain/llm/types.js";
import type { ImageRequest } from "../src/brain/images.js";
import type { JevRequest, JevResult } from "../src/brain/jev.js";
import { loadConfig } from "../src/config.js";
import { git } from "../src/core/git.js";
import { Ledger } from "../src/core/ledger.js";
import { Notes } from "../src/core/notes.js";
import { Reminders } from "../src/core/reminders.js";
import { decide } from "../src/logic/decide.js";
import { resolveDate, scribe } from "../src/logic/scribe.js";
import { saveAccess } from "../src/actions/access.js";
import { ScreenPermissionError } from "../src/sensors/screen.js";
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
      bookmarks: async () => ({
        bookmarks: [{ name: "Campuswire", url: "https://campuswire.com/c/G53D5855E/feed", folder: "Favorites Bar / UIUC", browser: "Edge", app: "Microsoft Edge", profile: "Profile 2" }],
        blocked: [], browsers: ["Edge"],
      }),
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
    expect(html).toContain('src="/commands.js"');
    expect(await (await fetch(`${base}/commands.js`)).text()).toContain("window.cosCommands");
    expect(html).toContain('src="/voice-status.js"');
    expect(await (await fetch(`${base}/voice-status.js`)).text()).toContain("window.cosVoiceStatus");
    expect(js).toContain("messageHandlers.shell");
    expect((await fetch(`${base}/app.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${base}/../package.json`)).status).not.toBe(200);
  });

  it("gives the pill's live status region and mic button accessible labels", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toMatch(/id="pill-status"[^>]*role="status"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="mic"[^>]*aria-label="Talk"/);
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

  it("opens Slate boards, favorites and web pages instantly from the pill, and asks first only when links are set to ask", async () => {
    const post = (b: unknown, path = "/api/pill") => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(b) });
    const slate = await (await post({ text: "open slate board chief of staff ui" })).json();
    expect(slate).toMatchObject({ kind: "action", text: "Opened Slate board “Chief of Staff — UI/UX”." });
    expect(opened).toEqual([["https://slate-iota-lac.vercel.app/board/a1"]]);

    const page = await (await post({ text: "open http://localhost:3000/modules/m6" })).json();
    expect(page).toMatchObject({ kind: "action", text: "Opened http://localhost:3000/modules/m6." });
    const fav = await (await post({ text: "open campus wire from my UIC folder in my favorites" })).json();
    expect(fav.text).toMatch(/^Opened “Campuswire” from your Edge favorites/);
    expect(opened.at(-1)!.at(-1)).toBe("https://campuswire.com/c/G53D5855E/feed");
    opened.splice(1);

    saveAccess({ links: "ask", screen: "auto", browser: "ask" }); // COS_HOME is a temp folder in these tests
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
    expect(fresh).toMatchObject({ title: null, others: 1 });
    expect((await (await fetch(`${base}/api/conversation`)).json()).id).toBe(fresh.id);

    // Different chats for different things: list them, go back to one, and it carries on there.
    const dean = await (await post({ text: "remind me monday to email the dean" })).json();
    expect(dean.conversation).toBe(fresh.id);
    const listed = await (await fetch(`${base}/api/conversations`)).json();
    expect(listed.chats.map((c: { title: string; messages: number; current: boolean }) => [c.title, c.messages, c.current])).toEqual([
      ["remind me monday to email the dean", 1, true],
      ["open slate", 2, false],
    ]);
    expect(listed.chats[1].preview).toBe("Reminder set for 2026-09-18: call the bank");

    const back = await (await post({ id: first.conversation }, "/api/conversation/open")).json();
    expect(back).toMatchObject({ id: first.conversation, title: "open slate", others: 1 });
    expect(back.turns).toHaveLength(4);
    const more = await (await post({ text: "open slate" })).json();
    expect(more.conversation).toBe(first.conversation);

    const renamed = await (await post({ id: first.conversation, title: "Errands" }, "/api/conversation/rename")).json();
    expect(renamed).toEqual({ id: first.conversation, title: "Errands", named: true });
    const byWords = await (await post({ query: "the dean one" }, "/api/conversation/open")).json();
    expect(byWords.id).toBe(fresh.id);
    expect((await (await fetch(`${base}/api/conversation`)).json()).id).toBe(fresh.id);
    const byName = await (await post({ query: "errands" }, "/api/conversation/open")).json();
    expect(byName).toMatchObject({ id: first.conversation, title: "Errands" });

    const none = await post({ query: "kubernetes" }, "/api/conversation/open");
    expect(none.status).toBe(404);
    expect((await none.json()).error).toBe('No chat matches "kubernetes".');
    expect((await post({ id: "../../secrets" }, "/api/conversation/open")).status).toBe(404);
    expect((await post({ id: "nope", title: "x" }, "/api/conversation/rename")).status).toBe(404);

    // Deleting a chat you're not in leaves you where you are; it's gone from the list and from asking by voice.
    const gone = await (await post({ id: fresh.id }, "/api/conversation/delete")).json();
    expect(gone).toMatchObject({ ok: true, deleted: fresh.id, current: { id: first.conversation, title: "Errands" } });
    const afterOne = await (await fetch(`${base}/api/conversations`)).json();
    expect(afterOne.chats.map((c: { title: string }) => c.title)).toEqual(["Errands"]);
    expect((await post({ query: "the dean one" }, "/api/conversation/open")).status).toBe(404);

    // Deleting the chat you're in puts a new, empty one in its place.
    const inPlace = await (await post({ id: first.conversation }, "/api/conversation/delete")).json();
    expect(inPlace.current.id).not.toBe(first.conversation);
    expect(inPlace.current).toMatchObject({ title: null, turns: [], others: 0 });
    expect((await (await fetch(`${base}/api/conversation`)).json()).id).toBe(inPlace.current.id);
    expect((await (await fetch(`${base}/api/conversations`)).json()).chats).toEqual([]);

    const twice = await post({ id: first.conversation }, "/api/conversation/delete");
    expect([twice.status, (await twice.json()).error]).toEqual([404, "That chat isn't saved anymore."]);
    expect((await post({ id: "../../secrets" }, "/api/conversation/delete")).status).toBe(404);
    expect((await post({}, "/api/conversation/delete")).status).toBe(404);
  });

  it("steps out for an aside and back on topic: the main chat waits untouched and the aside is thrown away", async () => {
    const post = (b: unknown, path = "/api/pill") => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(b) });
    const current = async () => (await fetch(`${base}/api/conversation`)).json();
    const main = await (await post({ text: "remind me friday to call the bank" })).json();
    expect((await current()).aside).toBe(false);

    const aside = await (await post({}, "/api/conversation/aside")).json();
    expect(aside).toMatchObject({ title: "Aside", turns: [], aside: true, others: 1 });
    expect(aside.id).not.toBe(main.conversation);
    expect((await current()).id).toBe(aside.id);
    // Said in the aside, answered in the aside.
    const quick = await (await post({ text: "open slate" })).json();
    expect(quick).toMatchObject({ conversation: aside.id, title: "Aside" });
    expect((await current()).turns.map((t: { text: string }) => t.text)).toEqual(["open slate", "Opened Slate."]);
    // Not a chat: never listed, and the main one is as it was.
    const listed = await (await fetch(`${base}/api/conversations`)).json();
    expect(listed.chats.map((c: { title: string; current: boolean }) => [c.title, c.current])).toEqual([["remind me friday to call the bank", false]]);
    expect(await (await post({}, "/api/conversation/aside")).json()).toMatchObject({ id: aside.id }); // already in one: it carries on

    const back = await (await post({}, "/api/conversation/resume")).json();
    expect(back).toMatchObject({ id: main.conversation, title: "remind me friday to call the bank", aside: false, others: 0 });
    expect(back.turns.map((t: { text: string }) => t.text)).toEqual(["remind me friday to call the bank", "Reminder set for 2026-09-18: call the bank"]);
    expect((await current()).id).toBe(main.conversation);
    const more = await (await post({ text: "remind me monday to email the dean" })).json();
    expect(more.conversation).toBe(main.conversation);
    expect((await current()).turns).toHaveLength(4);

    const again = await post({}, "/api/conversation/resume");
    expect([again.status, (await again.json()).error]).toEqual([409, "You're already on topic."]);

    // A new chat asked for from inside an aside throws the aside away too.
    const second = await (await post({}, "/api/conversation/aside")).json();
    const fresh = await (await post({}, "/api/conversation/new")).json();
    expect(fresh.id).not.toBe(second.id);
    expect(fresh).toMatchObject({ aside: false, turns: [] });
    expect((await post({}, "/api/conversation/resume")).status).toBe(409);

    const voice = await (await fetch(`${base}/api/voice`)).json();
    expect(voice).toEqual({ wakeName: "Darius", wake: true });
  });

  it("passes the pill's cue requests to the voice and reports which cues played", async () => {
    const heard: unknown[] = [];
    const server = createUiServer({
      config: loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent" }), today: THU, offline: true,
      speaker: async (text, o) => {
        heard.push([text, o.cues]);
        const cued = (["start", "turn"] as const).filter((c) => o.cues?.[c]);
        return { engine: "say", pieces: 1, stopped: false, cued };
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const speakIt = async (b: unknown) => (await fetch(`${url}/api/speak`, { method: "POST", body: JSON.stringify(b) })).json();
    try {
      expect(await speakIt({ text: "**Done.** Next?", cues: { start: true, turn: true } })).toMatchObject({ ok: true, stopped: false, cued: ["start", "turn"] });
      expect(await speakIt({ text: "Read aloud." })).toMatchObject({ cued: [] });
      expect(await speakIt({ text: "Odd.", cues: { start: "yes", turn: 1 } })).toMatchObject({ cued: [] });
      expect(heard).toEqual([
        ["Done. Next?", { start: true, turn: true }],
        ["Read aloud.", { start: false, turn: false }],
        ["Odd.", { start: false, turn: false }],
      ]);
    } finally {
      server.close();
    }
  });

  it("lets the menubar use any model: tries it first, keeps it in the list, changes nothing when it fails", async () => {
    const tried: string[] = [];
    const server = createUiServer({
      config: loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent" }), today: THU, offline: true, allowSpeech: false,
      modelTester: async (spec) => {
        tried.push(`${spec.provider}:${spec.model}`);
        if (spec.model.includes("nope")) throw new Error("404 No endpoints found for openai/gpt-nope");
        return { ms: 1671, servedBy: "openai/gpt-5.6-luna" };
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, b: unknown) => fetch(`${url}${path}`, { method: "POST", body: JSON.stringify(b) });
    try {
      const menu = await (await fetch(`${url}/api/models`)).json();
      expect(menu.actions.map((a: { kind: string; title: string }) => `${a.kind}: ${a.title}`)).toEqual([
        "input: Use any model…",
        "open: Browse OpenRouter models…",
        "input: Images: openrouter:google/gemini-3.1-flash-image…",
      ]);
      expect(menu.actions[0]).toMatchObject({ path: "api/models/use", button: "Try and use" });
      expect(menu.actions[2]).toMatchObject({ path: "api/models/image", button: "Use it" });

      const used = await (await post("/api/models/use", { value: "~openai/gpt-luna-latest" })).json();
      expect(used).toMatchObject({ ok: true, message: "Now using openrouter:~openai/gpt-luna-latest", detail: "It answered in 1.7 s (served by openai/gpt-5.6-luna)." });
      expect(used.default).toBe("openrouter:~openai/gpt-luna-latest");
      expect(used.presets[0]).toMatchObject({ spec: "openrouter:~openai/gpt-luna-latest", custom: true });
      expect(used.actions.at(-1)).toMatchObject({ kind: "post", title: "Remove openrouter:~openai/gpt-luna-latest from this list", path: "api/models/forget" });

      const broken = await post("/api/models/use", { value: "openrouter:openai/gpt-nope" });
      expect(broken.status).toBe(422);
      expect((await broken.json()).error).toBe("openrouter:openai/gpt-nope didn't work, so nothing changed: 404 No endpoints found for openai/gpt-nope");
      expect((await (await fetch(`${url}/api/models`)).json()).default).toBe("openrouter:~openai/gpt-luna-latest");

      expect((await post("/api/models/use", { value: "llama3.2" })).status).toBe(400);
      expect((await post("/api/models/use", { value: "  " })).status).toBe(400);
      expect(tried).toEqual(["openrouter:~openai/gpt-luna-latest", "openrouter:openai/gpt-nope"]);

      const forgotten = await (await post("/api/models/forget", { spec: "openrouter:~openai/gpt-luna-latest" })).json();
      expect(forgotten.presets.some((p: { spec: string }) => p.spec === "openrouter:~openai/gpt-luna-latest")).toBe(false);
      expect(forgotten.default).toBe("openrouter:~openai/gpt-luna-latest"); // still in use, just off the list
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
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
  let ran: string[];
  let screenAllowed: boolean;
  let requested: number;
  let opened: string[][];
  let jevAsked: JevRequest[];
  /** What the assistant was asked to draw, and what it got back. */
  let drawn: ImageRequest[];
  /** A real OpenRouter key in the shell must survive these tests. */
  const savedKey = process.env.OPENROUTER_API_KEY;
  /** What Jev answers; by default it's sure nothing should be opened, so everything goes on to the model. */
  let jevAnswer: (req: JevRequest) => JevResult;

  const reply = (o: Partial<ChatResponse>): ChatResponse => ({ text: "", toolCalls: [], stop: "end", model: "scripted", ...o });
  /** Jev, sure that `said` only asks to open the target whose description matches. */
  const jevOpens = (match: RegExp) => (req: JevRequest): JevResult => {
    const criteria = (req.questions.target as { criteria: Record<string, string> }).criteria;
    const hit = Object.keys(criteria).find((k) => match.test(criteria[k]))!;
    return {
      model: "jev-test",
      answers: {
        wants: { type: "choice", choice: "open", confidence: 0.98, probabilities: { open: 0.98, other: 0.02 } },
        target: { type: "choice", choice: hit, confidence: 0.96, probabilities: { [hit]: 0.96, none: 0.04 } },
        more: { type: "noul", noul: 0.01 },
      },
    };
  };
  const jevOther = (): JevResult => ({
    model: "jev-test",
    answers: {
      wants: { type: "choice", choice: "other", confidence: 0.99, probabilities: { open: 0.01, other: 0.99 } },
      target: { type: "choice", choice: "none", confidence: 0.99, probabilities: { none: 0.99 } },
      more: { type: "noul", noul: 0.01 },
    },
  });
  const post = (b: unknown, path = "/api/pill") => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(b) });
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

  beforeEach(async () => {
    queue = [];
    requests = [];
    ran = [];
    screenAllowed = true;
    requested = 0;
    opened = [];
    jevAsked = [];
    jevAnswer = jevOther;
    drawn = [];
    ({ dir, cleanup } = await makeTmpSelfhub());
    await cp(resolve("examples/selfhub-sample"), dir, { recursive: true });
    process.env.COS_CALENDAR = "none";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
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
      jev: async (req) => {
        jevAsked.push(req);
        return jevAnswer(req);
      },
      backgroundSummaries: false,
      images: async (r) => {
        drawn.push(r);
        return { data: PNG, mediaType: "image/png" };
      },
      imageModelList: async () => [{ id: "google/gemini-3.1-flash-image", name: "Nano Banana 2" }, { id: "google/gemini-3-pro-image", name: "Nano Banana Pro" }],
      openRunner: async (args) => {
        opened.push(args);
      },
      slateLoader: async () => ({ boards: [], live: true }),
      access: () => ({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser: "ask" }),
      screen: {
        capture: async () => {
          if (!screenAllowed) throw new ScreenPermissionError();
          return { data: "U0NSRUVO", mediaType: "image/jpeg", width: 1600, height: 1039, app: "Microsoft Edge", window: "Campuswire" };
        },
        permission: async () => screenAllowed,
        request: async () => {
          requested++;
          return false;
        },
      },
      shell: async (command) => {
        ran.push(command);
        return { exitCode: 0, timedOut: false, output: command.startsWith("brew") ? "ffmpeg 7.1 installed" : "ok" };
      },
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
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  });

  it("Live opens once per phrase, stays out of the main model, and stops immediately", async () => {
    jevAnswer = jevOpens(/^Slate/);
    const { session } = await (await post({}, "/api/live/start")).json();
    const command = { session, sequence: 1, text: "get my canvas up" };
    const first = await (await post(command, "/api/live/command")).json();
    const again = await (await post(command, "/api/live/command")).json();
    expect(first).toMatchObject({ kind: "action", text: "Opened Slate.", model: "jev-test" });
    expect(again).toEqual(first);
    expect(opened).toHaveLength(1);
    expect(requests).toHaveLength(0);
    await post({ session }, "/api/live/stop");
    expect(await (await post({ ...command, sequence: 2 }, "/api/live/command")).json()).toMatchObject({ kind: "skip" });
    expect(opened).toHaveLength(1);
    const conversation = await (await fetch(`${base}/api/conversation`)).json();
    expect(conversation.turns.map((t: { text: string }) => t.text)).toEqual(["get my canvas up", "Opened Slate."]);
  });

  it("Live does not send ambiguous speech or questions to the main model", async () => {
    const { session } = await (await post({}, "/api/live/start")).json();
    expect(await (await post({ session, sequence: 1, text: "what should I do?" }, "/api/live/command")).json()).toMatchObject({ kind: "skip" });
    expect(opened).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("opens what Jev picks without asking the model, and says Jev did it", async () => {
    jevAnswer = jevOpens(/^Slate/);
    const r = await (await post({ text: "Darius, can you get my canvas up", command: "can you get my canvas up" })).json();
    expect(r).toMatchObject({ kind: "action", text: "Opened Slate.", model: "jev-test", user: "Darius, can you get my canvas up" });
    expect(opened).toEqual([["https://slate-iota-lac.vercel.app/app"]]);
    expect(requests).toHaveLength(0);
    expect(jevAsked[0].state).toEqual({ said: "can you get my canvas up" });
  });

  it("sends questions straight to the model, which answers as before", async () => {
    queue.push(reply({ text: "Record the intro video." }));
    const r = await (await post({ text: "what should I do today?" })).json();
    expect(r).toMatchObject({ kind: "answer", text: "Record the intro video.", model: "openai:gpt-test" });
    expect(jevAsked).toHaveLength(0);
    expect(opened).toEqual([]);
  });

  it("keeps natural open requests on Jev's fast lane", async () => {
    jevAnswer = jevOpens(/^Slate/);
    const r = await (await post({ text: "can you get my canvas up" })).json();
    expect(r).toMatchObject({ kind: "action", text: "Opened Slate.", model: "jev-test" });
    expect(jevAsked).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });

  it("falls back to the model when Jev fails", async () => {
    jevAnswer = () => {
      throw new Error("Jev answered 401: invalid api key");
    };
    queue.push(reply({ text: "Opening it." }));
    const r = await (await post({ text: "get my canvas up" })).json();
    expect(r).toMatchObject({ kind: "answer", model: "openai:gpt-test" });
    expect(requests).toHaveLength(1);
  });

  it("reads what follows the name, so 'Darius, open slate' opens by the rules without Jev or the model", async () => {
    const r = await (await post({ text: "Darius, open slate", command: "open slate" })).json();
    expect(r).toMatchObject({ kind: "action", text: "Opened Slate.", model: "rules" });
    expect(jevAsked).toHaveLength(0);
    expect(requests).toHaveLength(0);
    // Kept as said: the name only comes off for the rules and Jev.
    expect((await (await fetch(`${base}/api/conversation`)).json()).turns.map((t: { text: string }) => t.text)).toEqual(["Darius, open slate", "Opened Slate."]);
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

  it("puts earlier conversations in memory and lets the model search them", async () => {
    queue.push(reply({ text: "Go with the pro tier at $29." }));
    await post({ text: "which pricing tier should fampy launch with?" });
    await post({}, "/api/conversation/new");

    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "s1", name: "get_conversations", input: { query: "pricing tier" } }] }),
      reply({ text: "The pro tier, at $29." }),
    );
    const r = await (await post({ text: "what did we decide about pricing?" })).json();
    expect(r.text).toBe("The pro tier, at $29.");
    const [first, second] = requests.slice(-2);
    expect(first.messages).toEqual([{ role: "user", content: "what did we decide about pricing?" }]);
    expect(first.context).toMatch(/# Earlier conversations \(last 7 days, newest first\)\n.*\n- \d{4}-\d{2}-\d{2} \w{3} \d{2}:\d{2}–\d{2}:\d{2}: They said "which pricing tier should fampy launch with\?"\. Last reply: Go with the pro tier at \$29\./);
    const found = second.messages.at(-1);
    expect(found?.role === "tool" && found.results[0].content).toMatch(/^1 exchange matching "pricing tier" in 1 conversation \(searched 1 saved conversation\)\.\n\n.*\nThey said: which pricing tier should fampy launch with\?\nYou replied: Go with the pro tier at \$29\./);
    expect(r.changes).toBe(0); // the conversation being answered is saved after its reply, so it is not searched yet
  });

  it("leaves searches that could mean memory to the model, and keeps web searches and plain opens instant", async () => {
    queue.push(reply({ text: "You picked Tauri." }), reply({ text: "Here's the board." }), reply({ text: "Searching." }));
    for (const text of ["search our past conversations for the framework", "open the board we talked about yesterday", "look up the pricing decision"]) {
      expect((await (await post({ text })).json()).model).toBe("openai:gpt-test");
    }
    expect(requests).toHaveLength(3);
    for (const text of ["google tauri menubar", "search the web for tauri", "look up tauri pricing online", "open slate"]) {
      expect((await (await post({ text })).json())).toMatchObject({ kind: "action", model: "rules" });
    }
    expect(requests).toHaveLength(3);
  });

  it("runs a waiting command when they say yes (or tap Run), drops it on no, and answers with the result", async () => {
    const say = async (text: string) => (await post({ text })).json();

    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "r1", name: "run_command", input: { command: "brew install ffmpeg" } }] }),
      reply({ text: "I'll install ffmpeg with Homebrew. Say yes to run it." }),
    );
    const asked = await say("install ffmpeg");
    expect(asked.confirm).toEqual([expect.objectContaining({ kind: "command", verb: "Run", detail: "$ brew install ffmpeg\nin ~" })]);
    expect(ran).toEqual([]);

    queue.push(reply({ text: "Installed ffmpeg 7.1." }));
    const done = await say("yes");
    expect(ran).toEqual(["brew install ffmpeg"]);
    expect(done.text).toBe("Installed ffmpeg 7.1.");
    const told = requests.at(-1)!.messages.at(-1);
    expect(told?.role === "user" && told.content).toMatch(/^\(Since your last reply: They said yes and it is already done \(do not do it again\): brew install ffmpeg\. Result: \$ brew install ffmpeg\n\(in ~; exit 0; [\d.]+s\)\nffmpeg 7\.1 installed\)\n\nyes$/);

    // A second yes has nothing waiting: it is just a message.
    queue.push(reply({ text: "Nothing else is waiting." }));
    await say("yes");
    expect(ran).toHaveLength(1);

    // No drops it.
    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "r2", name: "run_command", input: { command: "mkdir -p ~/cos-tools" } }] }),
      reply({ text: "Want me to create ~/cos-tools?" }),
    );
    await say("make a tools folder");
    queue.push(reply({ text: "OK, left it." }));
    await say("no");
    expect(ran).toHaveLength(1);
    expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toContain("They said no, so this was not done: mkdir -p ~/cos-tools.");

    // The button does the same, and the next message knows.
    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "r3", name: "run_command", input: { command: "npm run build", cwd: "~" } }] }),
      reply({ text: "Build it?" }),
    );
    const build = await say("build it");
    const ok = await (await post({ id: build.confirm[0].id }, "/api/actions/confirm")).json();
    expect(ok.text).toMatch(/^\$ npm run build\n/);
    expect(ran.at(-1)).toBe("npm run build");
    queue.push(reply({ text: "Built." }));
    await say("how did that go?");
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain("They tapped Run and it is already done (do not do it again): npm run build. Result:");
  });

  it("hears a natural yes by voice, hands anything unclear to the model's confirm_pending, and never queues a repeat", async () => {
    const say = async (text: string) => (await post({ text })).json();

    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "a1", name: "run_command", input: { command: "brew install ffmpeg" } }] }),
      reply({ text: "Should I install ffmpeg with Homebrew?" }),
    );
    await say("install ffmpeg");
    queue.push(reply({ text: "Installed." }));
    await say("Yeah, you can run that");
    expect(ran).toEqual(["brew install ffmpeg"]);
    const told = requests.at(-1)!;
    expect(told.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringMatching(/^\(Since your last reply: They said yes and it is already done/) });

    // The model tries to queue the exact same command again right after: refused as already done.
    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "a2", name: "run_command", input: { command: "brew install ffmpeg" } }] }),
      reply({ text: "It's already installed." }),
    );
    const again = await say("install ffmpeg");
    expect(again.confirm).toEqual([]);
    expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toContain("already done a moment ago");

    // Unclear answers go to the model, which confirms first.
    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "a3", name: "run_command", input: { command: "npm run build" } }] }),
      reply({ text: "Should I build it?" }),
    );
    await say("build it");
    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "a4", name: "confirm_pending", input: { decision: "yes" } }] }),
      reply({ text: "Built, and I'll check the output next time." }),
    );
    await say("yes and then tell me if it worked");
    expect(ran).toEqual(["brew install ffmpeg", "npm run build"]);
    const convo = await (await fetch(`${base}/api/conversation`)).json();
    expect(convo.turns.at(-1)).toMatchObject({ role: "assistant", actionsDone: [{ kind: "command", detail: "$ npm run build\nin ~" }] });
  });

  it("looks at the screen when asked, by voice, and explains the permission when macOS says no", async () => {
    const say = async (text: string) => (await post({ text })).json();
    queue.push(reply({ text: "That's the Campuswire feed in Edge; the pinned post is the homework 3 deadline." }));
    const seen = await say("what am I looking at?");
    expect(seen).toMatchObject({ kind: "answer", screen: { app: "Microsoft Edge", window: "Campuswire" } });
    const sent = requests.at(-1)!.messages.at(-1)!;
    expect(sent).toMatchObject({ role: "user", images: [{ mediaType: "image/jpeg", data: "U0NSRUVO" }] });
    expect(sent.role === "user" && sent.content).toMatch(/^\(A screenshot of their screen, taken just now \(1600×1039\); in front: Microsoft Edge \(“Campuswire”\)/);
    const convo = await (await fetch(`${base}/api/conversation`)).json();
    expect(convo.turns.at(-2)).toMatchObject({ role: "user", text: "what am I looking at?", screen: { app: "Microsoft Edge" } });
    expect(JSON.stringify(convo)).not.toContain("U0NSRUVO"); // the image is never kept

    // A follow-up doesn't re-send an old image: history carries only words.
    queue.push(reply({ text: "Homework 3 is due Friday." }));
    await say("when is it due?");
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain("U0NSRUVO");

    screenAllowed = false;
    const before = requests.length;
    const blocked = await say("look at this");
    expect(blocked.text).toMatch(/^I can't see your screen yet\. Turn on Chief of Staff in System Settings › Privacy & Security › Screen & System Audio Recording/);
    expect(requested).toBe(1);
    expect(requests.length).toBe(before); // no model call without the screenshot
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

  it("draws a picture, shows it with the reply, keeps it with the chat, and changes the one they're looking at", async () => {
    const say = async (text: string) => (await post({ text })).json();
    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "i1", name: "make_image", input: { prompt: "a lemon on linen", title: "launch post", aspect_ratio: "4:5" } }] }),
      reply({ text: "Here it is. Want the words bigger?" }),
    );
    const made = await say("make me an instagram post for the launch");
    expect(drawn).toEqual([{ prompt: "a lemon on linen", model: "google/gemini-3.1-flash-image", aspectRatio: "4:5" }]);
    expect(made.artifacts).toEqual([{ id: expect.stringMatching(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/), kind: "image", title: "launch post" }]);
    const id = made.artifacts[0].id;

    const file = await fetch(`${base}/artifacts/${id}`);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
    expect(await (await fetch(`${base}/api/artifacts?id=${id}`)).json()).toMatchObject({
      title: "launch post", prompt: "a lemon on linen", model: "openrouter:google/gemini-3.1-flash-image", kind: "image",
    });

    // It stays with the conversation, so reopening the chat shows it again.
    const convo = await (await fetch(`${base}/api/conversation`)).json();
    expect(convo.turns.at(-1).artifacts).toEqual(made.artifacts);

    // A change is drawn from the picture they are looking at, not from nothing.
    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "i2", name: "make_image", input: { prompt: "the same, with bigger words", from: id } }] }),
      reply({ text: "Bigger now." }),
    );
    const changed = await say("make the words bigger");
    expect(drawn[1].references).toEqual([{ data: PNG.toString("base64"), mediaType: "image/png" }]);
    expect(await (await fetch(`${base}/api/artifacts?id=${changed.artifacts[0].id}`)).json()).toMatchObject({ from: id });

    // An id that isn't a picture here draws nothing at all.
    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "i3", name: "make_image", input: { prompt: "x", from: "../../etc/passwd" } }] }),
      reply({ text: "I can't find that one." }),
    );
    expect((await say("change that other one")).artifacts).toBeUndefined();
    expect(drawn).toHaveLength(2);
  });

  it("writes a page, serves it with an origin of its own, and links it from the reply", async () => {
    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "p1", name: "make_page", input: { title: "LinkedIn post", html: "<!doctype html><h1>Launch week</h1>" } }] }),
      reply({ text: "Have a look." }),
    );
    const r = await (await post({ text: "show me what the post would look like" })).json();
    expect(r.artifacts).toEqual([{ id: expect.any(String), kind: "page", title: "LinkedIn post" }]);
    const page = await fetch(`${base}/artifacts/${r.artifacts[0].id}`);
    expect(page.headers.get("content-type")).toBe("text/html");
    // Sandboxed, so a page written from something read on the web can't turn around and call this API.
    expect(page.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-popups");
    expect(await page.text()).toContain("<h1>Launch week</h1>");
    expect((await fetch(`${base}/artifacts/nope`)).status).toBe(404);
  });

  it("keeps their own instructions and gives them to the model until they delete them", async () => {
    const say = async (text: string) => (await post({ text })).json();
    expect(await (await fetch(`${base}/api/instructions`)).json()).toMatchObject({ text: "", max: 8000 });

    expect(await (await post({ text: "Call me Dimitri. Three sentences, never more." }, "/api/instructions")).json()).toMatchObject({ ok: true });
    queue.push(reply({ text: "Noted." }));
    await say("hello");
    expect(requests.at(-1)!.instructions).toContain("Call me Dimitri.");
    expect(requests.at(-1)!.instructions).toContain("# From them");

    await post({ text: "   " }, "/api/instructions");
    queue.push(reply({ text: "Noted." }));
    await say("hello again");
    expect(requests.at(-1)!.instructions).not.toContain("Call me Dimitri.");
    expect((await post({ text: "x".repeat(9000) }, "/api/instructions")).status).toBe(400);
  });

  it("takes an image model OpenRouter has, and refuses one it doesn't", async () => {
    expect((await (await fetch(`${base}/api/models`)).json()).images).toMatchObject({ spec: "openrouter:google/gemini-3.1-flash-image", source: "auto", ready: true });

    const chosen = await (await post({ value: "google/gemini-3-pro-image" }, "/api/models/image")).json();
    expect(chosen.images).toMatchObject({ spec: "openrouter:google/gemini-3-pro-image", source: "settings (images)" });
    expect((await post({ value: "google/no-such-model" }, "/api/models/image")).status).toBe(422);
    expect((await post({ value: "anthropic:claude-opus-5" }, "/api/models/image")).status).toBe(400);
    expect((await (await fetch(`${base}/api/models`)).json()).images.spec).toBe("openrouter:google/gemini-3-pro-image");

    queue.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "i4", name: "make_image", input: { prompt: "a lemon" } }] }),
      reply({ text: "Done." }),
    );
    await post({ text: "draw a lemon" });
    expect(drawn.at(-1)!.model).toBe("google/gemini-3-pro-image");

    expect((await (await post({ spec: null }, "/api/models/image")).json()).images.spec).toBe("openrouter:google/gemini-3.1-flash-image");
    expect((await (await fetch(`${base}/api/images/models`)).json()).models).toHaveLength(2);
  });
});
