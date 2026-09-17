/**
 * Short-term memory: the conversation in progress. Every exchange in the pill
 * is saved under ~/.cos/conversations and replayed to the model with the next
 * message, so follow-ups ("and tomorrow?", "open the second one", "yes, save
 * that") make sense. A conversation ends when you start a new one, switch to
 * another, or after a quiet spell; any saved one can be picked up again.
 * An aside ("by the way…") is a short side conversation kept apart from the one
 * in progress and thrown away on the way back to it. Long-term memory stays in selfhub.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { todayISO } from "../util/dates.js";
import { cosHome } from "../util/home.js";
import type { ConfirmView } from "../actions/pending.js";
import type { ChatMessage } from "./llm/types.js";

export interface Turn {
  /** event: something that happened outside the chat, like confirming a link. */
  role: "user" | "assistant" | "event";
  text: string;
  /** ISO datetime. */
  at: string;
  /** assistant: provider:model, or "rules" when no model was needed. */
  model?: string;
  /** assistant: answer | capture | action | confirm | focus | error. */
  kind?: string;
  /** assistant: the tool calls and results behind the reply, replayed to the model. */
  steps?: ChatMessage[];
  /** assistant: actions this reply left waiting for the user's OK. */
  confirm?: ConfirmView[];
  /** event: an action that was carried out, so the same one isn't queued again. */
  done?: { kind: string; detail: string };
  /** user: a screenshot went with this message (the image itself is never kept). */
  screen?: { app: string; window: string };
  /** assistant: actions this reply carried out itself (with their OK, or allowed on their own). */
  actionsDone?: { kind: string; detail: string }[];
}

export interface Conversation {
  id: string;
  startedAt: string;
  updatedAt: string;
  turns: Turn[];
  /** Written once the conversation has ended (see recall.ts). */
  summary?: ConversationSummary;
  /** The last failed attempt to summarise, so a broken model isn't retried on every message. */
  summaryFailedAt?: string;
  /** The name they gave it. */
  title?: string;
  /** A short name the model gave it from its first messages (see recall.ts), until they name it. */
  autoTitle?: string;
  /** How many of their messages the model had seen when it named it. */
  autoTitleMessages?: number;
  titleFailedAt?: string;
  /** An aside: the id of the conversation it was started from, which "back on topic" returns to. */
  asideOf?: string;
}

/** What the list of chats calls it: their name, the model's, or the start of what they first said. */
export function displayTitle(c: Conversation): string {
  if (c.title) return c.title;
  if (c.autoTitle) return c.autoTitle;
  const first = c.turns.find((t) => t.role === "user")?.text.replace(/\s+/g, " ").trim();
  if (!first) return "New chat";
  return first.length > 60 ? `${first.slice(0, 60).trimEnd()}…` : first;
}

/** Their messages in a conversation. */
export function messageCount(c: Conversation): number {
  return c.turns.filter((t) => t.role === "user").length;
}

export interface ConversationSummary {
  text: string;
  /** provider:model, or "rules" for conversations too short to need a model. */
  model: string;
  at: string;
  /** True when the conversation was too long and only its later part was summarised. */
  partial?: boolean;
}

export function conversationsDir(): string {
  return join(cosHome(), "conversations");
}

/** Deleted chats are kept aside this long, so a mistake can be undone, then removed for good. */
export const KEEP_DELETED_DAYS = 30;

/** Asides are saved under this prefix, so listing leaves them out without reading any file. */
const ASIDE_PREFIX = "aside-";

export class Conversations {
  constructor(
    readonly dir: string = conversationsDir(),
    readonly idleMinutes = 120,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** The conversation picked last (started, or switched to) and when; not a .json, so it's never listed. */
  private get pointerFile(): string {
    return join(this.dir, ".active");
  }

  private chosen(): { id: string; at: string } | null {
    try {
      const p = JSON.parse(readFileSync(this.pointerFile, "utf8")) as { id?: unknown; at?: unknown };
      return typeof p.id === "string" && typeof p.at === "string" ? { id: p.id, at: p.at } : null;
    } catch {
      return null;
    }
  }

  private choose(id: string): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pointerFile, JSON.stringify({ id, at: this.now().toISOString() }), { mode: 0o600 });
  }

  /** Where deleted chats wait out KEEP_DELETED_DAYS: a folder, so they're never listed, remembered or searched. */
  private get deletedDir(): string {
    return join(this.dir, "deleted");
  }

  /**
   * Delete a saved chat. It leaves the list, the assistant's memory and search at once. The file is
   * moved aside rather than erased, and removed for good after KEEP_DELETED_DAYS. If it was the chat
   * picked last, nothing is picked. False when there's no such chat (or the id isn't valid).
   */
  delete(id: string): boolean {
    if (!this.get(id)) return false;
    mkdirSync(this.deletedDir, { recursive: true, mode: 0o700 });
    const aside = join(this.deletedDir, `${id}.json`);
    renameSync(this.file(id), aside);
    const now = this.now();
    utimesSync(aside, now, now); // when it was deleted, for the clear-out
    if (this.chosen()?.id === id) rmSync(this.pointerFile, { force: true });
    this.clearDeleted();
    return true;
  }

  /** Whether a chat was deleted (and is still set aside). */
  isDeleted(id: string): boolean {
    return /^[\w-]+$/.test(id) && existsSync(join(this.deletedDir, `${id}.json`));
  }

  /** Remove chats deleted more than KEEP_DELETED_DAYS ago. */
  private clearDeleted(): void {
    const cutoff = this.now().getTime() - KEEP_DELETED_DAYS * 86_400_000;
    try {
      for (const name of readdirSync(this.deletedDir)) {
        const file = join(this.deletedDir, name);
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
      }
    } catch {
      /* nothing set aside */
    }
  }

  /** One saved conversation by id, or null (unknown, damaged, or not a valid id). */
  get(id: string): Conversation | null {
    if (!/^[\w-]+$/.test(id)) return null;
    return this.read(`${id}.json`);
  }

  /** File names newest first: ids start with the start time. Asides are not chats, so they're left out. */
  private names(): string[] {
    try {
      return readdirSync(this.dir).filter((n) => n.endsWith(".json") && !n.startsWith(ASIDE_PREFIX)).sort().reverse();
    } catch {
      return [];
    }
  }

  private read(name: string): Conversation | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Conversation;
    } catch {
      return null; // a damaged file
    }
  }

  private latest(): Conversation | null {
    for (const name of this.names()) {
      const c = this.read(name);
      if (c) return c;
    }
    return null;
  }

  /** How many conversation files are saved (without reading them), empty ones included. */
  count(): number {
    return this.names().length;
  }

  /** Every saved conversation, newest first. Damaged files are skipped and counted. */
  list(): { conversations: Conversation[]; unreadable: number } {
    const conversations: Conversation[] = [];
    let unreadable = 0;
    for (const name of this.names()) {
      const c = this.read(name);
      if (c) conversations.push(c);
      else unreadable++;
    }
    return { conversations, unreadable };
  }

  /** Save changes to a conversation that was read from the store. */
  update(c: Conversation): void {
    this.save(c);
  }

  /**
   * Change a saved conversation as it is on disk now, not as it was read earlier: background
   * work (summaries, titles) takes seconds, and new messages may have been saved meanwhile.
   */
  patch(id: string, change: (c: Conversation) => void): Conversation | null {
    const c = this.get(id);
    if (!c) return null;
    change(c);
    this.save(c);
    return c;
  }

  /** Name a conversation; an empty name goes back to the automatic one. */
  rename(id: string, title: string): Conversation | null {
    const name = title.replace(/\s+/g, " ").trim().slice(0, 80);
    return this.patch(id, (c) => {
      if (name) c.title = name;
      else delete c.title;
    });
  }

  private create(prefix = ""): Conversation {
    const at = this.now().toISOString();
    const id = `${prefix}${at.replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
    return { id, startedAt: at, updatedAt: at, turns: [] };
  }

  private save(c: Conversation): void {
    // A reply or a summary finishing after the chat was deleted must not bring it back.
    if (this.isDeleted(c.id) && !existsSync(this.file(c.id))) return;
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file(c.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file(c.id));
  }

  /**
   * The conversation in progress: whichever of the one picked last and the newest one was active
   * most recently (switching to an old one counts as activity). A fresh one (not saved until
   * something is said) if that went quiet.
   */
  current(): Conversation {
    const pick = this.chosen();
    const picked = pick ? this.get(pick.id) : null;
    const latest = this.latest();
    const activeAt = (c: Conversation) => Math.max(new Date(c.updatedAt).getTime(), c.id === pick?.id ? new Date(pick.at).getTime() : 0);
    const candidates = [picked, latest].filter((c): c is Conversation => c !== null);
    if (!candidates.length) return this.create();
    const last = candidates.reduce((a, b) => (activeAt(b) > activeAt(a) ? b : a));
    const quietFor = this.now().getTime() - activeAt(last);
    return quietFor < this.idleMinutes * 60_000 ? last : this.create();
  }

  /** End the conversation in progress and begin a new one. An aside in progress is thrown away. */
  startNew(): Conversation {
    this.clearAsides();
    const last = this.latest();
    if (last && !last.turns.length) {
      this.choose(last.id);
      return last;
    }
    const c = this.create();
    this.save(c);
    this.choose(c.id);
    return c;
  }

  /** Pick up a saved conversation where it left off. Null if there's no such conversation. */
  open(id: string): Conversation | null {
    const c = this.get(id);
    if (!c) return null;
    if (!c.asideOf) this.clearAsides();
    this.choose(c.id);
    return c;
  }

  /**
   * Step out of the conversation in progress for a quick unrelated exchange. The aside is its own
   * conversation, so the main one keeps its thread and gets nothing from it; endAside returns to
   * the main one and throws the aside away. Already in an aside: that aside carries on.
   */
  startAside(): Conversation {
    const main = this.current();
    if (main.asideOf) return main;
    // A fresh chat isn't saved until something is said; save it so there's something to come back to.
    if (!this.get(main.id)) this.save(main);
    this.clearAsides();
    const aside = { ...this.create(ASIDE_PREFIX), asideOf: main.id };
    this.save(aside);
    this.choose(aside.id);
    return aside;
  }

  /**
   * Back on topic: throw the aside away and pick up the conversation it was started from (a new one
   * if that was deleted meanwhile). Null when there's no aside to leave. Works after any quiet spell,
   * since the aside is whatever was picked last, not whatever is still active.
   */
  endAside(): Conversation | null {
    const pick = this.chosen();
    const aside = pick ? this.get(pick.id) : null;
    if (!aside?.asideOf) return null;
    this.clearAsides();
    const main = this.get(aside.asideOf);
    if (!main) return this.startNew();
    this.choose(main.id);
    return main;
  }

  /** Remove every saved aside: they're never kept. */
  private clearAsides(): void {
    try {
      for (const name of readdirSync(this.dir)) {
        if (name.startsWith(ASIDE_PREFIX) && name.endsWith(".json")) rmSync(join(this.dir, name), { force: true });
      }
    } catch {
      /* nothing saved yet */
    }
  }

  /** Add turns to a conversation and save it, on top of whatever is saved for it now. */
  append(c: Conversation, ...turns: Omit<Turn, "at">[]): Conversation {
    const at = this.now().toISOString();
    const saved = this.get(c.id);
    if (saved) {
      // A name given since it was read (renamed, or named in the background) is kept.
      for (const key of ["title", "autoTitle", "autoTitleMessages", "titleFailedAt"] as const) {
        if (saved[key] === undefined) delete c[key];
        else (c as unknown as Record<string, unknown>)[key] = saved[key];
      }
    }
    c.turns.push(...turns.map((t) => ({ ...t, at })));
    c.updatedAt = at;
    // Picked up again after it ended: the old summary no longer covers it, so it's written again when it ends.
    delete c.summary;
    delete c.summaryFailedAt;
    this.save(c);
    return c;
  }
}

/** Local YYYY-MM-DD and HH:MM of an ISO datetime. */
export function localStamp(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return { date: todayISO(d), time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` };
}

/** Events since the last reply (a confirmed link, a command that ran): told to the model with the next message. */
export function eventsSinceReply(c: Conversation): string[] {
  const out: string[] = [];
  for (let i = c.turns.length - 1; i >= 0 && c.turns[i].role !== "assistant"; i--) {
    if (c.turns[i].role === "event") out.unshift(c.turns[i].text);
  }
  return out;
}

/** A message with what happened since the last reply in front, the way history replays it. */
export function withEvents(events: string[], said: string): string {
  return events.length ? `(Since your last reply: ${events.join(" ")})\n\n${said}` : said;
}

/** What the page shows: the turns without the tool steps. */
export function visibleTurns(c: Conversation): Omit<Turn, "steps">[] {
  return c.turns.map(({ steps: _steps, ...t }) => t);
}

export interface HistoryOptions {
  /** Rough size limit for the replayed history; the oldest exchanges drop first. */
  maxChars?: number;
  maxExchanges?: number;
  /** Tool results are cut to this many characters. */
  maxToolChars?: number;
}

/**
 * The conversation as model messages, oldest first. Provider-specific data is
 * never replayed because the model may have changed since; tool call ids are
 * rewritten so any provider accepts them; events are told to the model at the
 * start of the next thing the user says.
 */
export function historyMessages(c: Conversation, o: HistoryOptions = {}): ChatMessage[] {
  const maxChars = o.maxChars ?? 24_000;
  const maxExchanges = o.maxExchanges ?? 12;
  const maxToolChars = o.maxToolChars ?? 1_500;

  const exchanges: ChatMessage[][] = [];
  let events: string[] = [];
  let open: ChatMessage[] | null = null;
  for (const t of c.turns) {
    if (t.role === "event") {
      events.push(t.text);
    } else if (t.role === "user") {
      // Events stay pending until a reply lands, so a message that never got one doesn't swallow them.
      open = [{ role: "user", content: withEvents(events, t.text) }];
      exchanges.push(open);
    } else if (open) {
      const n = exchanges.length;
      for (const step of t.steps ?? []) open.push(cleanStep(step, n, maxToolChars));
      open.push({ role: "assistant", text: t.text.trim() || "(no reply)", toolCalls: [] });
      open = null;
      events = [];
    }
  }

  // Only complete exchanges: a message with no reply yet is the one being answered now.
  const complete = exchanges.filter((e) => e.at(-1)?.role === "assistant");
  const kept: ChatMessage[][] = [];
  let size = 0;
  for (const e of [...complete].reverse()) {
    const s = JSON.stringify(e).length;
    if (kept.length && (kept.length >= maxExchanges || size + s > maxChars)) break;
    kept.unshift(e);
    size += s;
  }
  // Say what was left out, so the model looks it up instead of assuming the conversation began here.
  const dropped = complete.length - kept.length;
  if (dropped && kept[0]?.[0].role === "user") {
    const note = `(${dropped} earlier exchange${dropped === 1 ? " in this conversation is" : "s in this conversation are"} not repeated here; get_conversations can look ${dropped === 1 ? "it" : "them"} up.)`;
    kept[0][0] = { role: "user", content: `${note}\n\n${kept[0][0].content}` };
  }
  return kept.flat();
}

function cleanStep(m: ChatMessage, exchange: number, maxToolChars: number): ChatMessage {
  const id = (raw: string) => `h${exchange}_${raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(-40)}`;
  if (m.role === "assistant") {
    return { role: "assistant", text: m.text, toolCalls: m.toolCalls.map((tc) => ({ ...tc, id: id(tc.id) })) };
  }
  if (m.role === "tool") {
    return {
      role: "tool",
      results: m.results.map((r) => ({
        ...r,
        id: id(r.id),
        content: r.content.length > maxToolChars ? `${r.content.slice(0, maxToolChars)}\n… (cut)` : r.content,
      })),
    };
  }
  return m;
}
