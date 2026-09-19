import { randomUUID } from "node:crypto";
import type { FastDecision } from "./fastlane.js";
import type { OpenAction } from "../actions/open.js";

export type LiveResult = { kind: "action" | "skip" | "error"; text: string; model?: string };
interface Session {
  id: string;
  expires: number;
  sequence: number;
  pending: number;
  results: Map<number, Promise<LiveResult>>;
  queue: Promise<unknown>;
}

/** One explicitly started microphone session. Duplicate deliveries never repeat an action. */
export class LiveCommands {
  private session: Session | null = null;
  constructor(
    private decide: (text: string) => Promise<FastDecision>,
    private execute: (action: OpenAction, text: string, model: string) => Promise<string>,
    private now: () => number = Date.now,
  ) {}

  start(): string {
    const id = randomUUID();
    this.session = { id, expires: this.now() + 30 * 60_000, sequence: 0, pending: 0, results: new Map(), queue: Promise.resolve() };
    return id;
  }

  stop(id: string): void {
    if (this.session?.id === id) this.session = null;
  }

  submit(id: string, sequence: number, text: string): Promise<LiveResult> {
    const session = this.session;
    const skip = (text: string): Promise<LiveResult> => Promise.resolve({ kind: "skip", text });
    const active = () => this.session === session && this.now() < session!.expires;
    if (!session || session.id !== id || !active()) return skip("Live session ended. Turn Live on again.");
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !text.trim() || text.length > 2_000) return skip("That command wasn't readable.");
    const previous = session.results.get(sequence);
    if (previous) return previous;
    if (sequence <= session.sequence) return skip("Already handled.");
    session.sequence = sequence;
    if (session.pending >= 4) return skip("Too many commands at once. Please repeat that one.");
    session.pending++;
    const result = session.queue.then(async (): Promise<LiveResult> => {
      try {
        if (!active()) return { kind: "skip", text: "Live session ended." };
        const decision = await this.decide(text);
        // Stop/restart wins over an answer that arrives after the microphone session ended.
        if (!active()) return { kind: "skip", text: "Live session ended." };
        if ("skip" in decision) return { kind: "skip", text: "Not a clear open command. Use normal mic mode for questions or longer requests." };
        return { kind: "action", text: await this.execute(decision.open, text, decision.model), model: decision.model };
      } catch {
        return { kind: "error", text: "Couldn't complete that command. Try again or use normal mic mode." };
      } finally {
        session.pending--;
      }
    });
    session.queue = result;
    session.results.set(sequence, result);
    if (session.results.size > 128) session.results.delete(session.results.keys().next().value!);
    return result;
  }
}
