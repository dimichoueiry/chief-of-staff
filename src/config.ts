import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, reloadHomeEnv, syncProjectEnv } from "./util/env.js";

export { loadEnvFile };

/** How much of selfhub goes into every message (COS_IDENTITY_CHARS). Roughly 8k tokens. */
export const DEFAULT_IDENTITY_CHARS = 32_000;

export interface Config {
  selfhubDir: string;
  /** COS_MODEL as written, if set. Which model actually runs is decided in brain/llm/registry.ts. */
  model?: string;
  projectRoots: string[];
  name: string;
  /** Days of silence before a project is resurfaced. */
  silenceDays: number;
  /** Journal days loaded into context. */
  journalDays: number;
  /** Calendar days loaded into context, starting today. */
  calendarDays: number;
  /** Rough size limit for the selfhub identity block in every prompt. */
  identityChars: number;
  /** Minutes of quiet after which the pill starts a new conversation. */
  conversationIdleMinutes: number;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Load keys and settings. When run from the project folder, a newer project .env
 * is first copied to ~/.cos/.env, the file the app and scheduler read. Nothing
 * already set in the environment is overridden. See util/env.ts.
 */
export function loadDotenv(): void {
  try {
    syncProjectEnv();
  } catch {
    /* a read-only home folder must not stop the CLI */
  }
  loadEnvFile(join(process.cwd(), ".env"));
  reloadHomeEnv();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // No default: "last touched" from git activity is worth having, but not worth reading a folder
  // nobody named. An unset value means no scanning, and no macOS prompt for someone's Desktop.
  const roots = (env.COS_PROJECT_ROOTS ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(expandHome);
  return {
    selfhubDir: expandHome(env.COS_SELFHUB ?? join(homedir(), "selfhub")),
    model: env.COS_MODEL || undefined,
    projectRoots: roots,
    name: env.COS_NAME || "",
    silenceDays: Number(env.COS_SILENCE_DAYS) || 14,
    journalDays: Number(env.COS_JOURNAL_DAYS) || 7,
    calendarDays: Math.min(31, Math.max(1, Number(env.COS_CALENDAR_DAYS) || 7)),
    identityChars: Math.max(1_000, Number(env.COS_IDENTITY_CHARS) || DEFAULT_IDENTITY_CHARS),
    conversationIdleMinutes: Math.max(1, Number(env.COS_CONVERSATION_IDLE_MINUTES) || 120),
  };
}
