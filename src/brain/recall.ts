/**
 * Memory across conversations. When a conversation ends, a model writes a few
 * lines about it (what was discussed, decided, filed, left open). The summaries
 * of the last days go into every request, and get_conversations searches every
 * saved conversation for the details a summary leaves out.
 */
import type { ModelSpec } from "./llm/registry.js";
import type { LLMProvider } from "./llm/types.js";
import { Conversations, localStamp, type Conversation, type Turn } from "./conversation.js";
import { formatSpec } from "./llm/registry.js";
import { WRITES } from "./tools.js";
import { addDays, todayISO } from "../util/dates.js";

const SUMMARY_PROMPT = `You keep the memory of a personal chief of staff. Below is one finished conversation between the user ("Them") and the chief of staff ("You").

Write the note the chief of staff will read later to remember it: 2 to 4 short plain-text lines, no headings or bullets.
- What they talked about, and what was decided or agreed.
- What was filed, changed or opened (projects, reminders, notes, shortcuts).
- Anything left open or promised for later.
Use exact names, dates (YYYY-MM-DD) and numbers from the conversation. Refer to the user as "they". Don't add anything that isn't in the conversation.`;

/** Longest transcript sent for one summary; longer conversations are summarised from their later part, and say so. */
const MAX_TRANSCRIPT_CHARS = 40_000;
/** Below this, the conversation's own words are a better record than a model's paraphrase. */
const TRIVIAL_CHARS = 400;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const weekday = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });

function spoke(c: Conversation): boolean {
  return c.turns.some((t) => t.role === "user");
}

/** Local dates a conversation touches. */
function span(c: Conversation): { from: string; to: string } {
  return { from: localStamp(c.startedAt).date, to: localStamp(c.updatedAt).date };
}

function when(c: Conversation): string {
  const a = localStamp(c.startedAt);
  const b = localStamp(c.updatedAt);
  return `${a.date} ${weekday(a.date)} ${a.time}${b.date === a.date ? `–${b.time}` : ` to ${b.date} ${b.time}`}`;
}

/** What changed because of a reply: writes and opens, from its tool steps. */
function actionsOf(t: Turn): string[] {
  const names = new Map<string, string>();
  const out: string[] = [];
  for (const step of t.steps ?? []) {
    if (step.role === "assistant") for (const call of step.toolCalls) names.set(call.id, call.name);
    if (step.role !== "tool") continue;
    for (const r of step.results) {
      const name = names.get(r.id) ?? "";
      if (!r.isError && (WRITES.includes(name) || name === "open")) out.push(oneLine(clip(r.content, 200)));
    }
  }
  return out;
}

/** The whole conversation as text for the summariser. */
export function transcript(c: Conversation, max = MAX_TRANSCRIPT_CHARS): { text: string; partial: boolean } {
  const lines: string[] = [];
  for (const t of c.turns) {
    const { date, time } = localStamp(t.at);
    if (t.role === "user") lines.push(`[${date} ${time}] Them: ${t.text}`);
    else if (t.role === "event") lines.push(`(${t.text})`);
    else {
      lines.push(`You: ${t.text}`);
      const did = actionsOf(t);
      if (did.length) lines.push(`(Done: ${did.join("; ")})`);
    }
  }
  const text = lines.join("\n");
  if (text.length <= max) return { text, partial: false };
  return { text: `(The start of this conversation is left out: it was too long to summarise at once.)\n…${text.slice(-max)}`, partial: true };
}

/** A summary built from the conversation's own words, used until (or instead of) a model summary. */
export function digest(c: Conversation): string {
  const asked = c.turns.filter((t) => t.role === "user").map((t) => `"${clip(oneLine(t.text), 90)}"`);
  const shown = asked.length > 4 ? [...asked.slice(0, 3), `and ${asked.length - 3} more messages`] : asked;
  const last = [...c.turns].reverse().find((t) => t.role === "assistant" && t.kind !== "error");
  return `They said ${shown.join(", ")}.${last ? ` Last reply: ${clip(oneLine(last.text), 160)}` : ""}`;
}

export function summaryText(c: Conversation): string {
  if (!c.summary) return digest(c);
  return c.summary.partial ? `${c.summary.text} (summary of the later part only)` : c.summary.text;
}

export interface RecallOptions {
  today?: string;
  /** Leave out the conversation in progress: it is already in the messages. */
  excludeId?: string;
  days?: number;
  maxChars?: number;
}

/** The "Earlier conversations" section of the model's memory. Empty when there are none. */
export function renderRecall(store: Conversations, o: RecallOptions = {}): string {
  const today = o.today ?? todayISO();
  const days = o.days ?? 7;
  const maxChars = o.maxChars ?? 4_000;
  const since = addDays(today, -(days - 1));
  const recent = store.list().conversations.filter((c) => c.id !== o.excludeId && spoke(c) && span(c).to >= since);
  if (!recent.length) return "";

  const lines: string[] = [];
  let size = 0;
  for (const c of recent) {
    const line = `- ${when(c)}: ${summaryText(c)}`;
    if (lines.length && size + line.length > maxChars) break;
    lines.push(line);
    size += line.length;
  }
  const left = recent.length - lines.length;
  return [
    `# Earlier conversations (last ${days} days, newest first)`,
    "What you and they talked about before this conversation. Use get_conversations for details or for anything older.",
    ...lines,
    ...(left ? [`(${left} more conversation${left === 1 ? "" : "s"} from these days ${left === 1 ? "is" : "are"} not listed here to save space; get_conversations finds ${left === 1 ? "it" : "them"}.)`] : []),
  ].join("\n");
}

export interface SearchOptions {
  query?: string;
  /** Inclusive local dates. */
  from?: string;
  to?: string;
  /** How many results to show; the header always reports how many matched in total. */
  limit?: number;
}

const STOP = new Set(["the", "and", "for", "that", "this", "with", "what", "was", "were", "did", "about", "we", "i", "you", "a", "an", "to", "of", "on", "in", "is", "it", "my", "me"]);

/** Search every saved conversation. Results are capped for the model; the counts are not. */
export function searchConversations(store: Conversations, o: SearchOptions = {}): string {
  const limit = o.limit ?? 8;
  const { conversations, unreadable } = store.list();
  const inRange = conversations.filter((c) => spoke(c) && (!o.from || span(c).to >= o.from) && (!o.to || span(c).from <= o.to));
  const range = o.from || o.to ? ` from ${o.from ?? "the start"} to ${o.to ?? "today"}` : "";
  const scope = `${inRange.length} saved conversation${inRange.length === 1 ? "" : "s"}${range}`;
  const damaged = unreadable ? `; ${unreadable} damaged file${unreadable === 1 ? "" : "s"} could not be read` : "";
  const words = (o.query ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));

  if (!words.length) {
    if (!inRange.length) return `No conversations${range}.`;
    const shown = inRange.slice(0, Math.max(limit, 20));
    const more = inRange.length - shown.length;
    return [
      `${scope}, newest first${more ? `; showing ${shown.length}, add words or narrow the dates to see the other ${more}` : ""}${damaged}:`,
      ...shown.map((c) => `- ${when(c)}: ${summaryText(c)}`),
    ].join("\n");
  }

  interface Hit { c: Conversation; at: string; said: string; reply: string; score: number }
  const hits: Hit[] = [];
  const need = Math.ceil(words.length / 2);
  for (const c of inRange) {
    c.turns.forEach((t, i) => {
      if (t.role !== "user") return;
      const next = c.turns.slice(i + 1).find((x) => x.role !== "event");
      const reply = next?.role === "assistant" ? next : undefined;
      const extra = reply ? actionsOf(reply).join(" ") : "";
      const hay = `${t.text}\n${reply?.text ?? ""}\n${extra}`.toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length;
      if (score >= need) hits.push({ c, at: t.at, said: t.text, reply: reply ? `${reply.text}${extra ? `\n(Done: ${extra})` : ""}` : "(no reply)", score });
    });
  }
  if (!hits.length) return `Nothing matching "${o.query}" in ${scope}${damaged}.`;
  hits.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
  const shown = hits.slice(0, limit);
  const convs = new Set(hits.map((h) => h.c.id)).size;
  return [
    `${hits.length} exchange${hits.length === 1 ? "" : "s"} matching "${o.query}" in ${convs} conversation${convs === 1 ? "" : "s"} (searched ${scope}${damaged}).` +
      (hits.length > shown.length ? ` Showing the best ${shown.length}; use more specific words or dates to see the rest.` : ""),
    ...shown.map((h) => {
      const { date, time } = localStamp(h.at);
      return `\n${date} ${weekday(date)} ${time}\nThey said: ${clip(h.said, 600)}\nYou replied: ${clip(h.reply, 1_200)}`;
    }),
  ].join("\n");
}

/** One model call: a few lines that describe a finished conversation. */
export async function summarizeConversation(c: Conversation, llm: { provider: LLMProvider; spec: ModelSpec }, now: Date = new Date()): Promise<Conversation["summary"]> {
  const t = transcript(c);
  const res = await llm.provider.chat({
    model: llm.spec.model,
    instructions: SUMMARY_PROMPT,
    context: "The conversation follows as the user message.",
    messages: [{ role: "user", content: t.text }],
    tools: [],
    effort: "low",
    maxTokens: 2_000,
  });
  const text = oneLine(res.text);
  if (!text) throw new Error("the model returned an empty summary");
  return { text: clip(text, 800), model: formatSpec(llm.spec), at: now.toISOString(), ...(t.partial ? { partial: true } : {}) };
}

/**
 * Summarise conversations that have ended and have no summary yet, newest
 * first. Short ones are recorded from their own words, with no model call.
 * A failure is noted and not retried for six hours.
 */
export async function summarizeEnded(
  store: Conversations,
  llm: { provider: LLMProvider; spec: ModelSpec } | null,
  o: { limit?: number; days?: number; now?: Date } = {},
): Promise<{ summarized: number; failed: number; waiting: number }> {
  const now = o.now ?? new Date();
  const limit = o.limit ?? 3;
  const since = addDays(todayISO(now), -(o.days ?? 30));
  const active = store.current().id;
  const retryAfter = now.getTime() - 6 * 3_600_000;
  const pending = store.list().conversations.filter(
    (c) => c.id !== active && spoke(c) && !c.summary && span(c).to >= since && !(c.summaryFailedAt && new Date(c.summaryFailedAt).getTime() > retryAfter),
  );

  let summarized = 0;
  let failed = 0;
  let modelCalls = 0;
  for (const c of pending) {
    if (transcript(c).text.length < TRIVIAL_CHARS) {
      c.summary = { text: digest(c), model: "rules", at: now.toISOString() };
      store.update(c);
      summarized++;
      continue;
    }
    if (!llm || modelCalls >= limit) continue;
    modelCalls++;
    try {
      c.summary = await summarizeConversation(c, llm, now);
      delete c.summaryFailedAt;
      summarized++;
    } catch {
      c.summaryFailedAt = now.toISOString();
      failed++;
    }
    store.update(c);
  }
  return { summarized, failed, waiting: pending.length - summarized - failed };
}
