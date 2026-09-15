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
import { cosHome } from "../util/home.js";
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
}

export interface Conversation {
  id: string;
  startedAt: string;
  updatedAt: string;
  turns: Turn[];
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

  private latest(): Conversation | null {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return null;
    }
    // Ids start with the start time, so the last name is the newest conversation.
    for (const name of names.reverse()) {
      try {
        return JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Conversation;
      } catch {
        /* a damaged file: try the one before */
      }
    }
    return null;
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
      const said = events.length ? `(Since your last reply: ${events.join(" ")})\n\n${t.text}` : t.text;
      open = [{ role: "user", content: said }];
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
  for (const e of complete.reverse()) {
    const s = JSON.stringify(e).length;
    if (kept.length && (kept.length >= maxExchanges || size + s > maxChars)) break;
    kept.unshift(e);
    size += s;
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
