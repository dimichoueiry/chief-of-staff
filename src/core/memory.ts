/**
 * The memory folder as something the app can set up and report on, not only the CLI.
 *
 * `cos init` scaffolds the stores for a developer. Whoever was handed the packaged app has no
 * CLI, so the app does the same thing on first run, and can say where memory lives and whether
 * its history is being kept (see git.ts: without Apple's developer tools it isn't).
 */
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { commitPaths, ensureRepo, gitAvailability, lastCommitDate, uncommitted } from "./git.js";
import { selfhubPaths } from "./paths.js";

export const LEDGER_TEMPLATE = `# Projects

One block per project. Fields: why · status (active | parked | done | killed) · cadence · next · last touched · deadline · notes · path
Rules: one next action per project. A why helps rank it. last touched is maintained for you from git activity.
Add a project with: cos capture "starting a project: <name>, it's for <why>"
`;
export const REMINDERS_TEMPLATE = "# Reminders\n\n";
export const NOTES_TEMPLATE = "# Inbox\n\n";

export interface StoreFile {
  /** ledger | reminders | notes */
  name: string;
  path: string;
  template: string;
}

export function storeFiles(selfhubDir: string): StoreFile[] {
  const paths = selfhubPaths(selfhubDir);
  return [
    { name: "ledger", path: paths.ledger, template: LEDGER_TEMPLATE },
    { name: "reminders", path: paths.reminders, template: REMINDERS_TEMPLATE },
    { name: "notes", path: paths.notesInbox, template: NOTES_TEMPLATE },
  ];
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export interface MemoryState {
  dir: string;
  /** The folder is there. */
  exists: boolean;
  /** Every store file is there. */
  ready: boolean;
  missing: string[];
  history:
    | { on: true; git: string; lastCommit: string | null }
    | { on: false; reason: string; fix?: "install-tools" };
}

export async function memoryState(selfhubDir: string): Promise<MemoryState> {
  const files = storeFiles(selfhubDir);
  const there = await Promise.all(files.map((f) => exists(f.path)));
  const missing = files.filter((_, i) => !there[i]).map((f) => f.name);
  const have = await gitAvailability();
  return {
    dir: selfhubDir,
    exists: await exists(selfhubDir),
    ready: missing.length === 0,
    missing,
    history: have.ok
      ? { on: true, git: have.version, lastCommit: await lastCommitDate(selfhubDir) }
      : { on: false, reason: have.reason, fix: have.fix },
  };
}

export interface ScaffoldResult {
  /** Store files written just now, by name. */
  created: string[];
  /** The commit that holds them, when history is being kept. */
  commit: string | null;
}

/**
 * Create whichever store files are missing, and commit them when git works.
 * An existing file is never touched, so this is safe to call again.
 */
export async function ensureStores(selfhubDir: string): Promise<ScaffoldResult> {
  const files = storeFiles(selfhubDir);
  const there = await Promise.all(files.map((f) => exists(f.path)));
  const missing = files.filter((_, i) => !there[i]);
  await ensureRepo(selfhubDir); // makes the folder with or without git
  await mkdir(selfhubPaths(selfhubDir).journalDir, { recursive: true });
  if (!missing.length) return { created: [], commit: null };
  const written: StoreFile[] = [];
  for (const file of missing) {
    await mkdir(dirname(file.path), { recursive: true });
    try {
      // "wx" fails rather than overwrites. Between the check above and this line something else
      // may have written a real note here — the first launch and a first capture can land together
      // — and an empty template must never land on top of it.
      await writeFile(file.path, file.template, { encoding: "utf8", flag: "wx" });
      written.push(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  if (!written.length) return { created: [], commit: null };
  const commit = await commitPaths(
    selfhubDir,
    written.map((m) => relative(selfhubDir, m.path)),
    "cos: initialise memory stores",
  );
  return { created: written.map((m) => m.name), commit };
}

/**
 * Once git works, put whatever was written without it into the history: the stores and every
 * journal entry that is there but untracked. Only this app's own files, never anything else
 * someone keeps in the folder. Nothing staged means nothing to do, so calling it again is free.
 */
export async function catchUpHistory(selfhubDir: string): Promise<string | null> {
  if (!(await gitAvailability()).ok) return null;
  if (!(await ensureRepo(selfhubDir))) return null;
  const paths = storeFiles(selfhubDir).map((f) => f.path);
  try {
    const dir = selfhubPaths(selfhubDir).journalDir;
    for (const entry of await readdir(dir)) if (entry.endsWith(".md")) paths.push(join(dir, entry));
  } catch {
    /* no journal yet */
  }
  const there = await Promise.all(paths.map(exists));
  const relatives = paths.filter((_, i) => there[i]).map((p) => relative(selfhubDir, p));
  if (!relatives.length) return null;
  // Normally there is nothing to do, and then this touches git at all: no staging, no commit,
  // nothing that could collide with a note being saved at the same moment.
  const behind = await uncommitted(selfhubDir, relatives);
  if (!behind.length) return null;
  return commitPaths(selfhubDir, relatives, "cos: memory written while git was unavailable");
}

/**
 * First run only: scaffold when there is no memory here at all. A folder that holds anything is
 * left exactly as it is, so a store someone deleted on purpose doesn't come back every launch.
 */
export async function ensureStoresOnFirstRun(selfhubDir: string): Promise<ScaffoldResult | null> {
  const files = storeFiles(selfhubDir);
  const there = await Promise.all(files.map((f) => exists(f.path)));
  if (there.some(Boolean)) return null;
  let entries: string[] = [];
  try {
    entries = (await readdir(selfhubDir)).filter((e) => e !== ".DS_Store");
  } catch {
    entries = []; // no folder yet: as fresh as it gets
  }
  if (entries.some((e) => e !== ".git")) return null;
  return ensureStores(selfhubDir);
}
