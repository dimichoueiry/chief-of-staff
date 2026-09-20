/**
 * Memory across conversations. When a conversation ends, a model writes a few
 * lines about it (what was discussed, decided, filed, left open). The summaries
 * of the last days go into every request, and get_conversations searches every
 * saved conversation for the details a summary leaves out.
 *
 * What goes into every request is built from the store's index (see metas in
 * conversation.ts), never from the transcripts: a message costs a stat per chat,
 * not a parse of everything ever said. Only searching by keyword and finding a
 * chat by name read the conversations themselves, and only when asked.
 */
import type { ModelSpec } from "./llm/registry.js";
import type { LLMProvider } from "./llm/types.js";
import { Conversations, digest, displayTitle, localStamp, type Conversation, type ConversationMeta, type Turn } from "./conversation.js";
import { formatSpec } from "./llm/registry.js";
import { ACTIONS, WRITES } from "./tools.js";
import { addDays, todayISO } from "../util/dates.js";
import { STOP } from "../util/words.js";

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

/** Local dates a conversation touches. Its timestamps are all this needs, so it works on an index entry too. */
type Dated = Pick<Conversation, "startedAt" | "updatedAt">;

function span(c: Dated): { from: string; to: string } {
  return { from: localStamp(c.startedAt).date, to: localStamp(c.updatedAt).date };
}

function when(c: Dated): string {
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
      if (!r.isError && (WRITES.includes(name) || ACTIONS.includes(name))) out.push(oneLine(clip(r.content, 200)));
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

export { chatPreview, digest } from "./conversation.js";

/** What a conversation is remembered as: the model's summary, or its own words. Works from the index alone. */
export function summaryText(c: Conversation | ConversationMeta): string {
  if (!c.summary) return "digest" in c ? c.digest : digest(c);
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
  const recent = store.metas().metas.filter((c) => c.id !== o.excludeId && c.messages > 0 && span(c).to >= since);
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

/** Search every saved conversation. Results are capped for the model; the counts are not. */
export function searchConversations(store: Conversations, o: SearchOptions = {}): string {
  const limit = o.limit ?? 8;
  // The dates and the counts come from the index; only a search by keyword reads what was said, and
  // then only in the conversations the dates left in.
  const { metas, unreadable } = store.metas();
  const inRange = metas.filter((c) => c.messages > 0 && (!o.from || span(c).to >= o.from) && (!o.to || span(c).from <= o.to));
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

  interface Hit { id: string; at: string; said: string; reply: string; score: number }
  const hits: Hit[] = [];
  const need = Math.ceil(words.length / 2);
  for (const m of inRange) {
    const c = store.get(m.id);
    if (!c) continue; // deleted while this was running
    c.turns.forEach((t, i) => {
      if (t.role !== "user") return;
      const next = c.turns.slice(i + 1).find((x) => x.role !== "event");
      const reply = next?.role === "assistant" ? next : undefined;
      const extra = reply ? actionsOf(reply).join(" ") : "";
      const hay = `${t.text}\n${reply?.text ?? ""}\n${extra}`.toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length;
      if (score >= need) hits.push({ id: c.id, at: t.at, said: t.text, reply: reply ? `${reply.text}${extra ? `\n(Done: ${extra})` : ""}` : "(no reply)", score });
    });
  }
  if (!hits.length) return `Nothing matching "${o.query}" in ${scope}${damaged}.`;
  hits.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
  const shown = hits.slice(0, limit);
  const convs = new Set(hits.map((h) => h.id)).size;
  return [
    `${hits.length} exchange${hits.length === 1 ? "" : "s"} matching "${o.query}" in ${convs} conversation${convs === 1 ? "" : "s"} (searched ${scope}${damaged}).` +
      (hits.length > shown.length ? ` Showing the best ${shown.length}; use more specific words or dates to see the rest.` : ""),
    ...shown.map((h) => {
      const { date, time } = localStamp(h.at);
      return `\n${date} ${weekday(date)} ${time}\nThey said: ${clip(h.said, 600)}\nYou replied: ${clip(h.reply, 1_200)}`;
    }),
  ].join("\n");
}

const CHAT_WORDS = new Set(["chat", "chats", "conversation", "conversations", "thread", "called", "named", "where", "from", "our"]);
const PREVIOUS = /^(?:(?:the|my|our)\s+)?(?:last|previous|other|earlier|old)(?:\s+(?:one|chat|conversation|thread))?$/i;
const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
const numerals = (s: string) => s.toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => NUMBER_WORDS[w]);

/**
 * The saved chat someone means by a few words ("module six", "the Campuswire one", "the last one"):
 * every word has to appear in its name or anywhere in what was said; matches in the name rank first,
 * then the most recently active. Searches every saved conversation in full. Null when none fits.
 */
export function findConversation(store: Conversations, query: string, o: { excludeId?: string } = {}): Conversation | null {
  // The only thing here that reads every transcript. It has to: a word that isn't in a chat's name
  // may still be somewhere in it. It runs when someone asks for a chat by name, not on every message.
  const chats = store.list().conversations.filter((c) => c.turns.some((t) => t.role === "user") && c.id !== o.excludeId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (PREVIOUS.test(query.trim())) return chats[0] ?? null;
  // "the Campuswire one": a trailing "one" means the chat, not the number.
  const words = numerals(query.trim().replace(/(\S)\s+one$/i, "$1"))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w) && !CHAT_WORDS.has(w));
  if (!words.length) return null;
  // Words match from the start of a word: "campus" finds "Campuswire", "6" doesn't find "2026".
  const patterns = words.map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w}`, "u"));
  let best: { c: Conversation; inName: number } | null = null;
  for (const c of chats) {
    const name = numerals(displayTitle(c));
    const said = numerals([c.summary?.text ?? "", ...c.turns.map((t) => t.text)].join("\n"));
    if (!patterns.every((p) => p.test(name) || p.test(said))) continue;
    const inName = patterns.filter((p) => p.test(name)).length;
    if (!best || inName > best.inName) best = { c, inName }; // ties keep the more recent one
  }
  return best?.c ?? null;
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
  // The one in progress hasn't ended; nor has the one an aside was stepped out of.
  const current = store.current();
  const active = [current.id, current.asideOf];
  const retryAfter = now.getTime() - 6 * 3_600_000;
  // Which conversations still need one is decided from the index; only those are read.
  const pending = store.metas().metas.filter(
    (c) => !active.includes(c.id) && c.messages > 0 && !c.summary && span(c).to >= since && !(c.summaryFailedAt && new Date(c.summaryFailedAt).getTime() > retryAfter),
  );

  let summarized = 0;
  let failed = 0;
  let modelCalls = 0;
  // Saved onto the conversation as it is now, and only if nothing was said in it meanwhile (it can be picked up again).
  const save = (c: Conversation, change: (fresh: Conversation) => void) =>
    store.patch(c.id, (fresh) => {
      if (fresh.updatedAt === c.updatedAt) change(fresh);
    });

  for (const m of pending) {
    const c = store.get(m.id);
    if (!c) continue; // deleted since the index was read: still waiting, not failed
    if (transcript(c).text.length < TRIVIAL_CHARS) {
      const summary = { text: digest(c), model: "rules", at: now.toISOString() };
      save(c, (fresh) => (fresh.summary = summary));
      summarized++;
      continue;
    }
    if (!llm || modelCalls >= limit) continue;
    modelCalls++;
    try {
      const summary = await summarizeConversation(c, llm, now);
      save(c, (fresh) => {
        fresh.summary = summary;
        delete fresh.summaryFailedAt;
      });
      summarized++;
    } catch {
      save(c, (fresh) => (fresh.summaryFailedAt = now.toISOString()));
      failed++;
    }
  }
  return { summarized, failed, waiting: pending.length - summarized - failed };
}

const TITLE_PROMPT = `Name this conversation for the user's list of chats, so they can find it again: 2 to 5 words, like "Module 6 review" or "Campuswire favorites access". Name the main topic, not greetings or small talk. Plain text only: no quotes, no trailing period.`;

/** Their first few messages are when a chat's topic becomes clear; after that the name stays. */
const TITLE_UNTIL_MESSAGES = 3;

/**
 * Give chats a short name from what was said so far, while they're new: after
 * their first, second and third message. A name they gave is never replaced.
 */
export async function nameConversations(
  store: Conversations,
  llm: { provider: LLMProvider; spec: ModelSpec } | null,
  o: { limit?: number; days?: number; now?: Date } = {},
): Promise<{ named: number; failed: number }> {
  if (!llm) return { named: 0, failed: 0 };
  const now = o.now ?? new Date();
  const since = addDays(todayISO(now), -(o.days ?? 30));
  const retryAfter = now.getTime() - 6 * 3_600_000;
  // Which chats are due is decided from the index; only the few that are get read.
  const due = store.metas().metas.filter((c) => {
    const seen = c.autoTitleMessages ?? 0;
    return !c.title && c.messages > seen && seen < TITLE_UNTIL_MESSAGES && span(c).to >= since && c.replied &&
      !(c.titleFailedAt && new Date(c.titleFailedAt).getTime() > retryAfter);
  });
  let named = 0;
  let failed = 0;
  for (const m of due.slice(0, o.limit ?? 3)) {
    const c = store.get(m.id);
    if (!c) continue; // deleted since the index was read
    const said = m.messages;
    try {
      const res = await llm.provider.chat({
        model: llm.spec.model,
        instructions: TITLE_PROMPT,
        context: "The conversation follows as the user message.",
        messages: [{ role: "user", content: transcript(c).text }],
        tools: [],
        effort: "low",
        maxTokens: 400,
      });
      const title = clip(oneLine(res.text).replace(/^["“'`]+|["”'`.]+$/g, ""), 60);
      if (!title) throw new Error("empty title");
      store.patch(c.id, (fresh) => {
        if (fresh.title) return;
        fresh.autoTitle = title;
        fresh.autoTitleMessages = said;
        delete fresh.titleFailedAt;
      });
      named++;
    } catch {
      store.patch(c.id, (fresh) => (fresh.titleFailedAt = now.toISOString()));
      failed++;
    }
  }
  return { named, failed };
}
