/**
 * The tools the loop can call. Every write goes through the stores, so every
 * change to memory is a git commit. Read tools exist so the model can check
 * what actually happened (git) before ranking.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import type { ToolSpec } from "./llm/types.js";
import type { Intent } from "../core/context.js";
import { Journal } from "../core/journal.js";
import { Ledger, PROJECT_STATUSES, findProject, type Project, type ProjectPatch } from "../core/ledger.js";
import { Notes } from "../core/notes.js";
import { Reminders } from "../core/reminders.js";
import { openOrQueue, safeWebUrl, checkPath, macOpen, type PendingOpen, type Runner } from "../actions/open.js";
import { Shortcuts } from "../actions/shortcuts.js";
import { slateBoards, type SlateBoard } from "../actions/slate.js";
import { eventsInRange, formatAgenda, type CalendarProvider } from "../sensors/calendar.js";
import { scanActivity } from "../sensors/git.js";
import { addDays, daysBetween, isISODate, todayISO } from "../util/dates.js";

const exec = promisify(execFile);

const s = (description: string) => ({ type: "string" as const, description });

export const TOOLS: Record<string, ToolSpec> = {
  get_project: {
    name: "get_project",
    description: "Read one project's full ledger entry, including done or killed ones not shown in context.",
    parameters: { type: "object", properties: { name: s("Project name (loose match)") }, required: ["name"] },
  },
  upsert_project: {
    name: "upsert_project",
    description:
      "Create a project or update fields on an existing one. Only the fields you pass change. Every call is a git commit.",
    parameters: {
      type: "object",
      properties: {
        name: s("Project name. Existing names match loosely; a new name creates the project."),
        why: s("Why it matters, one line"),
        status: { type: "string", enum: [...PROJECT_STATUSES], description: "active | parked | done | killed" },
        cadence: s('e.g. "Thursday", "mon, wed", "weekly", "daily", "none"'),
        next: s("The single next physical action"),
        deadline: s("YYYY-MM-DD or none"),
        notes: s("Free-form notes"),
        path: s("Folder on disk, e.g. ~/Desktop/drawcal"),
      },
      required: ["name"],
    },
  },
  skip_cadence: {
    name: "skip_cadence",
    description: "Suppress a project's cadence nudge for one cycle without deleting the cadence.",
    parameters: {
      type: "object",
      properties: { name: s("Project name"), until: s("YYYY-MM-DD to resume nudging; defaults to 7 days from today") },
      required: ["name"],
    },
  },
  touch_project: {
    name: "touch_project",
    description: "Record that a project was worked on (moves last touched forward, never back).",
    parameters: {
      type: "object",
      properties: { name: s("Project name"), date: s("YYYY-MM-DD, defaults to today") },
      required: ["name"],
    },
  },
  add_reminder: {
    name: "add_reminder",
    description: "Add a one-off reminder for a specific date.",
    parameters: {
      type: "object",
      properties: { date: s("YYYY-MM-DD"), text: s("What to remind about") },
      required: ["date", "text"],
    },
  },
  complete_reminder: {
    name: "complete_reminder",
    description: "Mark the first open reminder whose text contains the given words as done.",
    parameters: { type: "object", properties: { match: s("Words from the reminder text") }, required: ["match"] },
  },
  add_note: {
    name: "add_note",
    description: "Keep a thought, idea or fact that is not a project or a reminder.",
    parameters: { type: "object", properties: { text: s("The note") }, required: ["text"] },
  },
  append_journal: {
    name: "append_journal",
    description: "Append to today's journal entry (what happened, what's next).",
    parameters: {
      type: "object",
      properties: { text: s("One to four lines"), date: s("YYYY-MM-DD, defaults to today") },
      required: ["text"],
    },
  },
  get_calendar: {
    name: "get_calendar",
    description:
      "Read the user's calendar (read-only) for any date range: further ahead than the days already in memory, past events, or to find free time. " +
      "Dates are YYYY-MM-DD, to is inclusive, at most 92 days per call.",
    parameters: {
      type: "object",
      properties: { from: s("First day, YYYY-MM-DD"), to: s("Last day, YYYY-MM-DD (inclusive); defaults to from") },
      required: ["from"],
    },
  },
  open: {
    name: "open",
    description:
      "Open something on the user's Mac: Slate or a Slate board by name (\"slate\", \"slate board UI/UX\"), one of their shortcuts by name, " +
      "a project's folder (optionally in an app such as Cursor or Terminal), an installed app, a web search (\"search for …\"), or a website. " +
      "Web addresses you come up with are shown to the user to confirm before they open.",
    parameters: {
      type: "object",
      properties: {
        target: s('What to open, e.g. "slate board chief of staff", "gmail", "drawcal", "search for tauri menubar", "https://…"'),
        app: s('Optional app to open a folder or file in, e.g. "Cursor", "Terminal", "Finder"'),
      },
      required: ["target"],
    },
  },
  add_shortcut: {
    name: "add_shortcut",
    description: "Save a named shortcut the user can open later: a web address (http/https) or a folder/document in their home folder.",
    parameters: {
      type: "object",
      properties: { name: s('Short name, e.g. "gmail", "drawcal repo"'), target: s("https://… or ~/path") },
      required: ["name", "target"],
    },
  },
  get_git_log: {
    name: "get_git_log",
    description: "Recent commits for a project's folder (by its path field or a folder named like the project).",
    parameters: {
      type: "object",
      properties: { project: s("Project name"), limit: { type: "integer", description: "Max commits, default 15" } },
      required: ["project"],
    },
  },
};

const ALL = Object.keys(TOOLS);
const WRITES = ["upsert_project", "skip_cadence", "touch_project", "add_reminder", "complete_reminder", "add_note", "append_journal", "add_shortcut"];

/** Which tools each intent may use. The brief is read-only and gets none. */
export function toolsFor(intent: Intent): ToolSpec[] {
  const names: Record<Intent, string[]> = {
    brief: [],
    "silence-check": [],
    ask: ALL,
    capture: [...WRITES, "get_project", "get_calendar"],
    focus: ["get_project", "upsert_project", "get_git_log", "get_calendar", "open"],
    wrap: ["get_project", "append_journal", "touch_project", "upsert_project", "get_git_log"],
  };
  return names[intent].map((n) => TOOLS[n]);
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}

/** Executes tool calls against the real stores for one selfhub. */
export class ToolRuntime {
  readonly ledger: Ledger;
  readonly journal: Journal;
  readonly notes: Notes;
  readonly reminders: Reminders;
  readonly calls: ToolCall[] = [];
  /** Web addresses the model asked to open, waiting for the user to confirm. */
  readonly pendingOpens: PendingOpen[] = [];
  readonly shortcuts: Shortcuts;

  constructor(
    readonly config: Config,
    readonly today: string = todayISO(),
    readonly calendarProvider?: CalendarProvider,
    readonly actions: { run?: Runner; slate?: () => Promise<{ boards: SlateBoard[]; live: boolean; reason?: string }> } = {},
  ) {
    this.shortcuts = new Shortcuts(config.selfhubDir);
    this.ledger = new Ledger(config.selfhubDir);
    this.journal = new Journal(config.selfhubDir);
    this.notes = new Notes(config.selfhubDir);
    this.reminders = new Reminders(config.selfhubDir);
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolCall> {
    let result: string;
    let isError = false;
    try {
      result = await this.dispatch(name, input);
    } catch (err) {
      result = `Error: ${(err as Error).message}`;
      isError = true;
    }
    const call = { name, input, result, isError };
    this.calls.push(call);
    return call;
  }

  private str(input: Record<string, unknown>, key: string, required = false): string {
    const v = input[key];
    if (v === undefined || v === null || v === "") {
      if (required) throw new Error(`"${key}" is required`);
      return "";
    }
    return String(v).trim();
  }

  private date(input: Record<string, unknown>, key: string, fallback?: string): string {
    const v = this.str(input, key);
    if (!v) {
      if (fallback) return fallback;
      throw new Error(`"${key}" is required (YYYY-MM-DD)`);
    }
    if (!isISODate(v)) throw new Error(`"${key}" must be YYYY-MM-DD, got "${v}"`);
    return v;
  }

  private async dispatch(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "get_project": {
        const p = await this.ledger.find(this.str(input, "name", true));
        return p ? JSON.stringify(p, null, 2) : `No project matches "${input.name}".`;
      }
      case "upsert_project": {
        const projectName = this.str(input, "name", true);
        const patch: ProjectPatch = {};
        for (const k of ["why", "status", "cadence", "next", "deadline", "notes", "path"] as const) {
          const v = this.str(input, k);
          if (v) patch[k] = v;
        }
        if (patch.status && !(PROJECT_STATUSES as readonly string[]).includes(patch.status.toLowerCase())) {
          throw new Error(`status must be one of ${PROJECT_STATUSES.join(", ")}`);
        }
        if (patch.status) patch.status = patch.status.toLowerCase();
        if (patch.deadline && patch.deadline !== "none" && !isISODate(patch.deadline)) {
          throw new Error(`deadline must be YYYY-MM-DD or none`);
        }
        const { project, created } = await this.ledger.writeProject(projectName, patch);
        return `${created ? "Created" : "Updated"} "${project.name}": ${JSON.stringify(patch)}`;
      }
      case "skip_cadence": {
        const projectName = this.str(input, "name", true);
        const until = this.date(input, "until", addDays(this.today, 7));
        const { project } = await this.ledger.writeProject(projectName, { skipUntil: until }, `cos: skip cadence for "${projectName}" until ${until}`);
        return `Cadence for "${project.name}" paused until ${until}.`;
      }
      case "touch_project": {
        const projectName = this.str(input, "name", true);
        const date = this.date(input, "date", this.today);
        const moved = await this.ledger.touch(projectName, date);
        const p = await this.ledger.find(projectName);
        if (!p) throw new Error(`No project matches "${projectName}"`);
        return moved ? `"${p.name}" last touched ${date}.` : `"${p.name}" already touched on or after ${date}.`;
      }
      case "add_reminder": {
        const date = this.date(input, "date");
        const text = this.str(input, "text", true);
        await this.reminders.add(date, text);
        return `Reminder set for ${date}: ${text}`;
      }
      case "complete_reminder": {
        const hit = await this.reminders.complete(this.str(input, "match", true));
        return hit ? `Done: ${hit.text}` : `No open reminder matches "${input.match}".`;
      }
      case "add_note": {
        const text = this.str(input, "text", true);
        await this.notes.add(text, this.today);
        return `Noted: ${text}`;
      }
      case "append_journal": {
        const text = this.str(input, "text", true);
        const date = this.date(input, "date", this.today);
        await this.journal.append(date, text);
        return `Journal ${date} updated.`;
      }
      case "get_calendar": {
        const from = this.date(input, "from");
        const to = this.date(input, "to", from);
        if (to < from) throw new Error(`"to" (${to}) is before "from" (${from})`);
        if (daysBetween(from, to) >= 92) throw new Error("at most 92 days per call; split the range into smaller pieces");
        const r = await eventsInRange(from, to, this.calendarProvider);
        if (r.error) throw new Error(`calendar unavailable: ${r.error}`);
        return `Calendar ${from} to ${to} (source: ${r.provider})\n${formatAgenda(r.events, from, to)}`;
      }
      case "open": {
        const r = await openOrQueue(
          {
            target: this.str(input, "target", true),
            app: this.str(input, "app") || undefined,
            shortcuts: await this.shortcuts.list(),
            projects: await this.ledger.read(),
            boards: this.actions.slate ?? (() => slateBoards()),
          },
          this.actions.run ?? macOpen,
        );
        if (r.status === "opened") return r.message;
        if (r.status === "confirm") {
          this.pendingOpens.push(r.pending);
          return `Not opened yet: the user sees a button to confirm opening ${r.pending.action.kind === "url" ? r.pending.action.url : r.pending.action.label}. Tell them it's waiting for their OK.`;
        }
        throw new Error(r.message + (r.candidates?.length ? `. Known: ${r.candidates.join(", ")}` : ""));
      }
      case "add_shortcut": {
        const name = this.str(input, "name", true);
        const target = this.str(input, "target", true);
        if (!safeWebUrl(target)) {
          const checked = await checkPath(target);
          if ("error" in checked) throw new Error(`target must be an http(s) address or something in the home folder: ${checked.error}`);
        }
        const { created } = await this.shortcuts.set(name, target);
        return `${created ? "Saved" : "Updated"} shortcut "${name}" → ${target}`;
      }
      case "get_git_log": {
        const projectName = this.str(input, "project", true);
        const limit = Math.min(Math.max(Number(input.limit) || 15, 1), 100);
        const projects = await this.ledger.read();
        const project = findProject(projects, projectName);
        const dir = await this.projectDir(project, projectName);
        if (!dir) return `No folder found for "${projectName}". Set its path field to enable this.`;
        const { stdout } = await exec("git", ["-C", dir, "log", `-n${limit}`, "--date=short", "--format=%ad  %s"]);
        return stdout.trim() ? `${dir}\n${stdout.trim()}` : `${dir}: no commits.`;
      }
      default:
        throw new Error(`Unknown tool "${name}"`);
    }
  }

  private async projectDir(project: Project | undefined, name: string): Promise<string | null> {
    if (project?.path) return expandHome(project.path);
    const target = (project?.name ?? name).toLowerCase().replace(/[^a-z0-9]+/g, "");
    const activity = await scanActivity(this.config.projectRoots);
    const hit = activity.find((a) => basename(a.path).toLowerCase().replace(/[^a-z0-9]+/g, "") === target);
    return hit?.path ?? null;
  }
}
