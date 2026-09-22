import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, LLMProvider } from "../src/brain/llm/types.js";
import { Conversations, eventsSinceReply, historyMessages, messageCount, displayTitle } from "../src/brain/conversation.js";
import { loadConfig } from "../src/config.js";
import { Reminders, parseReminders, serializeReminders } from "../src/core/reminders.js";
import type { Project } from "../src/core/ledger.js";
import {
  Heartbeat, MAX_PER_DAY, fingerprint, gatherSignals, isQuiet, mayWrite, parseDecision, readState, saveState,
  type HeartbeatDeps, type HeartbeatState, type Offer,
} from "../src/logic/heartbeat.js";
import { createUiServer } from "../src/ui/server.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

const at = (s: string) => new Date(s);

describe("reminders with a time", () => {
  it("reads, writes and sorts a time when there is one, and leaves dated ones alone", () => {
    const md = "# Reminders\n\n- [ ] 2026-09-23 09:00 · Module 2 post goes out\n- [ ] 2026-09-23 · renew the domain\n- [x] 2026-09-12 · done thing\n";
    const r = parseReminders(md);
    expect(r).toEqual([
      { date: "2026-09-23", time: "09:00", text: "Module 2 post goes out", done: false },
      { date: "2026-09-23", text: "renew the domain", done: false },
      { date: "2026-09-12", text: "done thing", done: true },
    ]);
    expect(serializeReminders(r)).toBe(md);
  });

  it("keeps the time the tool gives, cleaned, and drops one that isn't a time", async () => {
    const { dir, cleanup } = await makeTmpSelfhub();
    try {
      const rem = new Reminders(dir);
      await rem.add("2026-09-23", "post Module 2", "9:05");
      await rem.add("2026-09-23", "a later thing", "25:00");
      await rem.add("2026-09-22", "earlier");
      expect(await rem.list()).toEqual([
        { date: "2026-09-22", text: "earlier", done: false },
        { date: "2026-09-23", text: "a later thing", done: false },
        { date: "2026-09-23", time: "09:05", text: "post Module 2", done: false },
      ]);
    } finally {
      await cleanup();
    }
  });
});

describe("what the heartbeat looks at", () => {
  const now = at("2026-09-22T15:00:00");
  const project = (o: Partial<Project>): Project => ({ name: "x", status: "active", ...o }) as Project;

  it("takes the next two days of reminders, events and cadence days, and nothing further out", () => {
    const s = gatherSignals({
      now,
      reminders: [
        { date: "2026-09-23", time: "09:00", text: "Module 2 posts go out", done: false },
        { date: "2026-09-21", text: "yesterday's, still open", done: false },
        { date: "2026-09-10", text: "long overdue", done: false },
        { date: "2026-09-30", text: "next week", done: false },
        { date: "2026-09-23", text: "finished", done: true },
      ],
      events: [
        { title: "Call with Sam", start: "2026-09-23T14:00:00", end: "2026-09-23T15:00:00", allDay: false },
        { title: "Ended already", start: "2026-09-22T09:00:00", end: "2026-09-22T10:00:00", allDay: false },
        { title: "Far off", start: "2026-10-02T09:00:00", end: "2026-10-02T10:00:00", allDay: false },
      ],
      projects: [project({ name: "MLGuerrilla", cadence: "wednesday", next: "record the intro" }), project({ name: "Parked", status: "parked", cadence: "daily" })],
    });
    expect(s).toEqual([
      { kind: "reminder", when: "2026-09-21", text: "yesterday's, still open" },
      // A whole day's thing comes before that day's times.
      { kind: "cadence", when: "2026-09-23 (Wednesday)", text: "MLGuerrilla: its day; next action: record the intro" },
      { kind: "reminder", when: "2026-09-23 09:00", text: "Module 2 posts go out" },
      { kind: "event", when: "2026-09-23 14:00", text: "Call with Sam" },
    ]);
  });

  it("keeps quiet hours, overnight or not, and can be told there are none", () => {
    expect(isQuiet(at("2026-09-22T23:00:00"), "22-8")).toBe(true);
    expect(isQuiet(at("2026-09-22T07:59:00"), "22-8")).toBe(true);
    expect(isQuiet(at("2026-09-22T08:00:00"), "22-8")).toBe(false);
    expect(isQuiet(at("2026-09-22T13:00:00"), "12-14")).toBe(true);
    expect(isQuiet(at("2026-09-22T03:00:00"), "off")).toBe(false);
  });
});

describe("when it may write", () => {
  const now = at("2026-09-22T15:00:00");
  const offer = (o: Partial<Offer>): Offer => ({
    id: "x", key: "k", title: "t", body: "", work: "w", safe: true, createdAt: "2026-09-22T09:00:00", conversation: "c", status: "declined", ...o,
  });
  const state = (offers: Offer[], mode: HeartbeatState["mode"] = "proactive"): HeartbeatState => ({ mode, offers });

  it("never when off or in quiet hours", () => {
    expect(mayWrite(state([], "off"), now, false)).toEqual({ ok: false, why: "off" });
    expect(mayWrite(state([]), now, true)).toEqual({ ok: false, why: "quiet hours" });
    expect(mayWrite(state([]), now, false)).toEqual({ ok: true });
  });

  it("waits for an answer, spaces its messages, and stops at a few a day", () => {
    expect(mayWrite(state([offer({ status: "open", title: "Want it?" })]), now, false)).toEqual({ ok: false, why: 'waiting on "Want it?"' });
    expect(mayWrite(state([offer({ createdAt: new Date(now.getTime() - 30 * 60_000).toISOString() })]), now, false)).toEqual({ ok: false, why: "wrote recently" });
    const today = Array.from({ length: MAX_PER_DAY }, (_, i) => offer({ createdAt: `2026-09-22T0${i + 1}:00:00` }));
    expect(mayWrite(state(today), now, false)).toMatchObject({ ok: false, why: `already wrote ${MAX_PER_DAY} times today` });
    // An offer left unanswered since yesterday morning no longer holds anything back.
    expect(mayWrite(state([offer({ status: "open", createdAt: "2026-09-21T09:00:00" })]), now, false)).toEqual({ ok: true });
  });
});

describe("the model's answer", () => {
  it("is silence unless it wants to speak and says what and how", () => {
    expect(parseDecision({ speak: false, why: "nothing new" })).toEqual({ speak: false, why: "nothing new" });
    expect(parseDecision({ speak: true, title: "Want it?", work: "" })).toMatchObject({ speak: false });
    expect(parseDecision("garbage")).toMatchObject({ speak: false });
    expect(parseDecision({ speak: true, why: "post tomorrow", key: "Module 2 Post / Wed", title: "Want Wednesday's post tuned?", body: "I can.", work: "Rewrite it.", can_do_now: true })).toEqual({
      speak: true, why: "post tomorrow", offer: { key: "module-2-post-wed", title: "Want Wednesday's post tuned?", body: "I can.", work: "Rewrite it.", safe: true },
    });
  });
});

describe("a heartbeat tick", () => {
  let home: string;
  let file: string;
  let delivered: Array<{ offer: Offer; mode: string }>;
  let told: string[];
  let asked: number;
  let answerWith: unknown;
  let clock: Date;

  const deps = (o: Partial<HeartbeatDeps> = {}): HeartbeatDeps => ({
    now: () => clock,
    ready: () => true,
    decide: async () => {
      asked++;
      return answerWith;
    },
    signals: async () => [{ kind: "reminder", when: "2026-09-23 09:00", text: "Module 2 posts go out" }],
    recall: () => "",
    rules: () => "",
    deliver: async (offer, mode) => {
      delivered.push({ offer, mode });
      return { conversation: "chat-1", ...(mode === "plus" ? { text: "I drafted all three.", artifacts: [{ id: "2026-09-22-aaaaaa", kind: "doc" as const, title: "Captions" }] } : {}) };
    },
    notify: async (n) => {
      told.push(`${n.title} | ${n.body}`);
    },
    file,
    ...o,
  });
  const offerAnswer = { speak: true, why: "post tomorrow at 9", key: "module-2-post", title: "Want Wednesday's Module 2 post tuned for saves?", body: "I can rework the captions.", work: "Rewrite the captions for each platform.", can_do_now: true };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cos-hb-"));
    process.env.COS_HOME = home;
    file = join(home, "heartbeat.json");
    delivered = [];
    told = [];
    asked = 0;
    answerWith = offerAnswer;
    clock = at("2026-09-22T15:00:00");
  });
  afterEach(async () => {
    delete process.env.COS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("offers once, notifies, and never offers the same thing again", async () => {
    const hb = new Heartbeat(deps());
    const r = await hb.tick();
    expect(r).toMatchObject({ outcome: "offered", offer: { title: offerAnswer.title, status: "open", conversation: "chat-1" } });
    expect(delivered.map((d) => d.mode)).toEqual(["proactive"]);
    expect(told).toEqual([`${offerAnswer.title} | I can rework the captions.`]);
    expect(readState(file).offers).toHaveLength(1);
    expect(await readFile(join(home, "heartbeat.md"), "utf8")).toContain(`offered "${offerAnswer.title}"`);

    // Held while it waits for the answer; then declined, a later look finds it already offered.
    expect(await hb.tick()).toMatchObject({ outcome: "held" });
    const st = readState(file);
    st.offers[0].status = "declined";
    saveState(st, file);
    clock = at("2026-09-22T18:00:00");
    expect(await hb.tick()).toMatchObject({ outcome: "nothing", why: "already offered (declined)" });
    expect(delivered).toHaveLength(1);
  });

  it("doesn't ask the model again when nothing it would look at has changed", async () => {
    answerWith = { speak: false, why: "nothing worth it" };
    const hb = new Heartbeat(deps());
    expect(await hb.tick()).toEqual({ outcome: "nothing", why: "nothing worth it" });
    clock = at("2026-09-22T15:30:00");
    expect(await hb.tick()).toEqual({ outcome: "unchanged" });
    expect(asked).toBe(1);
    // Asked by hand, it looks anyway.
    expect(await hb.tick({ force: true })).toMatchObject({ outcome: "nothing" });
    expect(asked).toBe(2);
  });

  it("stays quiet with nothing to look at, and when off, without asking the model", async () => {
    const hb = new Heartbeat(deps({ signals: async () => [] }));
    expect(await hb.tick()).toMatchObject({ outcome: "nothing" });
    saveState({ mode: "off", offers: [] }, file);
    expect(await hb.tick({ force: true })).toEqual({ outcome: "off" });
    expect(asked).toBe(0);
  });

  it("in Proactive+ does what only needs writing, and still asks about the rest", async () => {
    saveState({ mode: "plus", offers: [] }, file);
    const hb = new Heartbeat(deps());
    const r = await hb.tick();
    expect(r).toMatchObject({ outcome: "done", offer: { status: "done", artifacts: [{ kind: "doc" }] } });
    expect(delivered.map((d) => d.mode)).toEqual(["plus"]);
    expect(told[0]).toBe("Done: Wednesday's Module 2 post tuned for saves | I drafted all three.");

    answerWith = { ...offerAnswer, key: "schedule-threads", title: "Should I schedule the Threads post?", can_do_now: false };
    clock = at("2026-09-22T18:00:00");
    expect(await hb.tick()).toMatchObject({ outcome: "offered" });
    expect(delivered.map((d) => d.mode)).toEqual(["plus", "proactive"]);
  });

  it("fingerprints what it was shown, not when", () => {
    expect(fingerprint(["a", [1]])).toBe(fingerprint(["a", [1]]));
    expect(fingerprint(["a", [1]])).not.toBe(fingerprint(["a", [2]]));
  });
});

describe("an offer in the conversation", () => {
  it("is told to the model before their next message, and makes the chat worth listing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cos-conv-"));
    try {
      const store = new Conversations(dir);
      const c = store.current();
      store.append(c, { role: "assistant", kind: "offer", text: "I can rework the captions.", offer: { id: "o1", title: "Want Wednesday's post tuned?", work: "Rewrite them.", mode: "offer" } });
      expect(messageCount(c)).toBe(1);
      expect(displayTitle(c)).toBe("Want Wednesday's post tuned?");
      const ev = eventsSinceReply(c);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toContain('"Want Wednesday\'s post tuned?. I can rework the captions."');
      expect(ev[0]).toContain("If they say yes, this is what you do: Rewrite them.");
      store.append(c, { role: "user", text: "yes" }, { role: "assistant", text: "Done." });
      const h = historyMessages(c);
      expect(h[0]).toMatchObject({ role: "user" });
      expect((h[0] as { content: string }).content).toMatch(/^\(Since your last reply: \(You wrote to them first/);
      expect(h[1]).toMatchObject({ role: "assistant", text: "Done." });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the heartbeat in the app", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let home: string;
  let base: string;
  let close: () => Promise<void>;
  let requests: ChatRequest[];
  let responses: ChatResponse[];
  let notified: string[];

  const reply = (o: Partial<ChatResponse>): ChatResponse => ({ text: "", toolCalls: [], stop: "end", model: "scripted", ...o });
  const post = async (path: string, b: unknown = {}) => (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
  const get = async (path: string) => (await fetch(`${base}${path}`)).json();

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTmpSelfhub());
    await cp(resolve("examples/selfhub-sample"), dir, { recursive: true });
    process.env.COS_CALENDAR = "none";
    home = await mkdtemp(join(tmpdir(), "cos-home-"));
    process.env.COS_HOME = home;
    requests = [];
    responses = [];
    notified = [];
    const provider: LLMProvider = {
      id: "openai",
      async chat(req) {
        requests.push(structuredClone(req));
        const r = responses.shift();
        if (!r) throw new Error("script exhausted");
        return r;
      },
    };
    await new Reminders(dir).add("2026-09-23", "Module 2 posts go out on Instagram, Facebook and Threads", "09:00");
    const server = createUiServer({
      config: loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent", COS_NAME: "Dimitri" }),
      today: "2026-09-22",
      allowSpeech: false,
      backgroundSummaries: false,
      llm: { provider, spec: { provider: "openai", model: "gpt-test" } },
      conversations: new Conversations(join(home, "conversations")),
      heartbeat: { everyMs: 3_600_000, firstAfterMs: 3_600_000, now: () => at("2026-09-22T15:00:00"), notifier: async (t, b) => (notified.push(`${t} | ${b}`), true) },
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

  const decision = JSON.stringify({
    speak: true, why: "the post goes out tomorrow at 9", key: "module-2-post-2026-09-23",
    title: "Want Wednesday's Module 2 post tuned for shares and saves?", body: "I can rework the captions and CTAs for each platform before 9am.",
    work: "Read the Module 2 drafts and rewrite the caption, hook and CTA for Instagram, Facebook and Threads.", can_do_now: true,
  });

  it("writes first, and a Yes does the work and hands back a document", async () => {
    expect(await get("/api/heartbeat")).toMatchObject({ mode: "proactive", offers: [] });
    responses.push(reply({ text: decision }));
    const tick = await post("/api/heartbeat/tick");
    expect(tick).toMatchObject({ outcome: "offered", offer: { key: "module-2-post-2026-09-23" } });
    // It was shown the timed reminder, as something coming up.
    expect((requests[0].messages[0] as { content: string }).content).toContain("2026-09-23 09:00 · reminder · Module 2 posts go out");
    expect(requests[0].tools).toEqual([]);
    // No app asked for notices, so macOS's own notification carries it.
    expect(notified).toEqual(["Want Wednesday's Module 2 post tuned for shares and saves? | I can rework the captions and CTAs for each platform before 9am."]);

    const convo = await get("/api/conversation");
    expect(convo.title).toBe("Want Wednesday's Module 2 post tuned for shares and saves");
    expect(convo.turns).toEqual([expect.objectContaining({ role: "assistant", kind: "offer", offer: expect.objectContaining({ mode: "offer", title: expect.stringContaining("Module 2") }) })]);

    responses.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "t1", name: "make_document", input: { title: "Module 2 captions, ready for approval", markdown: "## Instagram\n\nNew here? …" } }] }),
      reply({ text: "Done. One section per platform." }),
    );
    const said = await post("/api/pill", { text: "Yes, do it.", offer: tick.offer.id });
    expect(said).toMatchObject({ text: "Done. One section per platform.", replyTo: tick.offer.title, artifacts: [{ kind: "doc", title: "Module 2 captions, ready for approval" }] });
    const asked = requests[1].messages.at(-1) as { content: string };
    expect(asked.content).toContain(`They tapped Yes on your offer "${tick.offer.title}"`);
    expect(asked.content).toContain("rewrite the caption, hook and CTA");

    const after = await get("/api/conversation");
    expect(after.turns[0].offer.answered).toBe("yes");
    expect(after.turns[1]).toMatchObject({ role: "user", text: "Yes, do it.", replyTo: tick.offer.title });
    expect((await get("/api/heartbeat")).offers[0].status).toBe("accepted");

    // The document is served as markdown.
    const doc = await fetch(`${base}/artifacts/${said.artifacts[0].id}`);
    expect(doc.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await doc.text()).toContain("## Instagram");
  });

  it("takes Not now, and a typed no, as a no it remembers", async () => {
    responses.push(reply({ text: decision }));
    const tick = await post("/api/heartbeat/tick");
    expect(await post("/api/offers/decline", { id: tick.offer.id })).toMatchObject({ ok: true });
    expect(await post("/api/offers/decline", { id: tick.offer.id })).toMatchObject({ error: "That was already answered." });
    const convo = await get("/api/conversation");
    expect(convo.turns[0].offer.answered).toBe("no");
    expect(convo.turns[1]).toMatchObject({ role: "event", text: expect.stringContaining("Not now") });
    expect((await get("/api/heartbeat")).offers[0].status).toBe("declined");
  });

  it("reads a spoken yes straight after an offer as the yes", async () => {
    responses.push(reply({ text: decision }));
    const tick = await post("/api/heartbeat/tick");
    responses.push(reply({ text: "On it." }));
    const said = await post("/api/pill", { text: "yeah go for it" });
    expect(said.replyTo).toBe(tick.offer.title);
    expect((requests[1].messages.at(-1) as { content: string }).content).toContain("They tapped Yes on your offer");
    expect((await get("/api/heartbeat")).offers[0].status).toBe("accepted");
  });

  it("hands notices to the menubar app, which then shows them itself", async () => {
    expect(await get("/api/notices")).toEqual({ seq: 0, notices: [] });
    responses.push(reply({ text: decision }));
    await get("/api/notices?after=0&shows=1");
    const tick = await post("/api/heartbeat/tick");
    expect(notified).toEqual([]);
    const n = await get("/api/notices?after=0&shows=1");
    expect(n).toMatchObject({ seq: 1, notices: [{ seq: 1, id: tick.offer.id, title: tick.offer.title, conversation: tick.offer.conversation }] });
    expect((await get("/api/notices?after=1")).notices).toEqual([]);
  });

  it("switches mode, and does nothing when off", async () => {
    expect(await post("/api/heartbeat", { mode: "loud" })).toMatchObject({ error: expect.stringContaining("mode must be") });
    expect(await post("/api/heartbeat", { mode: "off" })).toEqual({ mode: "off" });
    expect(await post("/api/heartbeat/tick")).toEqual({ outcome: "off" });
    expect(requests).toHaveLength(0);
  });

  it("in Proactive+ writes the document first, with only the tools that prepare", async () => {
    await post("/api/heartbeat", { mode: "plus" });
    responses.push(
      reply({ text: decision }),
      reply({ stop: "tool_use", toolCalls: [{ id: "t1", name: "make_document", input: { title: "Module 2 captions", markdown: "## Instagram\n\nNew here?" } }] }),
      reply({ text: "I drafted the Module 2 captions for all three platforms. The Instagram one swaps the CTA; your call." }),
    );
    const tick = await post("/api/heartbeat/tick");
    expect(tick).toMatchObject({ outcome: "done", offer: { status: "done" } });
    expect(requests[1].tools.map((t) => t.name).sort()).toEqual(["get_calendar", "get_conversations", "get_git_log", "get_project", "make_document", "make_page", "offer_choices"]);
    const convo = await get("/api/conversation");
    expect(convo.turns[0]).toMatchObject({ kind: "offer", text: expect.stringContaining("I drafted"), offer: { mode: "done" }, artifacts: [{ kind: "doc" }] });
    expect(notified[0]).toMatch(/^Done: Wednesday's Module 2 post tuned for shares and saves \| I drafted/);
  });
});
