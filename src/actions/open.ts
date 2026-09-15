/**
 * Open things for you: Slate or a Slate board, your shortcuts, a project's folder
 * (in Finder or an app like Cursor), an app, a web search, or a website.
 *
 * Safety rules, enforced here rather than trusted to the model:
 * - Only http(s) web addresses. No file:, javascript:, or app-specific schemes.
 * - A web address the model came up with is never opened directly: it becomes a
 *   pending action you confirm. Your shortcuts, Slate, projects and searches open at once.
 * - Files open only from inside your home folder and only if they are documents or
 *   media. Scripts, installers and anything else that would run code are refused.
 * - Apps must be installed .app bundles found in the usual Applications folders.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { findProject, type Project } from "../core/ledger.js";
import { findBoards, slateBoardUrl, slateBoards, slateHomeUrl, type SlateBoard } from "./slate.js";
import { findShortcut, type Shortcut } from "./shortcuts.js";

const exec = promisify(execFile);

export type OpenAction =
  | { kind: "url"; url: string; label: string; trusted: boolean }
  | { kind: "path"; path: string; app?: string; label: string }
  | { kind: "app"; app: string; label: string };

// ---------- validation ----------

export function safeWebUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const OPENABLE_EXTENSIONS = new Set([
  "", // folders
  ".md", ".txt", ".pdf", ".csv", ".json", ".rtf",
  ".png", ".jpg", ".jpeg", ".gif", ".heic", ".webp", ".svg",
  ".mov", ".mp4", ".m4a", ".mp3", ".wav",
  ".docx", ".xlsx", ".pptx", ".pages", ".numbers", ".key",
  ".slate", ".ifc", ".fig",
]);

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** A folder or document inside the home folder, or a reason it can't be opened. */
export async function checkPath(raw: string, home: string = homedir()): Promise<{ path: string } | { error: string }> {
  const path = resolve(expandHome(raw.trim()));
  if (path !== home && !path.startsWith(home + "/")) return { error: "only things inside your home folder can be opened" };
  let s;
  try {
    s = await stat(path);
  } catch {
    return { error: `nothing at ${raw}` };
  }
  if (s.isDirectory()) {
    if (path.endsWith(".app")) return { error: "apps are opened by name, not by path" };
    return { path };
  }
  const ext = extname(path).toLowerCase();
  if (!OPENABLE_EXTENSIONS.has(ext) || (s.mode & 0o111) !== 0) {
    return { error: `won't open ${ext || "that"} files: they can run code` };
  }
  return { path };
}

const APP_DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", join(homedir(), "Applications")];

/** An installed app bundle for a loose name like "cursor" or "vs code". */
export function findApp(name: string, dirs: string[] = APP_DIRS): string | null {
  const want = name.toLowerCase().replace(/\.app$/, "").replace(/[^a-z0-9]+/g, "");
  const aliases: Record<string, string> = { vscode: "visualstudiocode", code: "visualstudiocode", chrome: "googlechrome", edge: "microsoftedge", iterm: "iterm2" };
  const target = aliases[want] ?? want;
  if (!target) return null;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    const hit = entries.find((e) => e.endsWith(".app") && e.toLowerCase().replace(/\.app$/, "").replace(/[^a-z0-9]+/g, "") === target);
    if (hit) return join(dir, hit);
  }
  return null;
}

// ---------- resolution ----------

export interface ResolveInput {
  target: string;
  app?: string;
  shortcuts: Shortcut[];
  projects: Project[];
  /** Loaded only when the target mentions Slate. */
  boards?: () => Promise<{ boards: SlateBoard[]; live: boolean; reason?: string }>;
}

export type Resolution =
  | { ok: true; action: OpenAction }
  | { ok: false; reason: string; candidates?: string[] };

const SEARCH = /^(?:search(?: the web| google)?(?: for)?|google|look up)\s+(.+)$/i;
const SLATE = /^slate(?:\s+(?:board\s+)?(.+))?$|^(.+?)\s+(?:board\s+)?(?:on|in)\s+slate$|^(?:my\s+)?(.+?)\s+slate\s+board$/i;

export async function resolveOpen(input: ResolveInput): Promise<Resolution> {
  const raw = input.target.trim().replace(/^(?:open|show|launch|go to|bring up)\s+/i, "").replace(/^(?:my|the)\s+/i, "").replace(/[.!?]+$/, "");
  if (!raw) return { ok: false, reason: "open what?" };

  const search = SEARCH.exec(raw);
  if (search) {
    const q = search[1].trim();
    return { ok: true, action: { kind: "url", url: `https://www.google.com/search?q=${encodeURIComponent(q)}`, label: `search for “${q}”`, trusted: true } };
  }

  const shortcut = findShortcut(input.shortcuts, raw);
  if (shortcut) {
    const url = safeWebUrl(shortcut.target);
    if (url) return { ok: true, action: { kind: "url", url, label: shortcut.name, trusted: true } };
    const checked = await checkPath(shortcut.target);
    if ("error" in checked) return { ok: false, reason: `shortcut "${shortcut.name}": ${checked.error}` };
    return { ok: true, action: { kind: "path", path: checked.path, app: input.app, label: shortcut.name } };
  }

  const slate = SLATE.exec(raw);
  if (slate) {
    const boardName = (slate[1] ?? slate[2] ?? slate[3] ?? "").replace(/\s+board$/i, "").trim();
    if (!boardName || /^(app|home)$/i.test(boardName)) {
      return { ok: true, action: { kind: "url", url: slateHomeUrl(), label: "Slate", trusted: true } };
    }
    const list = input.boards ? await input.boards() : { boards: [], live: false, reason: "board list unavailable" };
    const matches = findBoards(list.boards, boardName);
    if (!matches.length) {
      return {
        ok: false,
        reason: list.boards.length ? `no Slate board matches "${boardName}"` : `can't see your Slate boards: ${list.reason ?? "no boards"}`,
        candidates: list.boards.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map((b) => b.name),
      };
    }
    const b = matches[0];
    return { ok: true, action: { kind: "url", url: slateBoardUrl(b.id), label: `Slate board “${b.name}”`, trusted: true } };
  }

  const url = safeWebUrl(raw) ?? (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(raw) ? safeWebUrl(`https://${raw}`) : null);
  if (url) return { ok: true, action: { kind: "url", url, label: url, trusted: false } };

  const project = findProject(input.projects, raw.replace(/\s+(?:project|folder|repo)$/i, ""));
  if (project) {
    if (!project.path) return { ok: false, reason: `"${project.name}" has no path in your ledger; add one (path: ~/Desktop/…)` };
    const checked = await checkPath(project.path);
    if ("error" in checked) return { ok: false, reason: `${project.name}: ${checked.error}` };
    return { ok: true, action: { kind: "path", path: checked.path, app: input.app, label: `${project.name}${input.app ? ` in ${input.app}` : ""}` } };
  }

  if (raw.startsWith("~") || raw.startsWith("/")) {
    const checked = await checkPath(raw);
    if ("error" in checked) return { ok: false, reason: checked.error };
    return { ok: true, action: { kind: "path", path: checked.path, app: input.app, label: raw } };
  }

  const app = findApp(raw);
  if (app) return { ok: true, action: { kind: "app", app, label: raw } };

  return {
    ok: false,
    reason: `don't know what "${raw}" is`,
    candidates: [...input.shortcuts.map((s) => s.name), ...input.projects.filter((p) => p.path).map((p) => p.name), "Slate"],
  };
}

// ---------- execution ----------

export type Runner = (args: string[]) => Promise<void>;
export const macOpen: Runner = async (args) => {
  await exec("open", args);
};

export async function performOpen(action: OpenAction, run: Runner = macOpen): Promise<string> {
  switch (action.kind) {
    case "url": {
      const url = safeWebUrl(action.url);
      if (!url) throw new Error("only http and https addresses can be opened");
      await run([url]);
      return `Opened ${action.label}.`;
    }
    case "path": {
      const checked = await checkPath(action.path);
      if ("error" in checked) throw new Error(checked.error);
      if (action.app) {
        const app = findApp(action.app);
        if (!app) throw new Error(`no app called "${action.app}" is installed`);
        await run(["-a", app, checked.path]);
      } else await run([checked.path]);
      return `Opened ${action.label}.`;
    }
    case "app": {
      if (!existsSync(action.app)) throw new Error("that app is no longer installed");
      await run(["-a", action.app]);
      return `Opened ${action.label}.`;
    }
  }
}

// ---------- confirmations ----------

export interface PendingOpen {
  id: string;
  action: OpenAction;
  createdAt: number;
}

const PENDING_TTL_MS = 5 * 60_000;
const pending = new Map<string, PendingOpen>();

export function queueOpen(action: OpenAction): PendingOpen {
  for (const [id, p] of pending) if (Date.now() - p.createdAt > PENDING_TTL_MS) pending.delete(id);
  const p = { id: randomUUID(), action, createdAt: Date.now() };
  pending.set(p.id, p);
  return p;
}

export function takePending(id: string): PendingOpen | null {
  const p = pending.get(id);
  pending.delete(id);
  if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) return null;
  return p;
}

/** Resolve and either open now (trusted) or queue for confirmation (a web address from the model). */
export async function openOrQueue(
  input: ResolveInput,
  run: Runner = macOpen,
): Promise<{ status: "opened"; message: string } | { status: "confirm"; pending: PendingOpen; message: string } | { status: "failed"; message: string; candidates?: string[] }> {
  const r = await resolveOpen(input);
  if (!r.ok) return { status: "failed", message: r.reason, candidates: r.candidates };
  if (r.action.kind === "url" && !r.action.trusted) {
    const p = queueOpen(r.action);
    return { status: "confirm", pending: p, message: `Open ${r.action.url}?` };
  }
  try {
    return { status: "opened", message: await performOpen(r.action, run) };
  } catch (err) {
    return { status: "failed", message: (err as Error).message };
  }
}

export { slateBoards };
