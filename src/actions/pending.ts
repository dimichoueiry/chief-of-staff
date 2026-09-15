/**
 * Things the assistant wants to do that wait for the user's OK: a web address
 * it came up with, a command that changes something, a new agent. Only the
 * user confirms (a button in the pill, or saying yes); the model has no way to.
 * Single use, and they expire.
 */
import { randomUUID } from "node:crypto";

export interface Pending<T = unknown> {
  id: string;
  kind: string;
  payload: T;
  /** Short name for the button and the conversation record: "brew install ffmpeg". */
  label: string;
  /** Exactly what will happen, shown in full: the address, the command and folder, the task. */
  detail: string;
  /** The button: "Open", "Run", "Start agent", "Send". */
  verb: string;
  createdAt: number;
}

export const PENDING_TTL_MS = 5 * 60_000;
const store = new Map<string, Pending>();

function sweep(now = Date.now()): void {
  for (const [id, p] of store) if (now - p.createdAt > PENDING_TTL_MS) store.delete(id);
}

export function queue<T>(kind: string, payload: T, view: { label: string; detail: string; verb: string }): Pending<T> {
  sweep();
  const p: Pending<T> = { id: randomUUID(), kind, payload, ...view, createdAt: Date.now() };
  store.set(p.id, p);
  return p;
}

/** Remove and return a pending action, or null if it is unknown, used or expired. */
export function take(id: string): Pending | null {
  const p = store.get(id);
  store.delete(id);
  if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) return null;
  return p;
}

/** Still waiting? */
export function isPending(id: string): boolean {
  const p = store.get(id);
  return Boolean(p && Date.now() - p.createdAt <= PENDING_TTL_MS);
}

/** What the pill shows for a pending action. */
export function confirmView(p: Pending) {
  return { id: p.id, kind: p.kind, label: p.label, detail: p.detail, verb: p.verb };
}
export type ConfirmView = ReturnType<typeof confirmView>;
