/** The shape of a morning brief. Produced by the model (structured output) or by the rule-based builder. */

export interface FocusItem {
  title: string;
  project: string;
  why: string;
  /** "30 min" | "1 hour" | "half day" | "multi-day" */
  size: string;
  /** Suggested slot, e.g. "14:00–16:00", or "" */
  when: string;
}

export interface ScheduleItem {
  start: string; // HH:MM
  end: string; // HH:MM
  title: string;
  free: boolean;
  /** For free blocks: what the plan puts there, or "" */
  plan: string;
}

export interface Decision {
  project: string;
  question: string;
  options: string[];
  reason: string;
}

export interface BriefReminder {
  date: string;
  text: string;
  overdue: boolean;
}

export interface UpcomingItem {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM or "all day"
  title: string;
}

export interface Brief {
  greeting: string;
  date: string;
  headline: string;
  focus: FocusItem[];
  schedule: ScheduleItem[];
  decisions: Decision[];
  reminders: BriefReminder[];
  /** Notable events in the coming days. */
  upcoming: UpcomingItem[];
  nudges: string[];
}

const str = { type: "string" } as const;
const bool = { type: "boolean" } as const;

export const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["greeting", "date", "headline", "focus", "schedule", "decisions", "reminders", "upcoming", "nudges"],
  properties: {
    greeting: str,
    date: str,
    headline: str,
    focus: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "project", "why", "size", "when"],
        properties: { title: str, project: str, why: str, size: str, when: str },
      },
    },
    schedule: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "title", "free", "plan"],
        properties: { start: str, end: str, title: str, free: bool, plan: str },
      },
    },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["project", "question", "options", "reason"],
        properties: { project: str, question: str, options: { type: "array", items: str }, reason: str },
      },
    },
    reminders: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "text", "overdue"],
        properties: { date: str, text: str, overdue: bool },
      },
    },
    upcoming: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "time", "title"],
        properties: { date: str, time: str, title: str },
      },
    },
    nudges: { type: "array", items: str },
  },
} as const;
