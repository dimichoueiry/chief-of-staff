/**
 * Git-activity sensor: which project folders had commits, and when. Feeds
 * `ledger.touch()` so "last touched" is maintained without any manual step.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { lastCommitDate } from "../core/git.js";
import { Ledger, type Project } from "../core/ledger.js";

export interface Activity {
  path: string;
  lastCommit: string; // ISO datetime
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Every git repo that is a root itself or a direct child of a root, with its last commit time. */
export async function scanActivity(roots: string[]): Promise<Activity[]> {
  const out: Activity[] = [];
  const seen = new Set<string>();
  for (const rawRoot of roots) {
    const root = expandHome(rawRoot);
    if (!(await isDir(root))) continue;
    const candidates = [root];
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      // e.g. EPERM: macOS privacy protection on Desktop for a background process. Skip, don't crash the brief.
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) candidates.push(join(root, entry.name));
    }
    for (const dir of candidates) {
      if (seen.has(dir) || !(await isDir(join(dir, ".git")))) continue;
      seen.add(dir);
      const lastCommit = await lastCommitDate(dir);
      if (lastCommit) out.push({ path: dir, lastCommit });
    }
  }
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Match a repo to a project by its `path` field, else by folder name. */
export function matchProject(projects: Project[], repoPath: string): Project | undefined {
  const byPath = projects.find((p) => p.path && expandHome(p.path).replace(/\/+$/, "") === repoPath);
  if (byPath) return byPath;
  const name = slug(basename(repoPath));
  return projects.find((p) => slug(p.name) === name);
}

export interface TouchResult {
  project: string;
  path: string;
  date: string;
}

/** Update lastTouched for every project with matching git activity. Only moves dates forward. */
export async function applyActivity(ledger: Ledger, activity: Activity[]): Promise<TouchResult[]> {
  const projects = await ledger.read();
  const touched: TouchResult[] = [];
  for (const a of activity) {
    const project = matchProject(projects, a.path);
    if (!project) continue;
    const date = a.lastCommit.slice(0, 10);
    if (await ledger.touch(project.name, date)) touched.push({ project: project.name, path: a.path, date });
  }
  return touched;
}
