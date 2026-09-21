/**
 * A record of what happened between something being said and the reply: the words that came in, every
 * step taken on the way, and how it ended. For working out why a command went wrong, which the server
 * log can't answer because it interleaves every request and keeps no shape.
 *
 * One line of JSON per turn in ~/.cos/traces/YYYY-MM-DD.jsonl. `cos trace` reads them back.
 *
 * Steps are added from wherever they happen without being passed down through every function, by
 * keeping the turn in an AsyncLocalStorage: anything running inside `traced` can call `step`, and
 * anything running outside it does nothing at all.
 *
 * TO REMOVE THIS ENTIRELY: delete this file, its test, the `trace` command in cli/cos.ts, and the
 * `traced(` wrapper and `step(` calls elsewhere (`grep -rn "util/trace" src`). Nothing else depends
 * on it, no other behaviour changes, and the traces directory can be deleted by hand.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cosHome } from "./home.js";

export interface Step {
  /** Milliseconds since the turn started. */
  at: number;
  /** Who took it: "jev", "tool", "browser", "model", "reply", "error". */
  kind: string;
  detail: string;
  /** Numbers worth seeing later: a confidence, how long it took, which model. */
  data?: Record<string, unknown>;
}

export interface Turn {
  at: string;
  ms: number;
  /** What was said, as the assistant received it. */
  said: string;
  mode?: string;
  steps: Step[];
}

/** Long enough to show what happened, short enough that a day of use stays a small file. */
const MAX_DETAIL = 400;
const MAX_STEPS = 200;

const turns = new AsyncLocalStorage<{ started: number; said: string; mode?: string; steps: Step[] }>();

export function tracesDir(): string {
  return join(cosHome(), "traces");
}

export function traceFile(day = new Date()): string {
  return join(tracesDir(), `${day.toISOString().slice(0, 10)}.jsonl`);
}

/** Off with COS_TRACE=off, for when the traces are in the way rather than the point. */
function on(): boolean {
  return (process.env.COS_TRACE ?? "").toLowerCase() !== "off";
}

/** Run one turn, and write down what it did whether it succeeds or throws. */
export async function traced<T>(said: string, mode: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!on()) return fn();
  const turn = { started: Date.now(), said, mode, steps: [] as Step[] };
  return turns.run(turn, async () => {
    try {
      return await fn();
    } catch (err) {
      step("error", (err as Error).message);
      throw err;
    } finally {
      write({ at: new Date(turn.started).toISOString(), ms: Date.now() - turn.started, said, mode, steps: turn.steps });
    }
  });
}

/** Note a step in the turn now running. Outside a turn, and with tracing off, it does nothing. */
export function step(kind: string, detail: string, data?: Record<string, unknown>): void {
  const turn = turns.getStore();
  if (!turn || turn.steps.length >= MAX_STEPS) return;
  turn.steps.push({ at: Date.now() - turn.started, kind, detail: cut(detail), ...(data ? { data } : {}) });
}

function cut(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= MAX_DETAIL ? line : `${line.slice(0, MAX_DETAIL)}…`;
}

/** Tracing must never be why something failed, so a file that can't be written is simply not written. */
function write(turn: Turn): void {
  try {
    mkdirSync(tracesDir(), { recursive: true });
    appendFileSync(traceFile(), `${JSON.stringify(turn)}\n`, { mode: 0o600 });
  } catch {
    /* not worth breaking a reply over */
  }
}

/** The most recent turns, newest last, across as many days as it takes to find them. */
export function readTraces(limit = 10, dir = tracesDir()): Turn[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const out: Turn[] = [];
  for (const file of files.reverse()) {
    const lines = readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
    for (const line of lines.reverse()) {
      try {
        out.push(JSON.parse(line) as Turn);
      } catch {
        continue; // a half-written last line
      }
      if (out.length >= limit) return out.reverse();
    }
  }
  return out.reverse();
}

/** One turn as a few lines to read: what was said, each step with its timing, and how it ended. */
export function formatTurn(turn: Turn): string {
  const head = `${turn.at.slice(11, 19)}  "${turn.said}"${turn.mode && turn.mode !== "auto" ? ` (${turn.mode})` : ""}  ${turn.ms}ms`;
  const steps = turn.steps.map((s) => {
    const data = s.data ? `  ${Object.entries(s.data).map(([k, v]) => `${k}=${typeof v === "number" ? round(v) : v}`).join(" ")}` : "";
    return `  ${String(s.at).padStart(6)}ms  ${s.kind.padEnd(7)} ${s.detail}${data}`;
  });
  return [head, ...steps].join("\n");
}

const round = (n: number) => (Number.isInteger(n) ? n : Number(n.toFixed(3)));
