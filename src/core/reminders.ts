/**
 * One-off reminders in goals/reminders.md:
 *
 *   - [ ] 2026-09-19 · email the UIUC advisor
 *   - [x] 2026-09-12 · renew the domain
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { commitPaths, ensureRepo } from "./git.js";
import { selfhubPaths } from "./paths.js";
import { todayISO } from "../util/dates.js";

export interface Reminder {
  date: string;
  text: string;
  done: boolean;
}

const LINE = /^\s*[-*]\s*\[( |x|X)\]\s*(\d{4}-\d{2}-\d{2})\s*(?:·|-|:)\s*(.+?)\s*$/;

export function parseReminders(markdown: string): Reminder[] {
  const out: Reminder[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) out.push({ date: m[2], text: m[3], done: m[1].toLowerCase() === "x" });
  }
  return out;
}

export function serializeReminders(reminders: Reminder[]): string {
  const lines = ["# Reminders", ""];
  for (const r of reminders) lines.push(`- [${r.done ? "x" : " "}] ${r.date} · ${r.text}`);
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

  async add(date: string, text: string): Promise<string | null> {
    const all = await this.list();
    all.push({ date, text: text.trim(), done: false });
    all.sort((a, b) => a.date.localeCompare(b.date));
    return this.write(all, `cos: remind ${date} "${text.trim()}"`);
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
