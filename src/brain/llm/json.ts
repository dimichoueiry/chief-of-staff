/**
 * Not every model can be held to a JSON schema, so the brief is parsed
 * leniently (bare, fenced, or wrapped in prose) and normalised to the Brief shape.
 */
import type { Brief } from "../schema.js";

export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* try harder */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error("no JSON object in the response");
}

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];

export function normalizeBrief(raw: unknown, fallback: Pick<Brief, "greeting" | "date" | "headline">): Brief {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    greeting: str(o.greeting, fallback.greeting) || fallback.greeting,
    date: str(o.date, fallback.date) || fallback.date,
    headline: str(o.headline, fallback.headline) || fallback.headline,
    focus: arr(o.focus)
      .map((f) => ({ title: str(f.title), project: str(f.project), why: str(f.why), size: str(f.size, "1 hour") || "1 hour", when: str(f.when) }))
      .filter((f) => f.title)
      .slice(0, 3),
    schedule: arr(o.schedule).map((s) => ({ start: str(s.start), end: str(s.end), title: str(s.title), free: s.free === true, plan: str(s.plan) })),
    decisions: arr(o.decisions)
      .map((d) => ({
        project: str(d.project),
        question: str(d.question),
        options: Array.isArray(d.options) ? d.options.map(String) : ["keep", "park", "kill"],
        reason: str(d.reason),
      }))
      .filter((d) => d.question),
    reminders: arr(o.reminders).map((r) => ({ date: str(r.date), text: str(r.text), overdue: r.overdue === true })).filter((r) => r.text),
    nudges: Array.isArray(o.nudges) ? o.nudges.filter((n): n is string => typeof n === "string" && Boolean(n.trim())) : [],
  };
}
