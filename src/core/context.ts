/**
 * Assemble the exact slice of memory a request needs: identity, the ledger,
 * recent journal, the calendar for today and the coming days, reminders and notes, plus computed flags
 * (cadence due, silent, parked-for-review). One bundle, prompt-ready.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { DEFAULT_IDENTITY_CHARS, type Config } from "../config.js";
import { cadenceDueToday, daysIdle, describeCadence, isSilent, parkedDueForReview } from "../logic/cadence.js";
import { eventDays, eventsInRange, formatAgenda, formatEvent, type CalendarEvent, type CalendarProvider } from "../sensors/calendar.js";
import { addDays, longDate, todayISO, weekdayName } from "../util/dates.js";
import { STOP } from "../util/words.js";
import { Journal, type JournalEntry } from "./journal.js";
import { Ledger, findProject, normalizeStatus, type Project } from "./ledger.js";
import { Notes, type Note } from "./notes.js";
import { Reminders, reminderWhen, type Reminder } from "./reminders.js";

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
  /** What they said, so identity is loaded around it (see readIdentity). */
  query?: string;
}

const STORE_DIRS = new Set(["goals", "journal", "notes", "links", ".git", "node_modules", "assets"]);

export interface IdentityOptions {
  /** What is being asked, so the files it is about are loaded too. */
  query?: string;
  /** Rough size limit for the files that go into every message whatever is asked. */
  maxChars?: number;
  /** How much more the files a question is about may add on top. Half of maxChars by default. */
  focusChars?: number;
}

interface IdentityFile {
  /** Path relative to selfhub, which is how the model sees it. */
  name: string;
  text: string;
}

/** Every markdown file in selfhub that is not one of the stores, in path order. Empty files are left out. */
async function identityFiles(selfhubDir: string): Promise<IdentityFile[]> {
  const paths: string[] = [];
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
        paths.push(join(dir, e.name));
      }
    }
  }
  await walk(selfhubDir);
  paths.sort();
  const files: IdentityFile[] = [];
  for (const p of paths) {
    const text = (await readFile(p, "utf8")).trim();
    if (text) files.push({ name: relative(selfhubDir, p), text });
  }
  return files;
}

const size = (f: IdentityFile) => f.name.length + f.text.length + 8; // "### ", two newlines, the blank line between files

/** How many left-out files are named one by one, so the note itself stays short. */
const MAX_NAMED = 20;

/**
 * Who you are, from selfhub, within a size budget.
 *
 * All of this is in the prompt on every single message, so it cannot be all of selfhub: one long
 * working document kept in there would otherwise crowd out the short files that actually say who
 * you are. Two passes. The first takes files shortest first until the budget is spent, so the
 * short ones are always here and the same ones are here every time, whatever is asked. The second
 * spends a smaller allowance on the files this particular question is about — it only ever adds,
 * so asking about one project can't cost you your own profile. Nothing is cut in the middle: a
 * file is either here in full or named at the end as one you have but aren't looking at.
 */
export async function readIdentity(selfhubDir: string, o: IdentityOptions = {}): Promise<string> {
  const maxChars = o.maxChars ?? DEFAULT_IDENTITY_CHARS;
  const focusChars = o.focusChars ?? Math.round(maxChars / 2);
  const files = await identityFiles(selfhubDir);
  const chosen = new Set<string>();

  // Always here: the short files, which is what identity is made of.
  let used = 0;
  for (const f of [...files].sort((a, b) => size(a) - size(b) || a.name.localeCompare(b.name))) {
    if (chosen.size && used + size(f) > maxChars) continue; // too big for what's left; a shorter one may still fit
    chosen.add(f.name);
    used += size(f);
  }

  // Here because of what was asked: a word in the path is what a file is about, so any match on the
  // name outranks any number in the body ("my ML Guerilla writing style" has to reach
  // ml-guerilla/writing-style.md, not the nearest shorter file that happens to use those words).
  const words = [...new Set((o.query ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter((w) => w.length > 1 && !STOP.has(w));
  if (words.length) {
    const score = (f: IdentityFile) => {
      const name = f.name.toLowerCase();
      const body = f.text.toLowerCase();
      return words.filter((w) => name.includes(w)).length * (words.length + 1) + words.filter((w) => body.includes(w)).length;
    };
    const asked = files
      .filter((f) => !chosen.has(f.name))
      .map((f) => ({ f, score: score(f) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || size(a.f) - size(b.f) || a.f.name.localeCompare(b.f.name));
    let extra = 0;
    let first = true;
    for (const { f } of asked) {
      // The best match gets in even when it alone is more than the allowance — it is the file the
      // question is about — as long as no one file outweighs everything that is always here.
      const room = first && size(f) <= maxChars ? Math.max(focusChars, size(f)) : focusChars;
      if (extra + size(f) > room) continue;
      chosen.add(f.name);
      extra += size(f);
      first = false;
    }
  }

  // Written back in path order: the same files always read the same way.
  const parts = files.filter((f) => chosen.has(f.name)).map((f) => `### ${f.name}\n${f.text}`);
  const left = files.filter((f) => !chosen.has(f.name));
  if (left.length) {
    const named = left.slice(0, MAX_NAMED);
    const rest = left.length - named.length;
    parts.push(
      `### not loaded\nYou also have ${left.length} file${left.length === 1 ? "" : "s"} in selfhub that ${left.length === 1 ? "is" : "are"} not in this memory, because everything here is in every message: ` +
        `${named.map((f) => `${f.name} (${Math.round(size(f) / 1_000)}k)`).join(", ")}${rest ? `, and ${rest} more` : ""}. ` +
        `Say so rather than guessing at what ${left.length === 1 ? "it says" : "they say"}.`,
    );
  }
  return parts.join("\n\n");
}

export async function buildContext(opts: ContextOptions): Promise<ContextBundle> {
  const { config, intent } = opts;
  const today = opts.today ?? todayISO();
  const dir = config.selfhubDir;
  const [identity, projects, journal, cal, remindersDue, remindersUpcoming, notes] = await Promise.all([
    readIdentity(dir, { query: opts.query, maxChars: config.identityChars }),
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
  if (ctx.remindersDue.length) rem.push("Due now:\n" + ctx.remindersDue.map((r) => `- ${reminderWhen(r)} · ${r.text}`).join("\n"));
  if (ctx.remindersUpcoming.length) rem.push("Next 7 days:\n" + ctx.remindersUpcoming.map((r) => `- ${reminderWhen(r)} · ${r.text}`).join("\n"));
  out.push(`# Reminders\n${rem.length ? rem.join("\n") : "None."}`);

  out.push(
    `# Journal (recent days)\n` +
      (ctx.journal.length ? ctx.journal.map((e) => e.text).join("\n\n") : "No entries yet."),
  );

  if (ctx.notes.length) out.push(`# Recent notes\n${ctx.notes.map((n) => `- ${n.date} · ${n.text}`).join("\n")}`);

  return out.join("\n\n");
}
