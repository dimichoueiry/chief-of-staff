/**
 * Tells you, and the assistant, when an Agent Grid agent finishes.
 *
 * Agent Grid has no event stream, so its session list is polled while the UI server runs.
 * A session that was working and has settled (done, failed, needs you, idle, stopped) has
 * finished its turn: that is announced once, with what the agent last said. Where each
 * session was last seen is kept in ~/.cos/agent-watch.json, so a restart of the app neither
 * repeats an announcement nor misses one that landed while it was down.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cosHome } from "../util/home.js";
import { AgentGrid, AgentGridError, tilde, type AgentSession } from "./agentgrid.js";

/** How a settled status is said. Anything else (working, unknown) is not a finish. */
export const FINISHED_WORDS: Record<string, string> = { done: "done", complete: "done", failed: "failed", blocked: "needs you", idle: "idle", stopped: "stopped" };

export function agentWatchFile(): string {
  return join(cosHome(), "agent-watch.json");
}

/** Last known status per session id. */
export type WatchState = Record<string, string>;

export interface AgentFinished {
  session: AgentSession;
  /** The status it settled into, as a word for people: done, failed, needs you… */
  word: string;
  /** What the agent last said, when its transcript could be read. */
  lastSaid?: string;
}

/**
 * Remembers where every session was last seen and picks out the ones that finished since.
 * The same snapshot seen twice yields nothing the second time; a session that finishes,
 * works again and finishes again is announced each time.
 */
export class AgentWatch {
  constructor(
    private seen: WatchState = {},
    /** A finish older than this (per Agent Grid's idle time) is recorded but not announced: it's stale news. */
    private readonly maxAgeSeconds = 30 * 60,
  ) {}

  get state(): WatchState {
    return { ...this.seen };
  }

  /** Sessions that were working at the last look and have settled now. The very first look only records. */
  observe(sessions: AgentSession[]): AgentSession[] {
    const first = Object.keys(this.seen).length === 0;
    const next: WatchState = {};
    const finished: AgentSession[] = [];
    for (const s of sessions) {
      next[s.sessionId] = s.status;
      const was = this.seen[s.sessionId];
      const fresh = s.idleSeconds === undefined || s.idleSeconds <= this.maxAgeSeconds;
      if (!first && was === "working" && s.status in FINISHED_WORDS && fresh) finished.push(s);
    }
    this.seen = next; // sessions that vanished are forgotten, so the file never grows
    return finished;
  }
}

export function loadWatchState(file: string = agentWatchFile()): WatchState {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as WatchState;
  } catch {
    return {};
  }
}

export function saveWatchState(state: WatchState, file: string = agentWatchFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** The agent's last words from its transcript: what it said, or the error it hit. */
export function lastSaid(blocks: Array<{ kind: string; text?: string; error?: boolean }>): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "assistant" && b.text?.trim()) return b.text.replace(/\s+/g, " ").trim();
    if (b.kind === "result" && b.error && b.text?.trim()) return `error: ${b.text.replace(/\s+/g, " ").trim()}`;
  }
  return undefined;
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** The notification (title, body) and the line the conversation gets, for one finish. */
export function describeFinish(f: AgentFinished): { title: string; body: string; line: string } {
  const name = f.session.title || f.session.customName || "An agent";
  const where = tilde(f.session.cwd) || f.session.project || "";
  const engine = f.session.engine ?? "claude";
  const said = f.lastSaid ? cut(f.lastSaid, 300) : "";
  return {
    title: `${cut(name, 60)}: ${f.word}`,
    body: `${engine}${where ? ` in ${where}` : ""}.${said ? ` ${cut(said, 140)}` : ""}`,
    line: `Agent "${name}" (${engine}${where ? ` in ${where}` : ""}, id ${f.session.sessionId.slice(0, 8)}) finished: ${f.word}.${said ? ` It last said: ${said}` : ""}`,
  };
}

export interface WatchOptions {
  grid: AgentGrid;
  /** Called once per finish, in the order they were seen. */
  onFinished: (f: AgentFinished, said: ReturnType<typeof describeFinish>) => Promise<void> | void;
  /** How often to look (default 15 s). */
  everyMs?: number;
  /** Where the last known statuses are kept between runs; null keeps them in memory only. */
  stateFile?: string | null;
  /** Whether looking is allowed right now (agents access is not off). Checked on every look. */
  allowed?: () => boolean;
  log?: (line: string) => void;
}

export interface Watcher {
  /** Look once, now. Never throws: an unreachable Agent Grid is logged when that changes, and tried again next time. */
  tick(): Promise<void>;
  stop(): void;
}

/** Start looking at Agent Grid every so often. Looks never overlap. */
export function watchAgents(o: WatchOptions): Watcher {
  const file = o.stateFile === undefined ? agentWatchFile() : o.stateFile;
  const watch = new AgentWatch(file ? loadWatchState(file) : {});
  const log = o.log ?? (() => {});
  let looking: Promise<void> | null = null;
  let unreachable: string | null = null;

  async function look(): Promise<void> {
    if (o.allowed && !o.allowed()) return;
    let sessions: AgentSession[];
    try {
      sessions = await o.grid.sessions();
    } catch (err) {
      const why = err instanceof AgentGridError ? err.message : `Agent Grid: ${(err as Error).message}`;
      if (why !== unreachable) log(`agent watch paused: ${why}`);
      unreachable = why;
      return;
    }
    if (unreachable) log("agent watch: Agent Grid is back");
    unreachable = null;
    const finished = watch.observe(sessions);
    // Recorded before anything is announced, so a crash mid-announcement can't repeat it after a restart.
    if (file) {
      try {
        saveWatchState(watch.state, file);
      } catch (err) {
        log(`agent watch: couldn't save ${file}: ${(err as Error).message}`);
      }
    }
    for (const session of finished) {
      const f: AgentFinished = { session, word: FINISHED_WORDS[session.status] };
      try {
        f.lastSaid = lastSaid(await o.grid.transcript(session.sessionId));
      } catch {
        /* the finish is still worth telling */
      }
      try {
        await o.onFinished(f, describeFinish(f));
      } catch (err) {
        log(`agent watch: telling about ${session.title} failed: ${(err as Error).message}`);
      }
    }
  }

  const tick = () => {
    if (!looking) looking = look().finally(() => (looking = null));
    return looking;
  };
  const timer = setInterval(tick, o.everyMs ?? 15_000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
