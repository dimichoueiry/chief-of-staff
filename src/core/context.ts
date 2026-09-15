/**
 * Assemble the exact slice of memory a request needs: identity, the ledger,
 * recent journal, the calendar for today and the coming days, reminders and notes, plus computed flags
 * (cadence due, silent, parked-for-review). One bundle, prompt-ready.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Config } from "../config.js";
import { cadenceDueToday, daysIdle, describeCadence, isSilent, parkedDueForReview } from "../logic/cadence.js";
import { eventDays, eventsInRange, formatAgenda, formatEvent, type CalendarEvent, type CalendarProvider } from "../sensors/calendar.js";
import { addDays, longDate, todayISO, weekdayName } from "../util/dates.js";
import { Journal, type JournalEntry } from "./journal.js";
import { Ledger, findProject, normalizeStatus, type Project } from "./ledger.js";
import { Notes, type Note } from "./notes.js";
import { Reminders, type Reminder } from "./reminders.js";

export type Intent = "brief" | "ask" | "focus" | "capture" | "wrap" | "silence-check";

export interface ContextBundle {
  intent: Intent;
  today: string;
  weekday: string;
  name: string;
  identity: string;
  projects: Project[];
  journal: JournalEntry[];
  /** Events touching today. */
  calendar: CalendarEvent[];
  /** Events on the days after today, through upcomingThrough. */
  upcoming: CalendarEvent[];
  upcomingThrough: string;
  calendarProvider: string;
  calendarError?: string;
  remindersDue: Reminder[];
  remindersUpcoming: Reminder[];
  notes: Note[];
  focusProject?: Project;
  flags: { cadenceDue: string[]; silent: string[]; parkedReview: string[] };
}

export interface ContextOptions {
  config: Config;
  intent: Intent;
  project?: string;
  today?: string;
  calendarProvider?: CalendarProvider;
}

const STORE_DIRS = new Set(["goals", "journal", "notes", ".git", "node_modules", "assets"]);

/** Every markdown file in selfhub that is not one of the stores: who you are. */
export async function readIdentity(selfhubDir: string): Promise<string> {
  const files: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!STORE_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(join(dir, e.name));
      } else if (e.name.endsWith(".md") && !(dir === selfhubDir && e.name.toLowerCase() === "readme.md")) {
        files.push(join(dir, e.name));
      }
    }
  }
  await walk(selfhubDir);
  files.sort();
  const parts: string[] = [];
  for (const f of files) {
    const text = (await readFile(f, "utf8")).trim();
    if (text) parts.push(`### ${relative(selfhubDir, f)}\n${text}`);
  }
  return parts.join("\n\n");
}

export async function buildContext(opts: ContextOptions): Promise<ContextBundle> {
  const { config, intent } = opts;
  const today = opts.today ?? todayISO();
  const dir = config.selfhubDir;
  const [identity, projects, journal, cal, remindersDue, remindersUpcoming, notes] = await Promise.all([
    readIdentity(dir),
    new Ledger(dir).read(),
    new Journal(dir).entries(config.journalDays, today),
    eventsInRange(today, addDays(today, config.calendarDays - 1), opts.calendarProvider),
    new Reminders(dir).due(today),
    new Reminders(dir).upcoming(7, today),
    new Notes(dir).recent(config.journalDays, today),
  ]);
  return {
    intent,
    today,
    weekday: weekdayName(today),
    name: config.name,
    identity,
    projects,
    journal,
    calendar: cal.events.filter((e) => eventDays(e, today, today).length > 0),
    upcoming: cal.events.filter((e) => eventDays(e, addDays(today, 1), addDays(today, config.calendarDays - 1)).length > 0),
    upcomingThrough: addDays(today, config.calendarDays - 1),
    calendarProvider: cal.provider,
    calendarError: cal.error,
    remindersDue,
    remindersUpcoming,
    notes,
    focusProject: opts.project ? findProject(projects, opts.project) : undefined,
    flags: {
      cadenceDue: projects.filter((p) => cadenceDueToday(p, today)).map((p) => p.name),
      silent: projects.filter((p) => isSilent(p, today, config.silenceDays)).map((p) => p.name),
      parkedReview: projects.filter((p) => parkedDueForReview(p, today)).map((p) => p.name),
    },
  };
}

const STATUS_ORDER: Record<string, number> = { active: 0, parked: 1, done: 2, killed: 3 };

export function renderProject(p: Project, ctx: Pick<ContextBundle, "today" | "flags">): string {
  const status = normalizeStatus(p.status);
  const idle = daysIdle(p, ctx.today);
  const lines = [`## ${p.name} — ${status}`];
  if (p.why) lines.push(`- why: ${p.why}`);
  const cadence = describeCadence(p);
  if (cadence) lines.push(`- cadence: ${cadence}${ctx.flags.cadenceDue.includes(p.name) ? "  ← DUE TODAY" : ""}`);
  if (p.skipUntil && p.skipUntil > ctx.today) lines.push(`- cadence skipped until ${p.skipUntil}`);
  if (p.next) lines.push(`- next: ${p.next}`);
  lines.push(
    `- last touched: ${p.lastTouched ?? "never"}` +
      (idle !== null ? ` (${idle} day${idle === 1 ? "" : "s"} idle)` : "") +
      (ctx.flags.silent.includes(p.name) ? "  ← SILENT" : "") +
      (ctx.flags.parkedReview.includes(p.name) ? "  ← parked, due for review" : ""),
  );
  if (p.deadline && p.deadline !== "none") lines.push(`- deadline: ${p.deadline}`);
  if (p.notes) lines.push(`- notes: ${p.notes}`);
  if (p.path) lines.push(`- path: ${p.path}`);
  lines.push(...p.extra);
  return lines.join("\n");
}

/** The memory block that goes into the system prompt. Nothing is truncated. */
export function renderContext(ctx: ContextBundle): string {
  const out: string[] = [];
  out.push(`# Today\n${longDate(ctx.today)} (${ctx.today}).${ctx.name ? ` The user's name is ${ctx.name}.` : ""}`);

  if (ctx.identity) out.push(`# Identity (from selfhub)\n${ctx.identity}`);

  const visible = ctx.projects
    .filter((p) => ["active", "parked"].includes(normalizeStatus(p.status)))
    .sort((a, b) => STATUS_ORDER[normalizeStatus(a.status)] - STATUS_ORDER[normalizeStatus(b.status)]);
  const hidden = ctx.projects.length - visible.length;
  out.push(
    `# Commitments ledger\n` +
      (visible.length ? visible.map((p) => renderProject(p, ctx)).join("\n\n") : "(empty — no projects yet)") +
      (hidden ? `\n\n(${hidden} done/killed project${hidden === 1 ? "" : "s"} omitted)` : ""),
  );

  if (ctx.focusProject) out.push(`# Focus project\n${ctx.focusProject.name}`);

  let cal = `# Calendar for today (source: ${ctx.calendarProvider})\n`;
  if (ctx.calendarError) cal += `Calendar unavailable: ${ctx.calendarError}. Assume the day is free.`;
  else if (!ctx.calendar.length) cal += "No events. The day is free.";
  else cal += ctx.calendar.map(formatEvent).join("\n");
  out.push(cal);

  if (!ctx.calendarError && ctx.upcomingThrough > ctx.today) {
    const tomorrow = addDays(ctx.today, 1);
    out.push(
      `# Calendar, coming days (${tomorrow} to ${ctx.upcomingThrough})\n` +
        (ctx.upcoming.length ? formatAgenda(ctx.upcoming, tomorrow, ctx.upcomingThrough) : "No events.") +
        "\nFor dates outside this window, use the get_calendar tool when you have it.",
    );
  }

  const rem: string[] = [];
  if (ctx.remindersDue.length) rem.push("Due now:\n" + ctx.remindersDue.map((r) => `- ${r.date} · ${r.text}`).join("\n"));
  if (ctx.remindersUpcoming.length) rem.push("Next 7 days:\n" + ctx.remindersUpcoming.map((r) => `- ${r.date} · ${r.text}`).join("\n"));
  out.push(`# Reminders\n${rem.length ? rem.join("\n") : "None."}`);

  out.push(
    `# Journal (recent days)\n` +
      (ctx.journal.length ? ctx.journal.map((e) => e.text).join("\n\n") : "No entries yet."),
  );

  if (ctx.notes.length) out.push(`# Recent notes\n${ctx.notes.map((n) => `- ${n.date} · ${n.text}`).join("\n")}`);

  return out.join("\n\n");
}
