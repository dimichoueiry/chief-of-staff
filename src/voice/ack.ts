/**
 * Spoken acknowledgements: a few words said the moment a spoken request arrives, so they know they
 * were heard while the reply is worked out (p50 about 11 s).
 *
 * The words only ever say it was received and what kind of thing happens next. They never say it
 * worked: the reply does that, or says it didn't. "On it." is fine; "Done." or "Opening it now." is not.
 *
 * Deciding which words costs nothing. What the server already knows when the request arrives comes
 * first (capture mode, a yes or no to something waiting, its own open/search/look rules); otherwise a
 * few word rules here. Jev isn't asked: its answer comes mid-turn, and an acknowledgement that waits
 * for a model is no longer immediate.
 */

import { join } from "node:path";
import { cueDir } from "./cues.js";

export type AckIntent = "question" | "lookup" | "action" | "note" | "reply" | "ambiguous";

/** Short, so it is over before most replies are ready. None of them claims anything was done. */
export const ACK_COPY: Record<AckIntent, string> = {
  question: "Looking into it.",
  lookup: "Let me check.",
  action: "On it.",
  note: "Got it.",
  reply: "Okay.",
  ambiguous: "One moment.",
};

/** What the server already decided about this request before anything slow ran. */
export interface KnownIntent {
  /** The pill's mode: "capture" files it, "focus" analyses a project. */
  mode?: string;
  /** A clear yes or no to something the last reply is waiting on (actions/consent.ts). */
  consent?: "yes" | "no" | "unclear";
  /** The server's own rules read it as opening something or searching (OPEN_SHAPE, FAST_OPEN_SHAPE). */
  opens?: boolean;
  /** The server's rules read it as "look at my screen" (LOOK_REQUEST). */
  looks?: boolean;
}

export interface Ack {
  intent: AckIntent;
  text: string;
  /** known: from what the server had already decided; lexical: from the words alone. */
  source: "known" | "lexical";
}

// Said before the request itself: fillers, a greeting, "please".
const LEAD = /^(?:(?:hey|hi|ok(?:ay)?|so|um+|uh+|well|alright|right|please|and|also|actually)[,.!]?\s+)+/i;
// Nothing to work on: the reply is quick and an acknowledgement would only talk over it.
const SMALL_TALK = /^(?:hi|hey|hello|yo|good (?:morning|afternoon|evening)|thanks?(?: you)?|thank you|cheers|ok(?:ay)?|cool|great|nice|got it|never ?mind|bye|goodbye)[.!]*$/i;
const NOTE = /^(?:note(?:\s+(?:that|down))?\b|note:|remember (?:that|to)\b|make a note|take a note|jot (?:this|that|it) down|write (?:this|that|it) down|don'?t let me forget|remind me to\b)/i;
const LOOKUP = new RegExp(
  String.raw`^(?:check|look up|look for|search|find|google|see if|see whether|what'?s (?:on )?my (?:calendar|schedule|agenda|day)|what(?:'?s| is) (?:the )?status|where (?:are|am) (?:we|i) (?:on|with)|how(?:'?s| is) .+ going|any (?:new )?(?:emails?|messages?|mail|updates?|news)|do i have (?:any )?(?:meetings?|emails?|messages?|anything))\b`,
  "i",
);
const DO_VERB = String.raw`(?:open|launch|start|stop|create|make|build|send|draft|write|add|schedule|book|set|move|delete|remove|cancel|update|change|rename|close|run|fix|draw|plan|email|text|message|call|play|pause|turn|show me|pull up|bring up|go to|take me|get|put|save|file|remind me|kick off|spin up|reply|respond|forward|archive|mark|clear|install|deploy|push|merge|commit|order|buy|pay|share|invite|join|log|track|prepare|organi[sz]e|sort|clean up)`;
const ACTION = new RegExp(String.raw`^${DO_VERB}\b`, "i");
// "can you …", "I need you to …": a request, unless what follows only asks to be told something.
const POLITE = /^(?:(?:can|could|would|will) you(?: please)?|i(?:'d| would) like you to|i need you to|i want you to|go ahead and|let'?s|help me)\s+(.+)$/i;
const TELL = /^(?:tell|explain|describe|summari[sz]e|remind me (?:what|who|when|where|why|how)|walk me through|help me (?:understand|think)|think|say|guess|recommend|suggest|give me (?:your|a|an|some) (?:take|opinion|idea|thoughts?|advice))\b/i;
const QUESTION = /^(?:who|what|when|where|why|how|which|whose|whom|is|are|am|was|were|do|does|did|can|could|should|would|will|shall|have|has|had|may|might|isn'?t|aren'?t|don'?t|doesn'?t|didn'?t|tell me|explain|describe|walk me through|what about|how about)\b/i;

/**
 * The acknowledgement for what they said, or null when there should be none (small talk, or nothing
 * said). Pure and synchronous: it must never be the reason the voice starts late.
 */
export function ackFor(said: string, known: KnownIntent = {}): Ack | null {
  const text = said.replace(/\s+/g, " ").trim().replace(LEAD, "").trim();
  if (!text) return null;
  // Before small talk: "okay" to something waiting is a yes.
  const decided = knownIntent(known);
  if (decided) return { intent: decided, text: ACK_COPY[decided], source: "known" };
  if (SMALL_TALK.test(text)) return null;
  const intent = lexicalIntent(text);
  return { intent, text: ACK_COPY[intent], source: "lexical" };
}

/** Where acknowledgements are kept once synthesised, so after the first time they start at once. */
export function ackCacheDir(): string {
  return join(cueDir(), "acks");
}

function knownIntent(k: KnownIntent): AckIntent | null {
  if (k.mode === "capture") return "note";
  if (k.consent === "yes" || k.consent === "no") return "reply";
  if (k.looks) return "lookup";
  if (k.opens) return "action";
  return null;
}

/** The kind of request from its words alone. Anything unclear gets the acknowledgement that promises least. */
export function lexicalIntent(text: string): AckIntent {
  const t = text.replace(LEAD, "").trim();
  if (NOTE.test(t)) return "note";
  if (LOOKUP.test(t)) return "lookup";
  const polite = POLITE.exec(t);
  if (polite) {
    const rest = polite[1].replace(/^please\s+/i, "");
    if (TELL.test(rest)) return "question";
    if (NOTE.test(rest)) return "note";
    if (LOOKUP.test(rest)) return "lookup";
    return "action";
  }
  if (ACTION.test(t)) return "action";
  if (QUESTION.test(t) || /\?\s*$/.test(t)) return "question";
  return "ambiguous";
}
