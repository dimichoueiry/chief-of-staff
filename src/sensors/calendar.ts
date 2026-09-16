/**
 * Read-only calendar sensor. We never build a calendar; we read the one macOS
 * already aggregates, for any date range. Providers, tried in order unless
 * COS_CALENDAR pins one:
 *   - icalbuddy  (if the `icalBuddy` CLI is installed)
 *   - eventkit   (a tiny Swift helper compiled on first use with swiftc)
 *   - none       (no events)
 */
import { execFile } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { swiftFlags } from "../util/swift.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { addDays, daysBetween, isISODate, parseISO, todayISO } from "../util/dates.js";

const exec = promisify(execFile);

export interface CalendarEvent {
  title: string;
  /** ISO 8601 datetime; for all-day events, midnight local. */
  start: string;
  end: string;
  allDay: boolean;
  calendar?: string;
  location?: string;
}

export interface CalendarProvider {
  name: string;
  available(): Promise<boolean>;
  /** Events overlapping FROM..TO, both YYYY-MM-DD and inclusive. */
  eventsBetween(fromISO: string, toISO: string): Promise<CalendarEvent[]>;
}

/** Longest range one lookup may cover. */
export const MAX_RANGE_DAYS = 366;

// ---------- icalBuddy ----------

const ICALBUDDY_ARGS = [
  "-nc", "-nrd", "-npn", "-ea",
  "-iep", "title,datetime", "-po", "datetime,title",
  "-ps", "| · |", "-df", "%Y-%m-%d", "-tf", "%H:%M", "-b", "",
];

/** Parse lines like `2026-09-14 at 10:00 - 10:30 · Standup` or `2026-09-14 · Holiday`, keeping those inside FROM..TO. */
export function parseIcalBuddy(output: string, fromISO: string, toISO: string = fromISO): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const re = /^(\d{4}-\d{2}-\d{2})(?:\s+at\s+(\d{2}:\d{2}))?(?:\s*-\s*(?:(\d{4}-\d{2}-\d{2})\s+at\s+)?(\d{2}:\d{2}))?\s*·\s*(.+?)\s*$/;
  for (const raw of output.split(/\r?\n/)) {
    const m = re.exec(raw.trim());
    if (!m) continue;
    const [, date, startT, endDate, endT, title] = m;
    if (date < fromISO || date > toISO) continue;
    if (!startT) {
      events.push({ title, start: `${date}T00:00:00`, end: `${date}T23:59:59`, allDay: true });
    } else {
      events.push({ title, start: `${date}T${startT}:00`, end: `${endDate ?? date}T${endT ?? startT}:00`, allDay: false });
    }
  }
  return events;
}

export const icalBuddyProvider: CalendarProvider = {
  name: "icalbuddy",
  async available() {
    try {
      await exec("which", ["icalBuddy"]);
      return true;
    } catch {
      return false;
    }
  },
  async eventsBetween(fromISO, toISO) {
    const { stdout } = await exec("icalBuddy", [...ICALBUDDY_ARGS, `eventsFrom:${fromISO}`, `to:${toISO}`], { maxBuffer: 16 * 1024 * 1024 });
    return parseIcalBuddy(stdout, fromISO, toISO);
  },
};

// ---------- EventKit (Swift helper) ----------

const here = dirname(fileURLToPath(import.meta.url));
const HELPER_SRC = join(here, "eventkit", "cos-calendar.swift");
const HELPER_PLIST = join(here, "eventkit", "Info.plist");
export const HELPER_BIN = join(homedir(), ".cos", "bin", "cos-calendar");

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Compile the Swift helper if it is missing or older than its source. */
export async function ensureEventKitHelper(bin: string = HELPER_BIN): Promise<string> {
  const [srcStat, binStat] = await Promise.all([stat(HELPER_SRC), stat(bin).catch(() => null)]);
  if (binStat && binStat.mtimeMs >= srcStat.mtimeMs) return bin;
  await mkdir(dirname(bin), { recursive: true });
  await exec("swiftc", [
    ...swiftFlags(), "-o", bin, HELPER_SRC,
    "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", HELPER_PLIST,
  ]);
  return bin;
}

export function parseEventKit(json: string): CalendarEvent[] {
  const rows = JSON.parse(json) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    title: String(r.title ?? ""),
    start: String(r.start),
    end: String(r.end),
    allDay: Boolean(r.allDay),
    calendar: r.calendar ? String(r.calendar) : undefined,
    location: r.location ? String(r.location) : undefined,
  }));
}

export const eventKitProvider: CalendarProvider = {
  name: "eventkit",
  async available() {
    if (process.platform !== "darwin") return false;
    if (await exists(HELPER_BIN)) return true;
    try {
      await exec("which", ["swiftc"]);
      return true;
    } catch {
      return false;
    }
  },
  async eventsBetween(fromISO, toISO) {
    const bin = await ensureEventKitHelper();
    const { stdout } = await exec(bin, [fromISO, toISO], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    return parseEventKit(stdout);
  },
};

export const noneProvider: CalendarProvider = {
  name: "none",
  available: async () => true,
  eventsBetween: async () => [],
};

// ---------- selection ----------

export const PROVIDERS: Record<string, CalendarProvider> = {
  icalbuddy: icalBuddyProvider,
  eventkit: eventKitProvider,
  none: noneProvider,
};

export async function pickProvider(
  pinned: string | undefined = process.env.COS_CALENDAR,
  order: CalendarProvider[] = [icalBuddyProvider, eventKitProvider, noneProvider],
): Promise<CalendarProvider> {
  if (pinned && pinned !== "auto") {
    const p = PROVIDERS[pinned.toLowerCase()];
    if (!p) throw new Error(`Unknown COS_CALENDAR provider "${pinned}" (icalbuddy | eventkit | none)`);
    return p;
  }
  for (const p of order) if (await p.available()) return p;
  return noneProvider;
}

export interface CalendarRead {
  events: CalendarEvent[];
  provider: string;
  error?: string;
}

/** Events between two dates (inclusive) through the best available provider. Never throws: a broken provider means "no events" plus an error. */
export async function eventsInRange(fromISO: string, toISO: string, provider?: CalendarProvider): Promise<CalendarRead> {
  if (!isISODate(fromISO) || !isISODate(toISO)) return { events: [], provider: provider?.name ?? "none", error: "dates must be YYYY-MM-DD" };
  if (toISO < fromISO) return { events: [], provider: provider?.name ?? "none", error: "the end date is before the start date" };
  if (daysBetween(fromISO, toISO) >= MAX_RANGE_DAYS) {
    return { events: [], provider: provider?.name ?? "none", error: `ranges are limited to ${MAX_RANGE_DAYS} days` };
  }
  const p = provider ?? (await pickProvider());
  try {
    const events = await p.eventsBetween(fromISO, toISO);
    events.sort((a, b) => a.start.localeCompare(b.start));
    return { events, provider: p.name };
  } catch (err) {
    return { events: [], provider: p.name, error: (err as Error).message };
  }
}

/** One day's events. */
export function todayEvents(dateISO: string = todayISO(), provider?: CalendarProvider): Promise<CalendarRead> {
  return eventsInRange(dateISO, dateISO, provider);
}

// ---------- formatting ----------

/** Local calendar date (YYYY-MM-DD) an event starts on. Datetimes without an offset are already local. */
export function eventDate(e: CalendarEvent): string {
  return todayISO(new Date(e.start));
}

/** Local date of an event's last moment (ends are exclusive: an all-day event ending at midnight belongs to the day before). */
function lastDate(e: CalendarEvent): string {
  const start = new Date(e.start).getTime();
  const end = new Date(e.end).getTime();
  return todayISO(new Date(Math.max(start, end - 1)));
}

/** Days an event touches inside FROM..TO (multi-day events appear on each day); empty when it lies outside. */
export function eventDays(e: CalendarEvent, fromISO: string, toISO: string): string[] {
  const start = eventDate(e);
  const end = lastDate(e);
  if (end < fromISO || start > toISO) return [];
  const first = start < fromISO ? fromISO : start;
  const last = end > toISO ? toISO : end;
  const days: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  return days;
}

/** "Thu Sep 17" */
export function dayLabel(dateISO: string): string {
  return parseISO(dateISO).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "10:00–10:30  Standup" style line for a prompt or the terminal. */
export function formatEvent(e: CalendarEvent): string {
  const where = e.location ? `  (${e.location})` : "";
  if (e.allDay) return `all day      ${e.title}${where}`;
  return `${hhmm(e.start)}–${hhmm(e.end)}  ${e.title}${where}`;
}

/** Events grouped under day headings, for prompts, tools and the terminal. */
export function formatAgenda(events: CalendarEvent[], fromISO: string, toISO: string): string {
  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    for (const d of eventDays(e, fromISO, toISO)) {
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(e);
    }
  }
  if (!byDay.size) return "No events.";
  return [...byDay.keys()]
    .sort()
    .map((d) => `${dayLabel(d)} (${d})\n${byDay.get(d)!.map((e) => `- ${formatEvent(e)}`).join("\n")}`)
    .join("\n");
}

export function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
