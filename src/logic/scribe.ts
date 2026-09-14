/**
 * Offline Scribe: files a sentence without a model, for the handful of shapes
 * that are unambiguous. Anything else becomes a note (never lost) and, when a
 * model is available, the caller uses the capture intent instead.
 */
import { Journal } from "../core/journal.js";
import { Ledger, findProject } from "../core/ledger.js";
import { Notes } from "../core/notes.js";
import { Reminders } from "../core/reminders.js";
import { WEEKDAYS, addDays, isISODate, parseISO, todayISO } from "../util/dates.js";

export interface Filed {
  where: "ledger" | "reminder" | "journal" | "note";
  message: string;
  /** For a new project with no why, the follow-up question. */
  question?: string;
}

/** "friday", "tomorrow", "next monday", "2026-09-19", "sept 19" -> YYYY-MM-DD */
export function resolveDate(text: string, today: string = todayISO()): string | null {
  const t = text.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) && isISODate(t)) return t;
  if (t === "today") return today;
  if (t === "tomorrow") return addDays(today, 1);
  const isNext = t.startsWith("next ");
  const dayName = t.replace(/^next\s+/, "");
  const day = WEEKDAYS.findIndex((d) => dayName === d.toLowerCase() || dayName === d.slice(0, 3).toLowerCase());
  if (day >= 0) {
    const cur = parseISO(today).getDay();
    let delta = (day - cur + 7) % 7;
    if (delta === 0) delta = 7; // the same weekday means next week's
    if (isNext && delta < 7) delta += 7; // "next monday" skips this week's monday
    return addDays(today, delta);
  }
  const md = /^([a-z]{3,9})\.?\s+(\d{1,2})$/.exec(t);
  if (md) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(md[1].slice(0, 3));
    if (month >= 0) {
      const y = parseISO(today).getFullYear();
      const candidate = `${y}-${String(month + 1).padStart(2, "0")}-${String(Number(md[2])).padStart(2, "0")}`;
      return candidate < today ? `${y + 1}${candidate.slice(4)}` : candidate;
    }
  }
  return null;
}

export async function scribe(selfhubDir: string, sentence: string, today: string = todayISO()): Promise<Filed> {
  const s = sentence.trim();
  const ledger = new Ledger(selfhubDir);

  // remind me <when> to <text>  |  remind me to <text> on <when>
  let m = /^remind(?:er)?(?: me)?\s+(?:on\s+|by\s+)?(.+?)\s+(?:to|about|that)\s+(.+)$/i.exec(s);
  if (m) {
    const date = resolveDate(m[1], today);
    if (date) {
      await new Reminders(selfhubDir).add(date, m[2]);
      return { where: "reminder", message: `Reminder set for ${date}: ${m[2]}` };
    }
  }
  m = /^remind(?:er)?(?: me)?\s+(?:to|about)\s+(.+?)\s+(?:on|by)\s+(.+)$/i.exec(s);
  if (m) {
    const date = resolveDate(m[2], today);
    if (date) {
      await new Reminders(selfhubDir).add(date, m[1]);
      return { where: "reminder", message: `Reminder set for ${date}: ${m[1]}` };
    }
  }

  // starting a project: <name>, it's for <why>   |  new project <name>
  m = /^(?:starting|start|new)\s+(?:a\s+)?project(?::|\s+called|\s+named)?\s+(.+?)(?:[,.;]\s*(?:it'?s\s+for|for|because|why:?)\s+(.+))?$/i.exec(s);
  if (m) {
    const name = m[1].trim().replace(/^["']|["']$/g, "");
    const why = m[2]?.trim();
    const { created } = await ledger.writeProject(name, { why, status: "active" });
    return {
      where: "ledger",
      message: `${created ? "Created" : "Updated"} project "${name}"${why ? ` (why: ${why})` : ""}.`,
      question: why ? undefined : `What is "${name}" for? Tell me and I'll save the why.`,
    };
  }

  // park <project> | kill <project> | done with <project> | finished <project>
  m = /^(park|kill|finish(?:ed)?|done with|complete[d]?)\s+(.+?)(?:\s+for now)?$/i.exec(s);
  if (m) {
    const projects = await ledger.read();
    const p = findProject(projects, m[2]);
    if (p) {
      const verb = m[1].toLowerCase();
      const status = verb === "park" ? "parked" : verb === "kill" ? "killed" : "done";
      await ledger.writeProject(p.name, { status, lastTouched: today }, `cos: ${status} "${p.name}"`);
      return { where: "ledger", message: `${p.name} → ${status}.` };
    }
  }

  // <project> every <cadence>  |  <project> next: <action>
  m = /^(.+?)\s+every\s+(.+)$/i.exec(s);
  if (m) {
    const p = findProject(await ledger.read(), m[1]);
    if (p) {
      await ledger.writeProject(p.name, { cadence: m[2].trim() });
      return { where: "ledger", message: `${p.name}: cadence set to "${m[2].trim()}".` };
    }
  }
  m = /^(.+?)\s*(?:next|next step|next action)\s*:\s*(.+)$/i.exec(s);
  if (m) {
    const p = findProject(await ledger.read(), m[1]);
    if (p) {
      await ledger.writeProject(p.name, { next: m[2].trim(), lastTouched: today });
      return { where: "ledger", message: `${p.name}: next → ${m[2].trim()}.` };
    }
  }

  // journal-shaped: "touched X", "worked on X", "today I ..."
  if (/^(touched|worked on|today i|did|finished the|shipped)\b/i.test(s)) {
    await new Journal(selfhubDir).append(today, s);
    return { where: "journal", message: `Logged to today's journal.` };
  }

  await new Notes(selfhubDir).add(s, today);
  return { where: "note", message: "Kept in the inbox." };
}
