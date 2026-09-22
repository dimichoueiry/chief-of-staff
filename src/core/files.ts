/**
 * The memory as files you can open and edit from the app: who you are (every identity file), the
 * stores (projects, reminders, notes, the heartbeat's rules) and the recent journal. Each save is a
 * git commit like any other write to memory, so an edit can be seen and undone.
 *
 * Paths come from the page, so every one is checked: relative, markdown, and inside selfhub once
 * links are resolved. A save carries the file's modified time from when it was opened; if the file
 * changed since (the assistant wrote to it meanwhile), the save is refused rather than lost.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { commitPaths, ensureRepo } from "./git.js";
import { selfhubPaths } from "./paths.js";

export interface MemoryFile {
  /** Relative to selfhub, with forward slashes. */
  path: string;
  /** What the card calls it. */
  title: string;
  /** One line on what it holds. */
  about: string;
  exists: boolean;
  size: number;
  modified: string | null;
}

export interface MemoryGroup {
  name: string;
  files: MemoryFile[];
}

/** The heartbeat's standing rules (logic/heartbeat.ts reads them). */
export const HEARTBEAT_RULES = "goals/heartbeat.md";
export const HEARTBEAT_TEMPLATE = `# Heartbeat

Standing instructions for when it writes to you first. For example:

- Nothing about drawcal until October.
- Social posts: offer to tune them the afternoon before.
- Never on Sundays.
`;

const STORE_DIRS = new Set(["goals", "journal", "notes", "links", ".git", "node_modules", "assets"]);
const JOURNAL_SHOWN = 14;

const slash = (p: string) => p.split(sep).join("/");

function titleFor(rel: string): string {
  const base = rel.split("/").pop()!.replace(/\.md$/i, "");
  return base.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

async function describe(selfhubDir: string, rel: string, title: string, about: string): Promise<MemoryFile> {
  try {
    const s = await stat(join(selfhubDir, rel));
    return { path: rel, title, about, exists: true, size: s.size, modified: s.mtime.toISOString() };
  } catch {
    return { path: rel, title, about, exists: false, size: 0, modified: null };
  }
}

/** Every file worth opening, in groups, as the Memory tab shows them. */
export async function memoryFiles(selfhubDir: string): Promise<MemoryGroup[]> {
  const identity: string[] = [];
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
        // The same files the assistant reads as who you are (core/context.ts); selfhub's own README isn't one.
        identity.push(slash(relative(selfhubDir, join(dir, e.name))));
      }
    }
  }
  await walk(selfhubDir);
  identity.sort();

  const p = selfhubPaths(selfhubDir);
  const rel = (abs: string) => slash(relative(selfhubDir, abs));
  const stores = await Promise.all([
    describe(selfhubDir, rel(p.ledger), "Projects", "Every project: why, status, rhythm, next action"),
    describe(selfhubDir, rel(p.reminders), "Reminders", "Dated things, with times"),
    describe(selfhubDir, rel(p.notesInbox), "Notes", "Ideas and facts that aren't a project or a reminder"),
    describe(selfhubDir, HEARTBEAT_RULES, "Heartbeat rules", "When it may write to you first, and about what"),
  ]);

  let journal: string[] = [];
  try {
    journal = (await readdir(p.journalDir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().reverse().slice(0, JOURNAL_SHOWN);
  } catch {
    /* no journal yet */
  }

  return [
    { name: "About you", files: await Promise.all(identity.map((r) => describe(selfhubDir, r, titleFor(r), r))) },
    { name: "What it keeps", files: stores },
    { name: "Journal", files: await Promise.all(journal.map((n) => describe(selfhubDir, `journal/${n}`, n.replace(/\.md$/, ""), "What happened, what's next"))) },
  ].filter((g) => g.files.length);
}

/** The absolute path for a page-supplied path, or an error saying why not. */
export async function resolveMemoryPath(selfhubDir: string, path: string): Promise<string> {
  const p = String(path ?? "").trim();
  if (!p || isAbsolute(p) || !p.toLowerCase().endsWith(".md") || p.split(/[\\/]/).some((part) => part === ".." || part.startsWith("."))) {
    throw new Error("That isn't a memory file.");
  }
  const root = await realpath(selfhubDir);
  const abs = resolve(root, p);
  if (!abs.startsWith(root + sep)) throw new Error("That isn't a memory file.");
  // A file that exists may be a link: follow it and check again.
  if (existsSync(abs)) {
    const real = await realpath(abs);
    if (!real.startsWith(root + sep)) throw new Error("That isn't a memory file.");
  } else if (existsSync(dirname(abs))) {
    const realDir = await realpath(dirname(abs));
    if (realDir !== root && !realDir.startsWith(root + sep)) throw new Error("That isn't a memory file.");
  }
  return abs;
}

export async function readMemoryFile(selfhubDir: string, path: string): Promise<{ path: string; text: string; modified: string | null }> {
  const abs = await resolveMemoryPath(selfhubDir, path);
  try {
    const [text, s] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
    return { path, text, modified: s.mtime.toISOString() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { path, text: path === HEARTBEAT_RULES ? HEARTBEAT_TEMPLATE : "", modified: null };
  }
}

export class EditConflict extends Error {}

/** Save and commit. `base` is the modified time it was opened at (null for a new file). */
export async function saveMemoryFile(selfhubDir: string, path: string, text: string, base: string | null | undefined): Promise<{ modified: string; commit: string | null }> {
  const abs = await resolveMemoryPath(selfhubDir, path);
  if (base !== undefined) {
    let now: string | null = null;
    try {
      now = (await stat(abs)).mtime.toISOString();
    } catch {
      /* new file */
    }
    if (now !== base) throw new EditConflict("It changed since you opened it (the assistant may have written to it). Copy your edit, reopen the file, and apply it again.");
  }
  const body = text.replace(/\r\n/g, "\n");
  await ensureRepo(selfhubDir);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  const commit = await commitPaths(selfhubDir, [path], `cos: edited ${path}`);
  return { modified: (await stat(abs)).mtime.toISOString(), commit };
}
