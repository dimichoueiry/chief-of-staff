/**
 * Tells you, and the assistant, when an Agent Grid agent finishes.
 *
 * Agent Grid streams status changes (GET /api/events); this listens while the UI server runs.
 * A working session that settled (done, failed, needs you, idle, stopped) has finished its turn:
 * that is announced once, with what the agent last said. When the stream drops (Agent Grid
 * restarted, a quiet spell), it connects again with the last event id it saw, Agent Grid replays
 * what was missed, and every id is announced at most once.
 */
import { AgentGrid, AgentGridError, tilde, type AgentEvent } from "./agentgrid.js";

/** How a settled status is said. Anything else (working, unknown) is not a finish. */
export const FINISHED_WORDS: Record<string, string> = { done: "done", complete: "done", failed: "failed", blocked: "needs you", idle: "idle", stopped: "stopped" };

export interface AgentFinished {
  event: AgentEvent;
  /** The status it settled into, as a word for people: done, failed, needs you… */
  word: string;
  /** What the agent last said, when its transcript could be read. */
  lastSaid?: string;
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

/** How a finish is said out loud: one short sentence, since they may not be looking. */
const SPOKEN: Record<string, string> = { done: "is done", failed: "failed", "needs you": "needs you", idle: "is idle", stopped: "stopped" };

/** The notification (title, body), what is said out loud, and the line the conversation gets, for one finish. */
export function describeFinish(f: AgentFinished): { title: string; body: string; speech: string; line: string } {
  const name = f.event.title || "An agent";
  const where = tilde(f.event.cwd) || f.event.project || "";
  const engine = f.event.engine ?? "claude";
  const said = f.lastSaid ? cut(f.lastSaid, 300) : "";
  return {
    title: `${cut(name, 60)}: ${f.word}`,
    body: `${engine}${where ? ` in ${where}` : ""}.${said ? ` ${cut(said, 140)}` : ""}`,
    speech: `${cut(name, 60)} ${SPOKEN[f.word] ?? f.word}.`,
    line: `Agent "${name}" (${engine}${where ? ` in ${where}` : ""}, id ${f.event.sessionId.slice(0, 8)}) finished: ${f.word}.${said ? ` It last said: ${said}` : ""}`,
  };
}

export interface WatchOptions {
  grid: AgentGrid;
  /** Called once per finish, in the order they happened. */
  onFinished: (f: AgentFinished, said: ReturnType<typeof describeFinish>) => Promise<void> | void;
  /** Whether listening is allowed right now (agents access is not off). Off hangs up within a few seconds. */
  allowed?: () => boolean;
  log?: (line: string) => void;
  /** The first wait before connecting again after a drop (default 3 s); it doubles, up to a minute. */
  retryMs?: number;
  /** Silence on the stream that counts as a drop (default 45 s; Agent Grid's heartbeat is every 15 s). */
  idleMs?: number;
}

export interface Watcher {
  stop(): void;
  /** Settles once it has stopped listening. */
  done: Promise<void>;
}

/** How many announced event ids are remembered, so a replayed one is never announced twice. */
const REMEMBER = 500;

/** Listen to Agent Grid until stopped, connecting again whenever the stream drops. */
export function watchAgents(o: WatchOptions): Watcher {
  const log = o.log ?? (() => {});
  const stopped = new AbortController();
  const seen = new Set<string>();
  let lastEventId: string | undefined;
  let paused: string | null = null;
  let connection: AbortController | null = null;

  const allowed = () => !o.allowed || o.allowed();
  // Waits ms, or until stopped. The abort listener comes off again when the timer fires: the watcher
  // waits thousands of times a day while Agent Grid is down, and a listener left on `stopped` each time piled up.
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(t);
        stopped.signal.removeEventListener("abort", wake);
        resolve();
      };
      const t = setTimeout(wake, ms);
      stopped.signal.addEventListener("abort", wake, { once: true });
    });
  // Access switched off while connected: hang up rather than sit on the stream.
  const hangups = setInterval(() => {
    if (connection && !allowed()) connection.abort();
  }, 5_000);
  hangups.unref();

  async function announce(e: AgentEvent): Promise<void> {
    if (e.type !== "status" || !e.finished || !(e.to in FINISHED_WORDS) || !e.id || seen.has(e.id)) return;
    seen.add(e.id);
    if (seen.size > REMEMBER) seen.delete(seen.values().next().value as string);
    const f: AgentFinished = { event: e, word: FINISHED_WORDS[e.to] };
    try {
      f.lastSaid = lastSaid(await o.grid.transcript(e.sessionId));
    } catch {
      /* the finish is still worth telling */
    }
    try {
      await o.onFinished(f, describeFinish(f));
    } catch (err) {
      log(`agent watch: telling about ${e.title} failed: ${(err as Error).message}`);
    }
  }

  async function run(): Promise<void> {
    let wait = o.retryMs ?? 3_000;
    while (!stopped.signal.aborted) {
      if (!allowed()) {
        await sleep(5_000);
        continue;
      }
      connection = new AbortController();
      const hangup = () => connection?.abort();
      stopped.signal.addEventListener("abort", hangup, { once: true });
      try {
        const opened = () => {
          if (paused) log("agent watch: listening to Agent Grid again");
          paused = null;
          wait = o.retryMs ?? 3_000;
        };
        for await (const e of o.grid.events({ lastEventId, signal: connection.signal, idleMs: o.idleMs, onOpen: opened })) {
          if (!allowed()) {
            connection.abort(); // switched off meanwhile: what arrives now is not theirs to hear about
            break;
          }
          if (e.id) lastEventId = e.id;
          await announce(e);
        }
        if (!stopped.signal.aborted && !connection.signal.aborted) log("agent watch: Agent Grid closed the stream");
      } catch (err) {
        const why = err instanceof AgentGridError ? err.message : `Agent Grid: ${(err as Error).message}`;
        if (why !== paused) log(`agent watch paused: ${why}`);
        paused = why;
      } finally {
        stopped.signal.removeEventListener("abort", hangup);
        connection = null;
      }
      if (stopped.signal.aborted) break;
      await sleep(wait);
      wait = Math.min(wait * 2, 60_000);
    }
    clearInterval(hangups);
  }

  return { stop: () => stopped.abort(), done: run() };
}
