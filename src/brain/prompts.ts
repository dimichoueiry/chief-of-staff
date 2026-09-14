import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Intent } from "../core/context.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Prompt templates are files so behaviour can be tuned without shipping code. */
export async function loadPrompt(intent: Intent): Promise<string> {
  const file = join(here, "prompts", `${intent}.md`);
  return (await readFile(file, "utf8")).trim();
}

/** The user turn sent when the caller gives no message of their own. */
export const DEFAULT_MESSAGES: Record<Intent, string> = {
  brief: "Give me today's brief.",
  ask: "What should I do today?",
  focus: "What are the three highest-leverage moves right now?",
  capture: "",
  wrap: "Wrap up my day.",
  "silence-check": "Which projects have gone quiet?",
};
