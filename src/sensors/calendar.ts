/**
 * Read-only calendar sensor. We never build a calendar; we read the one macOS
 * already aggregates. Providers, tried in order unless COS_CALENDAR pins one:
 *   - icalbuddy  (if the `icalBuddy` CLI is installed)
 *   - eventkit   (a tiny Swift helper compiled on first use with swiftc)
 *   - none       (all day free)
 */
import { execFile } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { todayISO } from "../util/dates.js";

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
  eventsOn(dateISO: string): Promise<CalendarEvent[]>;
}

// ---------- icalBuddy ----------

const ICALBUDDY_ARGS = [
  "-nc", "-nrd", "-npn", "-ea",
  "-iep", "title,datetime", "-po", "datetime,title",
  "-ps", "| · |", "-df", "%Y-%m-%d", "-tf", "%H:%M", "-b", "",
];

/** Parse lines like `2026-09-14 at 10:00 - 10:30 · Standup` or `2026-09-14 · Holiday`. */
export function parseIcalBuddy(output: string, dateISO: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const re = /^(\d{4}-\d{2}-\d{2})(?:\s+at\s+(\d{2}:\d{2}))?(?:\s*-\s*(?:(\d{4}-\d{2}-\d{2})\s+at\s+)?(\d{2}:\d{2}))?\s*·\s*(.+?)\s*$/;
    for (const raw of output.split(/\r?\n/)) {
    const m = re.exec(raw.trim());
    if (!m) continue;
    const [, date, startT, endDate, endT, title] = m;
    if (date !== dateISO) continue;
    if (!startT) {
      events.push({ title, start: `${date}T00:00:00`, end: `${date}T23:59:59`, allDay: true });
    } else {
      events.push({
        title,
        start: `${date}T${startT}:00`,
        end: `${endDate ?? date}T${endT ?? startT}:00`,
        allDay: false,
      });
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
  async eventsOn(dateISO) {
    const { stdout } = await exec("icalBuddy", [...ICALBUDDY_ARGS, `eventsFrom:${dateISO}`, `to:${dateISO}`]);
    return parseIcalBuddy(stdout, dateISO);
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
  const [srcStat, binStat] = await Promise.all([
    stat(HELPER_SRC),
    stat(bin).catch(() => null),
  ]);
  if (binStat && binStat.mtimeMs >= srcStat.mtimeMs) return bin;
  await mkdir(dirname(bin), { recursive: true });
  await exec("swiftc", [
    "-O", "-o", bin, HELPER_SRC,
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
  async eventsOn(dateISO) {
    const bin = await ensureEventKitHelper();
    const { stdout } = await exec(bin, [dateISO], { timeout: 20_000 });
    return parseEventKit(stdout);
  },
};

export const noneProvider: CalendarProvider = {
  name: "none",
  available: async () => true,
  eventsOn: async () => [],
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

/** Today's events through the best available provider. Never throws: a broken provider means "no events". */
export async function todayEvents(
  dateISO: string = todayISO(),
  provider?: CalendarProvider,
): Promise<{ events: CalendarEvent[]; provider: string; error?: string }> {
  const p = provider ?? (await pickProvider());
  try {
    const events = await p.eventsOn(dateISO);
    events.sort((a, b) => a.start.localeCompare(b.start));
    return { events, provider: p.name };
  } catch (err) {
    return { events: [], provider: p.name, error: (err as Error).message };
  }
}

/** "10:00–10:30  Standup" style line for a prompt or the terminal. */
export function formatEvent(e: CalendarEvent): string {
  if (e.allDay) return `all day      ${e.title}`;
  return `${hhmm(e.start)}–${hhmm(e.end)}  ${e.title}`;
}

export function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
