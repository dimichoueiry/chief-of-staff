/**
 * One-off reminders in goals/reminders.md:
 *
 *   - [ ] 2026-09-19 · email the UIUC advisor
 *   - [ ] 2026-09-23 09:00 · Module 2 post goes out on Instagram, Facebook and Threads
 *   - [x] 2026-09-12 · renew the domain
 *
 * The time is optional. It is there for things that happen at a set hour, so the
 * heartbeat (logic/heartbeat.ts) can get them ready before then.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { commitPaths, ensureRepo } from "./git.js";
import { selfhubPaths } from "./paths.js";
import { todayISO } from "../util/dates.js";

export interface Reminder {
  date: string;
  /** HH:MM, 24-hour, when it happens at a set time. */
  time?: string;
  text: string;
  done: boolean;
}

const LINE = /^\s*[-*]\s*\[( |x|X)\]\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s*(?:·|-|:)\s*(.+?)\s*$/;

/** "2026-09-23 09:00", or just the date. */
export function reminderWhen(r: Reminder): string {
  return r.time ? `${r.date} ${r.time}` : r.date;
}

/** "9:5" or "09:05" → "09:05"; anything else → undefined. */
export function cleanTime(t: string | undefined): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

export function parseReminders(markdown: string): Reminder[] {
  const out: Reminder[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) out.push({ date: m[2], ...(m[3] ? { time: cleanTime(m[3]) } : {}), text: m[4], done: m[1].toLowerCase() === "x" });
  }
  return out;
}

export function serializeReminders(reminders: Reminder[]): string {
  const lines = ["# Reminders", ""];
  for (const r of reminders) lines.push(`- [${r.done ? "x" : " "}] ${reminderWhen(r)} · ${r.text}`);
  return lines.join("\n") + "\n";
}

export class Reminders {
  readonly paths;

  constructor(readonly selfhubDir: string) {
    this.paths = selfhubPaths(selfhubDir);
  }

  async list(): Promise<Reminder[]> {
    try {
      return parseReminders(await readFile(this.paths.reminders, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Open reminders whose date is today or earlier. */
  async due(today: string = todayISO()): Promise<Reminder[]> {
    return (await this.list()).filter((r) => !r.done && r.date <= today);
  }

  /** Open reminders in the next `days` days (excluding overdue). */
  async upcoming(days: number, today: string = todayISO()): Promise<Reminder[]> {
    const all = await this.list();
    return all.filter((r) => !r.done && r.date > today && daysAhead(today, r.date) <= days);
  }

  async add(date: string, text: string, time?: string): Promise<string | null> {
    const all = await this.list();
    const at = cleanTime(time);
    all.push({ date, ...(at ? { time: at } : {}), text: text.trim(), done: false });
    all.sort((a, b) => reminderWhen(a).localeCompare(reminderWhen(b)));
    return this.write(all, `cos: remind ${at ? `${date} ${at}` : date} "${text.trim()}"`);
  }

  /** Mark the first open reminder whose text contains `needle` as done. */
  async complete(needle: string): Promise<Reminder | null> {
    const all = await this.list();
    const hit = all.find((r) => !r.done && r.text.toLowerCase().includes(needle.toLowerCase()));
    if (!hit) return null;
    hit.done = true;
    await this.write(all, `cos: done "${hit.text}"`);
    return hit;
  }

  private async write(reminders: Reminder[], message: string): Promise<string | null> {
    await ensureRepo(this.selfhubDir);
    await mkdir(dirname(this.paths.reminders), { recursive: true });
    await writeFile(this.paths.reminders, serializeReminders(reminders), "utf8");
    return commitPaths(this.selfhubDir, [relative(this.selfhubDir, this.paths.reminders)], message);
  }
}

function daysAhead(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}
