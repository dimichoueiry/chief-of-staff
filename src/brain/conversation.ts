/**
 * Short-term memory: the conversation in progress. Every exchange in the pill
 * is saved under ~/.cos/conversations and replayed to the model with the next
 * message, so follow-ups ("and tomorrow?", "open the second one", "yes, save
 * that") make sense. A conversation ends when you start a new one or after a
 * quiet spell; long-term memory stays in selfhub.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export class Conversations {
  constructor(
    readonly dir: string = conversationsDir(),
    readonly idleMinutes = 120,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** File names newest first: ids start with the start time. */
  private names(): string[] {
    try {
      return readdirSync(this.dir).filter((n) => n.endsWith(".json")).sort().reverse();
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

  private create(): Conversation {
    const at = this.now().toISOString();
    const id = `${at.replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
    return { id, startedAt: at, updatedAt: at, turns: [] };
  }

  private save(c: Conversation): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file(c.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file(c.id));
  }

  /** The conversation in progress, or a fresh one (not saved until something is said) if the last went quiet. */
  current(): Conversation {
    const last = this.latest();
    if (!last) return this.create();
    const quietFor = this.now().getTime() - new Date(last.updatedAt).getTime();
    return quietFor < this.idleMinutes * 60_000 ? last : this.create();
  }

  /** End the conversation in progress and begin a new one. */
  startNew(): Conversation {
    const last = this.latest();
    if (last && !last.turns.length) return last;
    const c = this.create();
    this.save(c);
    return c;
  }

  /** Add turns to a conversation and save it. */
  append(c: Conversation, ...turns: Omit<Turn, "at">[]): Conversation {
    const at = this.now().toISOString();
    c.turns.push(...turns.map((t) => ({ ...t, at })));
    c.updatedAt = at;
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
