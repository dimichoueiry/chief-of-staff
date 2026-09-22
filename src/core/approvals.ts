/**
 * What it did for you, and on whose say-so: every action that waited for an OK and how it was
 * answered (tapped or said, yes or no), every heartbeat offer and its answer, and the actions it
 * was allowed to take on its own. The conversation record says the same things in passing; this
 * is the one list to look down, shown on the activity page.
 *
 * App state, not memory: ~/.cos/approvals.jsonl, one line each, newest last, trimmed as it grows.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cosHome } from "../util/home.js";

export interface Approval {
  at: string;
  /** open, command, agent-start, browser-act, offer… */
  kind: string;
  /** What it was, in a few words: "brew install ffmpeg", "Want Wednesday's post tuned?". */
  label: string;
  /** The whole of it: the address, the command and folder, the task. */
  detail?: string;
  /** allowed: they said yes. declined: they said no. failed: yes, but it didn't work. auto: allowed on its own by their settings. done: Proactive+ did it unasked. */
  outcome: "allowed" | "declined" | "failed" | "auto" | "done";
  /** How the answer came: a tap, words, or no answer needed. */
  how: "tapped" | "said" | "auto";
}

const KEEP = 500;

export function approvalsFile(): string {
  return join(cosHome(), "approvals.jsonl");
}

export function recordApproval(a: Omit<Approval, "at"> & { at?: string }, file = approvalsFile()): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    const line = JSON.stringify({ at: a.at ?? new Date().toISOString(), ...a, ...(a.detail && a.detail !== a.label ? {} : { detail: undefined }) });
    appendFileSync(file, `${line}\n`, "utf8");
    // Trim now and then, not on every write.
    if (Math.random() < 0.05) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      if (lines.length > KEEP) writeFileSync(file, `${lines.slice(-KEEP).join("\n")}\n`, "utf8");
    }
  } catch {
    /* a history that can't be written must never stop the action itself */
  }
}

/** Newest first. Damaged lines are skipped. */
export function listApprovals(limit = 100, file = approvalsFile()): Approval[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Approval[] = [];
  for (const line of text.split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line) as Approval;
      if (a && typeof a.label === "string" && typeof a.at === "string") out.push(a);
    } catch {
      /* skip */
    }
    if (out.length >= limit) break;
  }
  return out;
}
