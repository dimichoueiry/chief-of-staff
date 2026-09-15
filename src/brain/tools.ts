/**
 * The tools the loop can call. Every write goes through the stores, so every
 * change to memory is a git commit. Read tools exist so the model can check
 * what actually happened (git) before ranking.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import type { ImageInput, ToolSpec } from "./llm/types.js";
import { describeShot, helperCapturer, type ScreenCapturer } from "../sensors/screen.js";
import { Conversations } from "./conversation.js";
import { searchConversations } from "./recall.js";
import type { Intent } from "../core/context.js";
import { Journal } from "../core/journal.js";
import { Ledger, PROJECT_STATUSES, findProject, type Project, type ProjectPatch } from "../core/ledger.js";
import { Notes } from "../core/notes.js";
import { Reminders } from "../core/reminders.js";
import { readAccess, type Access, type AccessMode } from "../actions/access.js";
import { AgentGrid, findSession, formatSessions, formatTranscript } from "../actions/agentgrid.js";
import { openOrQueue, safeWebUrl, checkPath, macOpen, type Runner } from "../actions/open.js";
import { findBookmarks, formatBookmarks, readBookmarks, type BookmarkRead } from "../actions/bookmarks.js";
import { isPending, queue, take, type ConfirmView, type Pending } from "../actions/pending.js";
import { performPending } from "../actions/perform.js";
import { classifyCommand, decide, formatResult, resolveCwd, runCommand, runVisible, tildePath, type CommandRequest, type Shell } from "../actions/terminal.js";
import { findFolders, formatFolderSearch } from "../actions/folders.js";
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
      "Create a project or update fields on an existing one. Only the fields you pass change. Every call is a git commit. " +
      "Pass only what you know; leave cadence, deadline and notes out rather than filling them with placeholders.",
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
      "a project's folder (optionally in an app such as Cursor or Terminal), an installed app, one of their browser favorites by name " +
      "(\"Campuswire from my UIUC favorites\", opened in the browser it's saved in), a web search (\"search for …\"), or a website (opens straight away).",
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
  get_conversations: {
    name: "get_conversations",
    description:
      "Search every earlier conversation with the user by keywords and/or dates. Use it when they refer to something discussed before " +
      "that isn't in this conversation or in the earlier-conversation summaries in memory (\"what did we decide yesterday\", \"that framework we talked about\"). " +
      "Without keywords, lists the conversations in the date range with their summaries.",
    parameters: {
      type: "object",
      properties: {
        query: s('Keywords, e.g. "pricing tier" or "tauri"'),
        from: s("First day, YYYY-MM-DD (optional)"),
        to: s("Last day, YYYY-MM-DD, inclusive (optional)"),
      },
    },
  },
  find_folder: {
    name: "find_folder",
    description:
      "Find folders on the user's Mac by name, tolerant of misspelling and speech mistakes (\"ML gorilla\" finds mlguerilla). " +
      "Searches Desktop, Documents, GitHub and the usual code folders. Shows each match's git status, last commit, README line and contents. " +
      "Use it whenever you need a project's path; never ask the user to type one.",
    parameters: {
      type: "object",
      properties: {
        name: s("The name as they said it, e.g. \"ML gorilla\" or \"agent grid\""),
        within: s("Optional folder to search first, e.g. ~/Documents/GitHub"),
      },
      required: ["name"],
    },
  },
  run_command: {
    name: "run_command",
    description:
      "Run a shell command on the user's Mac (zsh login shell, non-interactive) in a folder, and get its output. Use it for anything the other tools don't cover: " +
      "looking at files and folders, git, versions, installing, building, running scripts. Commands that only look (ls, find, cat, grep, git log) or open an app or folder run at once; " +
      "anything that changes things may wait for the user's OK, and some (sudo, erasing disks) never run. For long-running or interactive things (a dev server, a REPL), " +
      "set visible so it opens in a Terminal window they can watch.",
    parameters: {
      type: "object",
      properties: {
        command: s("The command line, e.g. \"git -C ~/Documents/GitHub/mlguerilla log -5 --oneline\""),
        cwd: s("Folder to run in, e.g. ~/Documents/GitHub/mlguerilla. Defaults to the home folder."),
        timeout_seconds: { type: "integer", description: "Stop it after this many seconds: default 60, at most 600" },
        visible: { type: "boolean", description: "Open in a Terminal window instead of running in the background (no output comes back)" },
      },
      required: ["command"],
    },
  },
  confirm_pending: {
    name: "confirm_pending",
    description:
      "Carry out, or drop, what your last reply left waiting for their OK (a message to an agent, a command, a new agent, a web page), when their latest message answers it " +
      "(\"yeah go ahead and send it\", \"no, leave it\"). Call it first, before any other tool, and decide only from what they said.",
    parameters: {
      type: "object",
      properties: { decision: { type: "string", enum: ["yes", "no"], description: "yes to do it, no to drop it" } },
      required: ["decision"],
    },
  },
  look_at_screen: {
    name: "look_at_screen",
    description:
      "Take a screenshot of what they're looking at (the display under the pointer, without this assistant's own windows) and see it. " +
      "Use it when they refer to something on screen that you can't see yet: \"this\", \"here\", \"which button\", \"what does it say\", an error they're stuck on. " +
      "Take a new one when they may have moved on; an earlier screenshot is not kept.",
    parameters: { type: "object", properties: {} },
  },
  find_bookmarks: {
    name: "find_bookmarks",
    description: "Search the user's browser favorites and bookmarks (Edge, Chrome, Brave, Arc) by name or folder, e.g. \"campuswire\" or \"UIUC\". To open one, use open with its name.",
    parameters: { type: "object", properties: { query: s("Name or folder, as they said it") }, required: ["query"] },
  },
  get_agents: {
    name: "get_agents",
    description:
      "List the user's Agent Grid sessions: Claude Code and Codex agents, which ones need the user (waiting on them), which are working, where, and the user's last message to each. " +
      "To know what an agent is waiting for, read it with get_agent_output.",
    parameters: { type: "object", properties: {} },
  },
  start_agent: {
    name: "start_agent",
    description:
      "Start a Claude Code or Codex agent through Agent Grid. Use it for coding work, multi-step changes in a codebase, long research, or to build a small script or tool " +
      "you need but don't have (in ~/cos-tools unless a project fits; then run it with run_command). The agent works in the background: check on it later with " +
      "get_agents and get_agent_output. May wait for the user's OK.",
    parameters: {
      type: "object",
      properties: {
        task: s("Complete, self-contained instructions: what to do, where, what done looks like. The agent sees nothing of this conversation."),
        folder: s("The project folder, e.g. ~/Documents/GitHub/mlguerilla (created and added to Agent Grid if new). Leave out for a task with no project."),
        engine: { type: "string", enum: ["claude", "codex"], description: "claude (default) or codex" },
        name: s("A short label shown in Agent Grid, e.g. \"module 6 quiz\""),
        visible: { type: "boolean", description: "Open it in a Terminal tab they can watch and type into, instead of in the background" },
      },
      required: ["task"],
    },
  },
  get_agent_output: {
    name: "get_agent_output",
    description: "Read the end of an Agent Grid session's transcript: what the agent did, its last message, and any errors.",
    parameters: { type: "object", properties: { session: s("Session id (the first 8 characters are enough) or part of its title") }, required: ["session"] },
  },
  message_agent: {
    name: "message_agent",
    description: "Send a message to an Agent Grid session: answer an agent that needs the user, or give it a follow-up task. May wait for the user's OK.",
    parameters: {
      type: "object",
      properties: { session: s("Session id or part of its title"), message: s("What to tell the agent") },
      required: ["session", "message"],
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
/** Tools that do something outside memory: the conversation record lists what they did. */
export const ACTIONS = ["open", "run_command", "start_agent", "message_agent"];

/** Tools that change memory. Everything else only reads or opens. */
export const WRITES = ["upsert_project", "skip_cadence", "touch_project", "add_reminder", "complete_reminder", "add_note", "append_journal", "add_shortcut"];

/** Which tools each intent may use. The brief is read-only and gets none. */
export function toolsFor(intent: Intent): ToolSpec[] {
  const names: Record<Intent, string[]> = {
    brief: [],
    "silence-check": [],
    ask: ALL,
    capture: [...WRITES, "get_project", "get_calendar", "find_folder"],
    focus: ["get_project", "upsert_project", "get_git_log", "get_calendar", "open", "get_conversations", "find_folder", "run_command", "get_agents", "start_agent", "get_agent_output", "confirm_pending", "look_at_screen"],
    wrap: ["get_project", "append_journal", "touch_project", "upsert_project", "get_git_log", "get_conversations"],
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
  /** Images the tool produced (a screenshot), shown to the model right after the result and never stored. */
  images?: ImageInput[];
}

/** Executes tool calls against the real stores for one selfhub. */
export class ToolRuntime {
  readonly ledger: Ledger;
  readonly journal: Journal;
  readonly notes: Notes;
  readonly reminders: Reminders;
  readonly calls: ToolCall[] = [];
  /** Things the model asked to do that wait for the user's OK: web addresses, commands, agents. */
  readonly pending: Pending[] = [];
  /** Actions carried out in this run (confirmed, or allowed to run on their own), so they aren't repeated. */
  readonly done: { kind: string; detail: string }[] = [];
  readonly shortcuts: Shortcuts;

  constructor(
    readonly config: Config,
    readonly today: string = todayISO(),
    readonly calendarProvider?: CalendarProvider,
    readonly actions: {
      run?: Runner;
      slate?: () => Promise<{ boards: SlateBoard[]; live: boolean; reason?: string }>;
      conversations?: Conversations;
      /** How commands run (tests). */
      shell?: Shell;
      agentGrid?: AgentGrid;
      access?: () => Access;
      /** What the previous reply left waiting for the user's OK (see confirm_pending). */
      awaiting?: ConfirmView[];
      /** Actions carried out recently in this conversation, so they aren't queued again. */
      recentlyDone?: { kind: string; detail: string }[];
      bookmarks?: () => Promise<BookmarkRead>;
      screen?: ScreenCapturer;
    } = {},
  ) {
    this.shortcuts = new Shortcuts(config.selfhubDir);
    this.ledger = new Ledger(config.selfhubDir);
    this.journal = new Journal(config.selfhubDir);
    this.notes = new Notes(config.selfhubDir);
    this.reminders = new Reminders(config.selfhubDir);
  }

  /** Images the tool being run produced; taken by execute(). */
  private images: ImageInput[] = [];

  async execute(name: string, input: Record<string, unknown>): Promise<ToolCall> {
    let result: string;
    let isError = false;
    this.images = [];
    try {
      result = await this.dispatch(name, input);
    } catch (err) {
      result = `Error: ${(err as Error).message}`;
      isError = true;
    }
    const call: ToolCall = { name, input, result, isError, ...(this.images.length ? { images: this.images } : {}) };
    this.images = [];
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
            bookmarks: this.actions.bookmarks ?? (() => readBookmarks()),
          },
          this.actions.run ?? macOpen,
          { confirmLinks: (this.actions.access ?? readAccess)().links !== "auto" },
        );
        if (r.status === "opened") return r.message;
        if (r.status === "confirm") {
          const twice = this.repeated("open", r.pending.detail);
          if (twice) {
            take(r.pending.id);
            return twice;
          }
          this.pending.push(r.pending);
          return `Not opened yet: ask them "Should I open ${r.pending.detail}?". They can just say yes.`;
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
      case "get_conversations": {
        const from = this.str(input, "from");
        const to = this.str(input, "to");
        for (const [k, v] of [["from", from], ["to", to]]) if (v && !isISODate(v)) throw new Error(`"${k}" must be YYYY-MM-DD, got "${v}"`);
        if (from && to && to < from) throw new Error(`"to" (${to}) is before "from" (${from})`);
        return searchConversations(this.actions.conversations ?? new Conversations(), {
          query: this.str(input, "query") || undefined,
          from: from || undefined,
          to: to || undefined,
        });
      }
      case "find_folder": {
        const within = this.str(input, "within");
        const r = await findFolders(this.str(input, "name", true), {
          roots: [...(within ? [expandHome(within)] : []), ...this.config.projectRoots],
        });
        return formatFolderSearch(r);
      }
      case "run_command": {
        const command = this.str(input, "command", true);
        const mode = (this.actions.access ?? readAccess)().terminal;
        if (mode === "off") throw new Error("Terminal access is off. They can turn it on with `cos access terminal ask`.");
        const { level, reason } = classifyCommand(command);
        const verdict = decide(level, mode);
        if (verdict === "refuse") throw new Error(`Refused: ${reason}.`);
        const req: CommandRequest = {
          command,
          cwd: await resolveCwd(this.str(input, "cwd") || undefined),
          timeoutSeconds: Number(input.timeout_seconds) || undefined,
          visible: input.visible === true,
        };
        if (verdict === "confirm") {
          const detail = `$ ${command}\nin ${tildePath(req.cwd!)}${req.visible ? ", in a Terminal window" : ""}`;
          const twice = this.repeated("command", detail);
          if (twice) return twice;
          this.pending.push(queue("command", req, { label: command.length > 60 ? `${command.slice(0, 57)}…` : command, detail, verb: "Run" }));
          return `Not run yet (${reason}). Ask them in one short sentence whether to do it, saying what it will do. They can just say yes.`;
        }
        if (req.visible) return runVisible(req, this.actions.run ?? macOpen);
        return formatResult(await runCommand(req, { shell: this.actions.shell }));
      }
      case "confirm_pending": {
        if (this.calls.some((c) => c.name !== "confirm_pending")) {
          throw new Error("confirm_pending has to come first in a reply, decided only from what they said. Nothing was done; ask them again.");
        }
        const waiting = (this.actions.awaiting ?? []).filter((v) => isPending(v.id));
        if (!waiting.length) return "Nothing is waiting for their OK (it was already done, dropped, or it expired after 5 minutes).";
        const yes = this.str(input, "decision", true) === "yes";
        const lines: string[] = [];
        for (const v of waiting) {
          const p = take(v.id);
          if (!p) continue;
          if (!yes) {
            lines.push(`Dropped, as they said: ${p.label}.`);
            continue;
          }
          try {
            const out = await performPending(p, { run: this.actions.run, shell: this.actions.shell, agentGrid: this.actions.agentGrid });
            this.done.push({ kind: p.kind, detail: p.detail });
            lines.push(`Done, as they said (already done: do not do it again): ${p.label}. Result: ${out}`);
          } catch (err) {
            lines.push(`They said yes, but it failed: ${p.label}: ${(err as Error).message}`);
          }
        }
        return lines.join("\n");
      }
      case "look_at_screen": {
        if ((this.actions.access ?? readAccess)().screen === "off") throw new Error("Looking at the screen is off. They can turn it on with `cos access screen auto`.");
        const shot = await (this.actions.screen ?? helperCapturer).capture();
        this.images = [{ mediaType: shot.mediaType, data: shot.data }];
        return `${describeShot(shot)} The image follows.`;
      }
      case "find_bookmarks": {
        const query = this.str(input, "query", true);
        const read = await (this.actions.bookmarks ?? (() => readBookmarks()))();
        return formatBookmarks(read, findBookmarks(read.bookmarks, query), query);
      }
      case "get_agents":
        this.agentsAllowed();
        return formatSessions(await this.grid().sessions());
      case "start_agent": {
        const mode = this.agentsAllowed();
        const task = this.str(input, "task", true);
        const folderRaw = this.str(input, "folder");
        const folder = folderRaw ? resolve(expandHome(folderRaw)) : undefined;
        if (folder && folder !== homedir() && !folder.startsWith(`${homedir()}/`)) throw new Error("agents can only work in folders inside the home folder");
        const engine = this.str(input, "engine") === "codex" ? "codex" : "claude";
        const job = { task, folder, engine, name: this.str(input, "name") || undefined, visible: input.visible === true } as const;
        if (mode === "ask") {
          const detail = `${engine} in ${folder ? tildePath(folder) : "~/Desktop (no project)"}${job.visible ? ", in a Terminal tab" : ""}\nTask: ${task}`;
          const twice = this.repeated("agent-start", detail);
          if (twice) return twice;
          this.pending.push(queue("agent-start", job, { label: `${engine} agent${job.name ? `: ${job.name}` : ""}`, detail, verb: "Start agent" }));
          return "Not started yet. Ask them in one short sentence whether to start it, saying what the agent will do. They can just say yes.";
        }
        const detail = `${engine} in ${folder ? tildePath(folder) : "~/Desktop (no project)"}${job.visible ? ", in a Terminal tab" : ""}\nTask: ${task}`;
        const again = this.repeated("agent-start", detail);
        if (again) return again;
        const started = await this.grid().start(job);
        this.done.push({ kind: "agent-start", detail });
        return started;
      }
      case "get_agent_output": {
        this.agentsAllowed();
        const grid = this.grid();
        const found = findSession(await grid.sessions(), this.str(input, "session", true));
        if ("error" in found) throw new Error(found.error);
        return formatTranscript(found, await grid.transcript(found.sessionId));
      }
      case "message_agent": {
        const mode = this.agentsAllowed();
        const grid = this.grid();
        const found = findSession(await grid.sessions(), this.str(input, "session", true));
        if ("error" in found) throw new Error(found.error);
        const message = this.str(input, "message", true);
        if (mode === "ask") {
          const detail = `To ${found.title} (${found.sessionId.slice(0, 8)}):\n${message}`;
          const twice = this.repeated("agent-message", detail);
          if (twice) return twice;
          this.pending.push(queue("agent-message", { sessionId: found.sessionId, title: found.title, message }, { label: `message to ${found.title}`, detail, verb: "Send" }));
          return `Not sent yet. Ask them "Should I send this to ${found.title}?" and read the message to them (word for word if it's short, otherwise its gist). They can just say yes.`;
        }
        const detail = `To ${found.title} (${found.sessionId.slice(0, 8)}):\n${message}`;
        const again = this.repeated("agent-message", detail);
        if (again) return again;
        await grid.message(found.sessionId, message);
        this.done.push({ kind: "agent-message", detail });
        return `Sent to ${found.title}.`;
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

  /** Why not to queue this again, if it is already waiting or was just done; null when it's new. */
  private repeated(kind: string, detail: string): string | null {
    const same = (v: { kind: string; detail: string }) => v.kind === kind && v.detail === detail;
    if (this.pending.some(same) || (this.actions.awaiting ?? []).some((v) => same(v) && isPending(v.id))) {
      return "This exact thing is already waiting for their OK. Don't queue it again: if their latest message agrees, call confirm_pending; otherwise ask them once more.";
    }
    if ((this.actions.recentlyDone ?? []).some(same) || this.done.some(same)) {
      return "This exact thing was already done a moment ago. Don't do it again unless they clearly ask for it to be repeated.";
    }
    return null;
  }

  private grid(): AgentGrid {
    return this.actions.agentGrid ?? new AgentGrid();
  }

  private agentsAllowed(): AccessMode {
    const mode = (this.actions.access ?? readAccess)().agents;
    if (mode === "off") throw new Error("Agent Grid access is off. They can turn it on with `cos access agents ask`.");
    return mode;
  }

  private async projectDir(project: Project | undefined, name: string): Promise<string | null> {
    if (project?.path) return expandHome(project.path);
    const target = (project?.name ?? name).toLowerCase().replace(/[^a-z0-9]+/g, "");
    const activity = await scanActivity(this.config.projectRoots);
    const hit = activity.find((a) => basename(a.path).toLowerCase().replace(/[^a-z0-9]+/g, "") === target);
    return hit?.path ?? null;
  }
}
