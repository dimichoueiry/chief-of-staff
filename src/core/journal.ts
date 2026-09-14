/** One markdown file per day: journal/YYYY-MM-DD.md. Append-only, committed on write. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { commitPaths, ensureRepo } from "./git.js";
import { selfhubPaths } from "./paths.js";
import { addDays, todayISO } from "../util/dates.js";

export interface JournalEntry {
  date: string;
  text: string;
}

export class Journal {
  readonly paths;

  constructor(readonly selfhubDir: string) {
    this.paths = selfhubPaths(selfhubDir);
  }

  async append(dateISO: string, text: string): Promise<string | null> {
    await ensureRepo(this.selfhubDir);
    await mkdir(this.paths.journalDir, { recursive: true });
    const file = this.paths.journal(dateISO);
    let existing = "";
    try {
      existing = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const body = text.trim();
    const next = existing
      ? existing.replace(/\s*$/, "\n") + "\n" + body + "\n"
      : `# ${dateISO}\n\n${body}\n`;
    await writeFile(file, next, "utf8");
    return commitPaths(this.selfhubDir, [relative(this.selfhubDir, file)], `cos: journal ${dateISO}`);
  }

  /** Entries for the last `nDays` days (including today), oldest first. Missing days are skipped. */
  async entries(nDays: number, today: string = todayISO()): Promise<JournalEntry[]> {
    const out: JournalEntry[] = [];
    for (let i = nDays - 1; i >= 0; i--) {
      const date = addDays(today, -i);
      try {
        out.push({ date, text: (await readFile(this.paths.journal(date), "utf8")).trim() });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return out;
  }

  async read(nDays: number, today: string = todayISO()): Promise<string> {
    const entries = await this.entries(nDays, today);
    return entries.map((e) => e.text).join("\n\n");
  }
}
