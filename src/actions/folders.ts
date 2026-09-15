/**
 * Find folders by a loosely remembered or misheard name: "ML gorilla" finds
 * ~/Documents/GitHub/mlguerilla. Read-only. Searches the places code and work
 * usually live, a few levels deep, and says what it couldn't read or didn't reach.
 */
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { lastCommitDate } from "../core/git.js";

/** Under the home folder; searched when they exist, after the configured project roots. */
export const COMMON_DIRS = [
  "Desktop", "Documents", "Documents/GitHub", "Developer", "development", "dev", "code", "Code",
  "Projects", "projects", "repos", "src", "workspace", "IdeaProjects", "PycharmProjects", "GitHub",
];

const SKIP = new Set([
  "node_modules", "Library", "Applications", "venv", ".venv", "env", "__pycache__", "build", "dist", "target", "Pods",
  "DerivedData", "vendor", "site-packages", "Pictures", "Music", "Movies", "Public",
]);

/** Words people add around a name that aren't part of it. */
const FILLER = new Set(["the", "my", "a", "folder", "folders", "directory", "dir", "codebase", "code", "base", "repo", "repository", "project", "for", "of", "on", "disk"]);

export interface FolderMatch {
  path: string;
  score: number;
  git: boolean;
  lastCommit?: string;
  modified: string;
  readme?: string;
  entries: string[];
}

export interface FolderSearch {
  query: string;
  matches: FolderMatch[];
  /** Every match found, before showing only the best. */
  total: number;
  searched: string[];
  unreadable: string[];
  scanned: number;
  /** True when the folder budget ran out before every place was searched. */
  truncated: boolean;
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function queryKey(q: string): string {
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w));
  return (kept.length ? kept : words).join("");
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** 0 to 1: how well a folder name fits what was said, allowing for misspelling and mishearing. */
export function nameScore(query: string, folderName: string): number {
  const q = queryKey(query);
  const n = normalize(folderName);
  if (q.length < 2 || !n) return 0;
  if (n === q) return 1;
  if (q.length >= 3 && n.includes(q)) return 0.9;
  if (n.length >= 4 && q.includes(n)) return 0.75;
  const whole = 1 - levenshtein(q, n) / Math.max(q.length, n.length);
  // The name may carry extra words ("mlguerrilla-teach"): compare against its best stretch of similar length.
  let part = 0;
  for (let len = Math.max(1, q.length - 2); len <= Math.min(n.length, q.length + 3); len++) {
    for (let i = 0; i + len <= n.length; i++) {
      part = Math.max(part, 1 - levenshtein(q, n.slice(i, i + len)) / Math.max(q.length, len));
    }
  }
  return Math.max(whole, part * 0.9);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function tildify(p: string, home = homedir()): string {
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

async function describe(path: string, score: number): Promise<FolderMatch> {
  const git = await exists(join(path, ".git"));
  const [info, names, commit] = await Promise.all([
    stat(path),
    readdir(path, { withFileTypes: true }).catch(() => []),
    git ? lastCommitDate(path) : Promise.resolve(null),
  ]);
  const visible = names.filter((e) => !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name));
  let readme: string | undefined;
  const readmeFile = visible.find((e) => /^readme(\.md|\.txt)?$/i.test(e.name));
  if (readmeFile) {
    const text = await readFile(join(path, readmeFile.name), "utf8").catch(() => "");
    readme = text.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l && !l.startsWith("<") && !l.startsWith("!["))?.slice(0, 160);
  }
  return {
    path,
    score,
    git,
    lastCommit: commit ?? undefined,
    modified: info.mtime.toISOString(),
    readme,
    entries: visible.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)),
  };
}

export interface FindOptions {
  /** Searched first, in order; common places under home follow. */
  roots?: string[];
  home?: string;
  depth?: number;
  /** Most folders to look at before stopping (and saying so). */
  budget?: number;
  limit?: number;
  threshold?: number;
}

export async function findFolders(query: string, o: FindOptions = {}): Promise<FolderSearch> {
  const home = o.home ?? homedir();
  const depth = o.depth ?? 3;
  const budget = o.budget ?? 40_000;
  const limit = o.limit ?? 8;
  const threshold = o.threshold ?? 0.6;

  const roots = [...(o.roots ?? []), ...COMMON_DIRS.map((d) => join(home, d))];
  const searched: string[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  const hits = new Map<string, number>();
  let scanned = 0;
  let truncated = false;

  async function walk(dir: string, level: number, maxLevel: number): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (level === 0) unreadable.push(`${tildify(dir, home)} (${(err as NodeJS.ErrnoException).code ?? "unreadable"})`);
      return;
    }
    if (level === 0) searched.push(maxLevel === 1 && dir === home ? "~ (top level)" : tildify(dir, home));
    const children: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name) || e.name.endsWith(".app")) continue;
      const path = join(dir, e.name);
      if (seen.has(path)) continue;
      seen.add(path);
      if (++scanned > budget) {
        truncated = true;
        return;
      }
      const score = nameScore(query, e.name);
      if (score >= threshold) hits.set(path, score);
      children.push(path);
    }
    if (level + 1 >= maxLevel) return;
    for (const child of children) {
      // Inside a repo, subfolders are the project's own structure, not other projects.
      if (await exists(join(child, ".git"))) continue;
      await walk(child, level + 1, maxLevel);
    }
  }

  for (const root of roots) {
    if (seen.has(`root:${root}`) || !(await exists(root))) continue;
    seen.add(`root:${root}`);
    await walk(root, 0, depth);
  }
  // Folders right in the home folder (~/AgentGrid, ~/selfhub): one level only.
  if (!truncated) await walk(home, 0, 1);

  const ranked = await Promise.all([...hits].map(([path, score]) => describe(path, score)));
  ranked.sort((a, b) =>
    b.score - a.score || Number(b.git) - Number(a.git) || (b.lastCommit ?? b.modified).localeCompare(a.lastCommit ?? a.modified),
  );
  return { query, matches: ranked.slice(0, limit), total: ranked.length, searched, unreadable, scanned: Math.min(scanned, budget), truncated };
}

/** The search as text for the model or the terminal: every limit and gap stated. */
export function formatFolderSearch(r: FolderSearch, home = homedir()): string {
  const lines: string[] = [];
  if (!r.matches.length) lines.push(`No folder name close to "${r.query}".`);
  else {
    lines.push(`${r.total} folder${r.total === 1 ? "" : "s"} close to "${r.query}"${r.total > r.matches.length ? `, best ${r.matches.length} shown` : ""}, best first:`);
    r.matches.forEach((m, i) => {
      const what = m.git ? `git repo${m.lastCommit ? `, last commit ${m.lastCommit.slice(0, 10)}` : ", no commits"}` : `folder, modified ${m.modified.slice(0, 10)}`;
      const inside = m.entries.length ? `; contains ${m.entries.slice(0, 12).join(", ")}${m.entries.length > 12 ? `, and ${m.entries.length - 12} more` : ""}` : "; empty";
      lines.push(`${i + 1}. ${tildify(m.path, home)} (${basename(m.path)}) — ${what}${m.readme ? `; README: "${m.readme}"` : ""}${inside}`);
    });
  }
  lines.push(`Searched ${r.searched.join(", ") || "nothing readable"}: ${r.scanned.toLocaleString("en-US")} folders, up to 3 levels deep, not inside git repos.`);
  if (r.truncated) lines.push("Stopped early: too many folders. Results may be incomplete; ask for a narrower place to search.");
  if (r.unreadable.length) lines.push(`Couldn't read: ${r.unreadable.join(", ")}. If that's macOS privacy, allow Chief of Staff under System Settings › Privacy & Security › Files and Folders.`);
  return lines.join("\n");
}
