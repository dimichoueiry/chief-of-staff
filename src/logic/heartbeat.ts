/**
 * The heartbeat: how it writes first. Every so often, while the app runs, it looks at what is
 * coming up (reminders, the calendar, project cadences, what was said in recent chats) and decides
 * whether there is something it can do for them before they ask. Most of the time there isn't,
 * and it says nothing.
 *
 * When there is, it writes one message, the way a person would: "Want Wednesday's Module 2 post
 * tuned for shares and saves?" with Yes / Not now. That is Proactive. In Proactive+ it goes ahead
 * with anything that only needs a document or a page written, and the message is the result.
 * Anything that would send, post, buy or change something still waits for a yes.
 *
 * It lives inside the running app, not in launchd: macOS gives calendar access to the app, not to
 * a job started beside it (see T7.9 in docs/BACKLOG.md).
 *
 * Cheap by design. A tick costs no model call unless what it would look at has changed since the
 * last time it did (or half a day has passed), and it never writes more than a few times a day.
 * What it looked at and what it decided is kept in ~/.cos/heartbeat.md, so a silence can be read.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../core/ledger.js";
import { reminderWhen, type Reminder } from "../core/reminders.js";
import type { ArtifactRef } from "../core/artifacts.js";
import type { CalendarEvent } from "../sensors/calendar.js";
import { addDays, todayISO, weekdayName } from "../util/dates.js";
import { cosHome } from "../util/home.js";
import { cadenceDueToday } from "./cadence.js";

/** off: never writes first. proactive: offers, and waits for a yes. plus: does what it safely can, then shows it. */
export type ProactiveMode = "off" | "proactive" | "plus";
export const MODES: readonly ProactiveMode[] = ["off", "proactive", "plus"];
export const MODE_NAMES: Record<ProactiveMode, string> = { off: "Off", proactive: "Proactive", plus: "Proactive+" };

export function isMode(s: unknown): s is ProactiveMode {
  return typeof s === "string" && (MODES as readonly string[]).includes(s);
}

export interface Offer {
  id: string;
  /** Stable name for what it is about, so the same thing is never offered twice. */
  key: string;
  title: string;
  body: string;
  /** What it does on a yes: instructions to itself, not shown as the message. */
  work: string;
  /** Whether the work only writes a document or a page (Proactive+ may go ahead with it). */
  safe: boolean;
  createdAt: string;
  conversation: string;
  /** open: waiting. accepted: they said yes. declined: not now. done: Proactive+ did it on its own. */
  status: "open" | "accepted" | "declined" | "done";
  answeredAt?: string;
  artifacts?: ArtifactRef[];
}

export interface HeartbeatState {
  mode: ProactiveMode;
  offers: Offer[];
  /** The last time the model was asked, what it was shown (as a fingerprint) and what it said. */
  last?: { at: string; fingerprint: string; outcome: string };
}

/** On unless turned off: speaking first is the product. */
export const DEFAULT_MODE: ProactiveMode = "proactive";
/** At most this many messages it starts in a day. */
export const MAX_PER_DAY = 3;
/** And never two within this long of each other. */
export const MIN_GAP_MS = 90 * 60_000;
/** An offer they haven't answered holds back the next one this long. */
export const OPEN_HOLD_MS = 12 * 60 * 60_000;
/** How far ahead it looks. */
export const HORIZON_HOURS = 48;
/** Offers kept (answered ones are what stops a repeat). */
const KEEP_OFFERS = 200;

export function stateFile(): string {
  return join(cosHome(), "heartbeat.json");
}

export function logFile(): string {
  return join(cosHome(), "heartbeat.md");
}

export function readState(file = stateFile()): HeartbeatState {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<HeartbeatState>;
    return { mode: isMode(raw.mode) ? raw.mode : DEFAULT_MODE, offers: Array.isArray(raw.offers) ? raw.offers : [], ...(raw.last ? { last: raw.last } : {}) };
  } catch {
    return { mode: DEFAULT_MODE, offers: [] };
  }
}

export function saveState(state: HeartbeatState, file = stateFile()): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const kept = { ...state, offers: state.offers.slice(-KEEP_OFFERS) };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function setMode(mode: ProactiveMode, file = stateFile()): HeartbeatState {
  const s = readState(file);
  s.mode = mode;
  delete s.last; // a new mode is a reason to look again
  saveState(s, file);
  return s;
}

/** One line in ~/.cos/heartbeat.md, newest last; the file keeps its last few hundred lines. */
export function appendLog(line: string, now = new Date(), file = logFile()): void {
  const stamp = `${todayISO(now)} ${hhmm(now)}`;
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- "));
  } catch {
    /* first line */
  }
  lines.push(`- ${stamp} · ${line.replace(/\s+/g, " ").trim()}`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `# Heartbeat\n\nWhat it looked at, and whether it wrote to you. Newest last.\n\n${lines.slice(-300).join("\n")}\n`, "utf8");
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------- what it looks at ----------

export interface Signal {
  kind: "reminder" | "event" | "cadence";
  /** "2026-09-23 09:00", or a date. */
  when: string;
  text: string;
}

/**
 * What is coming up in the next two days, plus reminders a day overdue: the things it could get
 * ready ahead of time. Pure, so the tick's choice of what to look at is tested on its own.
 */
export function gatherSignals(o: { reminders: Reminder[]; events: CalendarEvent[]; projects: Project[]; now: Date }): Signal[] {
  const today = todayISO(o.now);
  const until = new Date(o.now.getTime() + HORIZON_HOURS * 3_600_000);
  const lastDay = todayISO(until);
  const out: Signal[] = [];
  for (const r of o.reminders) {
    if (r.done || r.date < addDays(today, -1) || r.date > lastDay) continue;
    out.push({ kind: "reminder", when: reminderWhen(r), text: r.text });
  }
  for (const e of o.events) {
    const start = new Date(e.start);
    if (Number.isNaN(start.getTime()) || start > until) continue;
    if (e.allDay ? todayISO(start) < today : new Date(e.end || e.start) < o.now) continue;
    out.push({ kind: "event", when: e.allDay ? `${todayISO(start)} (all day)` : `${todayISO(start)} ${hhmm(start)}`, text: e.title });
  }
  for (const day of [today, addDays(today, 1)]) {
    for (const p of o.projects) {
      if (!cadenceDueToday(p, day)) continue;
      out.push({ kind: "cadence", when: `${day} (${weekdayName(day)})`, text: `${p.name}: its day${p.next ? `; next action: ${p.next}` : ""}` });
    }
  }
  return out.sort((a, b) => a.when.localeCompare(b.when));
}

// ---------- when it may speak ----------

/** "22-8" → quiet from 22:00 to 08:00. COS_QUIET_HOURS changes it; "off" means never quiet. */
export function isQuiet(now: Date, spec = process.env.COS_QUIET_HOURS ?? "22-8"): boolean {
  if (/^\s*off\s*$/i.test(spec)) return false;
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec);
  const [from, to] = m ? [Number(m[1]), Number(m[2])] : [22, 8];
  const h = now.getHours();
  return from > to ? h >= from || h < to : h >= from && h < to;
}

export type Gate = { ok: true } | { ok: false; why: string };

/** Whether it may start a message now, before anything is read or any model is asked. */
export function mayWrite(state: HeartbeatState, now: Date, quiet = isQuiet(now)): Gate {
  if (state.mode === "off") return { ok: false, why: "off" };
  if (quiet) return { ok: false, why: "quiet hours" };
  const t = now.getTime();
  const waiting = state.offers.find((o) => o.status === "open" && t - Date.parse(o.createdAt) < OPEN_HOLD_MS);
  if (waiting) return { ok: false, why: `waiting on "${waiting.title}"` };
  const today = todayISO(now);
  const sent = state.offers.filter((o) => todayISO(new Date(o.createdAt)) === today);
  if (sent.length >= MAX_PER_DAY) return { ok: false, why: `already wrote ${sent.length} times today` };
  const latest = state.offers.reduce((m, o) => Math.max(m, Date.parse(o.createdAt) || 0), 0);
  if (t - latest < MIN_GAP_MS) return { ok: false, why: "wrote recently" };
  return { ok: true };
}

/** What the model would be shown, as a short hash: the same picture is not looked at twice in a half day. */
export function fingerprint(parts: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export function halfDay(now: Date): string {
  return `${todayISO(now)}-${now.getHours() < 12 ? "am" : "pm"}`;
}

// ---------- asking the model ----------

export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["speak", "why", "key", "title", "body", "work", "can_do_now"],
  properties: {
    speak: { type: "boolean" },
    why: { type: "string" },
    key: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    work: { type: "string" },
    can_do_now: { type: "boolean" },
  },
} as const;

export const DECISION_INSTRUCTIONS = `You are the heartbeat of their chief of staff. Every so often you look at what is coming up for them and decide whether to write to them first, before they ask. Most of the time the right answer is to say nothing.

Write only when all of these hold:
- Something specific is coming up soon or was left unfinished, and it is in front of you: under "Coming up", in their projects, or in something they said in a recent conversation.
- You can do real work on it yourself, right now, with what you have: draft it, tighten it, prepare every platform's version, research it, plan it, write up what they need. Producing a document counts. Nagging does not: "don't forget X" is never an offer.
- They would clearly be glad you asked. If you are unsure, say nothing.
- It builds on what exists. If they already drafted it, offer to sharpen it (what the platform rewards now, a stronger hook), not to write it again.
- It is not under "Already offered". Something they turned down stays turned down.

Never write to check in, say hello, summarise their day, or remind them of something they obviously know.

If you write:
- title: the question, in their words and names, under 70 characters. Example: "Want Wednesday's Module 2 post tuned for shares and saves?"
- body: one or two sentences, under 240 characters: what you would do and why now. Concrete, no greeting, no filler, no exclamation marks.
- work: instructions to yourself for when they say yes: what to read, what to produce, what the document must contain. Specific enough that you could do it cold. Not shown to them.
- key: a short stable id for the thing itself, e.g. "module-2-post-2026-09-23", so it is never offered twice.
- can_do_now: true only when the work is reading and writing a document or page for them to look at; false if doing it would send, post, schedule, buy, delete, or change their memory.

If you don't write: speak false, a one-line why, and empty strings for the rest.

Answer with the JSON object only.`;

export interface DecisionInput {
  now: Date;
  mode: ProactiveMode;
  signals: Signal[];
  offers: Offer[];
  /** Their standing instructions for the heartbeat, if they wrote any (selfhub goals/heartbeat.md). */
  rules?: string;
}

export function decisionMessage(o: DecisionInput): string {
  const today = todayISO(o.now);
  const offered = o.offers.slice(-20).map((x) => `- ${x.key} · "${x.title}" · ${x.status === "open" ? "not answered yet" : x.status === "declined" ? "they said not now" : x.status === "accepted" ? "they said yes, done" : "you did it on your own"}`);
  return [
    `Now: ${weekdayName(today)} ${today} ${hhmm(o.now)}.`,
    "",
    "# Coming up",
    o.signals.length ? o.signals.map((s) => `- ${s.when} · ${s.kind} · ${s.text}`).join("\n") : "Nothing dated in the next two days.",
    "",
    "# Already offered",
    offered.length ? offered.join("\n") : "Nothing yet.",
    ...(o.rules?.trim() ? ["", "# Their instructions for you", o.rules.trim()] : []),
    "",
    "Should you write to them now? The recent conversations and their projects are in memory.",
  ].join("\n");
}

export interface Decision {
  speak: boolean;
  why: string;
  offer?: { key: string; title: string; body: string; work: string; safe: boolean };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The model's answer, checked: an offer with no title or no work is no offer. */
export function parseDecision(raw: unknown): Decision {
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).replace(/\s+/g, " ").trim() : "");
  const why = str("why") || "no reason given";
  if (o.speak !== true) return { speak: false, why };
  const title = str("title");
  const work = typeof o.work === "string" ? o.work.trim() : "";
  if (!title || !work) return { speak: false, why: `it wanted to write but gave no ${title ? "work" : "title"}` };
  const key = (str("key") || title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return { speak: true, why, offer: { key, title: clip(title, 90), body: clip(str("body"), 300), work, safe: o.can_do_now === true } };
}

/** Already offered (in any state), so not again. */
export function alreadyOffered(state: HeartbeatState, key: string): Offer | undefined {
  return state.offers.find((o) => o.key === key);
}

export function newOffer(d: NonNullable<Decision["offer"]>, conversation: string, now: Date): Offer {
  return { id: randomUUID(), key: d.key, title: d.title, body: d.body, work: d.work, safe: d.safe, createdAt: now.toISOString(), conversation, status: "open" };
}

/** Mark an offer answered. Returns it, or null when it isn't open anymore. */
export function answer(id: string, status: "accepted" | "declined", now = new Date(), file = stateFile()): Offer | null {
  const s = readState(file);
  const o = s.offers.find((x) => x.id === id);
  if (!o || o.status !== "open") return null;
  o.status = status;
  o.answeredAt = now.toISOString();
  saveState(s, file);
  return o;
}

/** Their standing instructions: selfhub/goals/heartbeat.md, if it's there. */
export function readRules(selfhubDir: string): string {
  const file = join(selfhubDir, "goals", "heartbeat.md");
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8").slice(0, 4_000);
  } catch {
    return "";
  }
}

/** What Proactive+ is told when it goes ahead on its own. */
export function workMessage(o: Offer): string {
  return [
    `(The heartbeat: you decided to do this for them before they asked, and they allow that for work that only prepares something. They haven't said anything yet.)`,
    "",
    `What: ${o.title}`,
    `Your instructions: ${o.work}`,
    "",
    "Do it now. Put the result in a document with make_document (or a page with make_page if it has to be seen). Only prepare: don't send, post, schedule, open anything, run commands, start agents or change their memory.",
    "Then write the message they'll see, one or two sentences: start with what you did (\"I drafted…\"), then the one thing they need to decide or fill in. If there's nothing to decide, stop after what you did. Don't repeat the document.",
  ].join("\n");
}

/** What a yes to an offer turns into: their message, with what the offer promised in front of it. */
export function acceptMessage(o: Offer): string {
  return `(They tapped Yes on your offer "${o.title}". Do it now, following what you planned: ${o.work} Put the result in a document with make_document unless it has to be seen as a page. Then say in a line or two what's in it and anything they must decide, and offer the natural next step if there is one.)`;
}

// ---------- the timer ----------

export interface Notice {
  id: string;
  title: string;
  body: string;
  conversation: string;
  at: string;
}

export interface TickResult {
  outcome: "off" | "held" | "unchanged" | "nothing" | "offered" | "done" | "failed" | "busy";
  why?: string;
  offer?: Offer;
}

export interface HeartbeatDeps {
  now?: () => Date;
  /** Everything coming up, read fresh (reminders, calendar, ledger). */
  signals: () => Promise<Signal[]>;
  /** Recent conversations, as they go into memory: part of what is looked at, and of the fingerprint. */
  recall: () => string;
  rules: () => string;
  /** Whether a model is set up to ask. Read on every tick: keys can be added while it runs. */
  ready: () => boolean;
  /** Ask the model; returns its JSON. */
  decide: (instructions: string, message: string) => Promise<unknown>;
  /** Put the offer in the chat (and for Proactive+, do the work first). Returns the chat's id. */
  deliver: (offer: Offer, mode: ProactiveMode) => Promise<{ conversation: string; artifacts?: ArtifactRef[]; text?: string }>;
  notify: (n: Notice) => Promise<void>;
  /** A reply is being written right now: come back on the next tick. */
  busy?: () => boolean;
  file?: string;
  log?: (line: string) => void;
}

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly d: HeartbeatDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  private note(line: string): void {
    try {
      appendLog(line, this.now());
    } catch {
      /* a log that can't be written must not stop it */
    }
    this.d.log?.(`heartbeat: ${line}`);
  }

  /**
   * One look. `force` skips the gate and the fingerprint (a tick asked for by hand), never the mode.
   * Only one runs at a time; one that finds another running returns "busy".
   */
  async tick(o: { force?: boolean } = {}): Promise<TickResult> {
    if (this.running) return { outcome: "busy" };
    this.running = true;
    try {
      return await this.look(Boolean(o.force));
    } catch (err) {
      const why = (err as Error).message.split("\n")[0];
      this.note(`couldn't look: ${why}`);
      return { outcome: "failed", why };
    } finally {
      this.running = false;
    }
  }

  private async look(force: boolean): Promise<TickResult> {
    const now = this.now();
    const state = readState(this.d.file);
    if (state.mode === "off") return { outcome: "off" };
    if (!force) {
      const gate = mayWrite(state, now);
      if (!gate.ok) return { outcome: "held", why: gate.why };
    }
    if (this.d.busy?.()) return { outcome: "busy" };
    if (!this.d.ready()) return { outcome: "held", why: "no model" };

    const signals = await this.d.signals();
    const recall = this.d.recall();
    const rules = this.d.rules();
    const print = fingerprint([halfDay(now), state.mode, signals, recall, rules, state.offers.map((x) => [x.key, x.status])]);
    if (!force && state.last?.fingerprint === print) return { outcome: "unchanged" };
    if (!signals.length && !recall.trim()) {
      state.last = { at: now.toISOString(), fingerprint: print, outcome: "nothing to look at" };
      saveState(state, this.d.file);
      return { outcome: "nothing", why: "nothing coming up and no recent chats" };
    }

    const decision = parseDecision(await this.d.decide(DECISION_INSTRUCTIONS, decisionMessage({ now, mode: state.mode, signals, offers: state.offers, rules })));
    const fresh = readState(this.d.file); // answered or switched off while the model thought
    fresh.last = { at: now.toISOString(), fingerprint: print, outcome: decision.speak ? "wrote" : `quiet: ${decision.why}` };
    if (!decision.offer) {
      saveState(fresh, this.d.file);
      this.note(`looked at ${signals.length} thing${signals.length === 1 ? "" : "s"} coming up; said nothing (${decision.why})`);
      return { outcome: "nothing", why: decision.why };
    }
    const seen = alreadyOffered(fresh, decision.offer.key);
    if (seen) {
      saveState(fresh, this.d.file);
      this.note(`wanted to offer "${decision.offer.title}" again; already ${seen.status}`);
      return { outcome: "nothing", why: `already offered (${seen.status})` };
    }
    if (fresh.mode === "off") return { outcome: "off" };

    const offer = newOffer(decision.offer, "", now);
    const ahead = fresh.mode === "plus" && offer.safe;
    const put = await this.d.deliver(offer, ahead ? "plus" : "proactive");
    offer.conversation = put.conversation;
    if (ahead) {
      offer.status = "done";
      offer.answeredAt = this.now().toISOString();
      if (put.artifacts?.length) offer.artifacts = put.artifacts;
    }
    const latest = readState(this.d.file);
    latest.last = fresh.last;
    latest.offers.push(offer);
    saveState(latest, this.d.file);
    this.note(ahead ? `did "${offer.title}" on its own (${decision.why})` : `offered "${offer.title}" (${decision.why})`);
    await this.d.notify({
      id: offer.id,
      title: ahead ? `Done: ${offer.title.replace(/^(?:want|should i|shall i|can i)\s+(?:me\s+to\s+)?/i, "").replace(/\?$/, "")}` : offer.title,
      body: ahead ? (put.text ?? offer.body) : offer.body,
      conversation: offer.conversation,
      at: offer.createdAt,
    }).catch((err) => this.note(`couldn't notify: ${(err as Error).message}`));
    return { outcome: ahead ? "done" : "offered", why: decision.why, offer };
  }

  /** Look every `everyMs`, and once shortly after starting. */
  start(everyMs = 30 * 60_000, firstAfterMs = 2 * 60_000): void {
    if (this.timer) return;
    const run = () => void this.tick();
    this.first = setTimeout(run, firstAfterMs);
    this.first.unref?.();
    this.timer = setInterval(run, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
  }
}
