/** A single append-only inbox for thoughts that are not projects or reminders: notes/inbox.md */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { commitPaths, ensureRepo } from "./git.js";
import { selfhubPaths } from "./paths.js";
import { addDays, todayISO } from "../util/dates.js";

export interface Note {
  date: string;
  text: string;
}

const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;

export function parseNotes(markdown: string): Note[] {
  const out: Note[] = [];
  let date = "";
  for (const line of markdown.split(/\r?\n/)) {
    const h = DATE_HEADING.exec(line);
    if (h) {
      date = h[1];
      continue;
    }
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (m && date) out.push({ date, text: m[1] });
  }
  return out;
}

export class Notes {
  readonly paths;

  constructor(readonly selfhubDir: string) {
    this.paths = selfhubPaths(selfhubDir);
  }

  async list(): Promise<Note[]> {
    try {
      return parseNotes(await readFile(this.paths.notesInbox, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async recent(nDays: number, today: string = todayISO()): Promise<Note[]> {
    const floor = addDays(today, -(nDays - 1));
    return (await this.list()).filter((n) => n.date >= floor && n.date <= today);
  }

  async add(text: string, date: string = todayISO()): Promise<string | null> {
    await ensureRepo(this.selfhubDir);
    await mkdir(dirname(this.paths.notesInbox), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(this.paths.notesInbox, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const body = `- ${text.trim()}`;
    let next: string;
    if (!existing) next = `# Inbox\n\n## ${date}\n${body}\n`;
    else if (existing.includes(`\n## ${date}\n`) || existing.startsWith(`## ${date}\n`)) {
      // append under the existing heading for this date
      const lines = existing.replace(/\s*$/, "\n").split("\n");
      const idx = lines.findIndex((l) => l === `## ${date}`);
      let end = idx + 1;
      while (end < lines.length && !DATE_HEADING.test(lines[end])) end++;
      // insert before the blank line(s) that precede the next heading
      let insertAt = end;
      while (insertAt > idx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
      lines.splice(insertAt, 0, body);
      next = lines.join("\n");
    } else next = existing.replace(/\s*$/, "\n") + `\n## ${date}\n${body}\n`;
    await writeFile(this.paths.notesInbox, next, "utf8");
    return commitPaths(this.selfhubDir, [relative(this.selfhubDir, this.paths.notesInbox)], `cos: note ${date}`);
  }
}
