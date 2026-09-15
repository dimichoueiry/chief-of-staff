import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Load KEY=VALUE lines from a .env file into process.env without overriding existing values. */
export function loadDotenv(file: string = join(process.cwd(), ".env")): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const roots = (env.COS_PROJECT_ROOTS ?? join(homedir(), "Desktop"))
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
  };
}
