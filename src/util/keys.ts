/**
 * The API keys, as something a UI can show and change.
 *
 * Keys live in ~/.cos/.env (see env.ts). A developer edits that file; anyone who was handed the
 * packaged app can't be asked to, so the menubar app has a window for them and posts here
 * (GET/POST /api/keys). Everything else about a key stays the same: the file is the only store,
 * it is owner-readable only, and the server re-reads it on the next request.
 *
 * A value is never logged or sent back whole: a state shows only whether a key is set and a mask.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PROVIDERS, PROVIDER_ORDER, type ProviderInfo } from "../brain/llm/registry.js";
import type { ProviderId } from "../brain/llm/types.js";
import { homeEnvFile, parseEnv } from "./env.js";

/** The providers whose access is one key someone can paste. "compatible" is a base URL, so it stays in the file. */
export const KEY_PROVIDERS: ProviderId[] = PROVIDER_ORDER.filter((id) => id !== "compatible");

export interface KeyRow {
  provider: ProviderId;
  label: string;
  /** The variable written to ~/.cos/.env. */
  name: string;
  set: boolean;
  /** "sk-ant…4f2a", never the key. */
  masked: string;
  /** Where the value in use comes from. "shell" means this file won't override it. */
  source: "file" | "shell" | null;
  keyUrl: string;
  /** Free text when something about this row needs saying. */
  note?: string;
}

export interface KeysState {
  file: string;
  /** At least one provider can answer. */
  ready: boolean;
  keys: KeyRow[];
}

/** Enough of a key to recognise, not enough to use. */
export function maskKey(value: string): string {
  const v = value.trim();
  if (v.length <= 12) return "•".repeat(Math.max(v.length, 4));
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

/**
 * A pasted key, cleaned up: surrounding quotes and stray whitespace removed. Null when it can't be one.
 * Only the shape is checked here; whether the provider accepts it is a live request's job.
 */
export function cleanKey(input: string): { value: string } | { error: string } {
  let v = input.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(v);
  if (quoted) v = quoted[2].trim();
  if (!v) return { error: "That's empty. Paste the key, or leave it blank and save to remove the one you have." };
  if (/\s/.test(v)) return { error: "That has a space or a line break in it, so part of the page came along with the key. Copy just the key." };
  if ([...v].some((c) => c.charCodeAt(0) < 0x20)) return { error: "That has characters a key can't contain. Copy it again from the provider's page." };
  if (v.length < 12) return { error: "That's too short to be an API key." };
  if (/^(your|sk-xxx|paste|<)/i.test(v)) return { error: "That looks like the example rather than a key." };
  return { value: v };
}

/**
 * Set or remove one variable, keeping every other line, comment and blank line as it was.
 * A value with a space or a # is quoted, so parseEnv reads back exactly what went in.
 */
export function upsertEnvLine(text: string, name: string, value: string | null): string {
  const written = value === null ? null : /[\s#]/.test(value) ? `"${value}"` : value;
  const lines = text.length ? text.split("\n") : [];
  const matches = (line: string) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line);
  let done = false;
  const out: string[] = [];
  for (const line of lines) {
    if (!matches(line)) {
      out.push(line);
      continue;
    }
    if (written === null) continue; // dropped
    if (done) continue; // a duplicate of one already replaced
    out.push(`${name}=${written}`);
    done = true;
  }
  if (!done && written !== null) {
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    out.push(`${name}=${written}`);
  }
  const joined = out.join("\n").replace(/\n+$/, "");
  return joined ? `${joined}\n` : "";
}

/** Write ~/.cos/.env owner-only, through a temporary file so a reader never sees it half written. */
export function writeEnvFile(text: string, file: string = homeEnvFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function readFileText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function rowFor(info: ProviderInfo, inFile: Map<string, string>, env: NodeJS.ProcessEnv): KeyRow {
  const name = info.keyEnv[0];
  const fileKey = info.keyEnv.find((k) => inFile.has(k));
  const shellKey = info.keyEnv.find((k) => !inFile.has(k) && env[k]);
  const value = fileKey ? inFile.get(fileKey)! : shellKey ? String(env[shellKey]) : "";
  const row: KeyRow = {
    provider: info.id,
    label: info.label,
    name: fileKey ?? name,
    set: Boolean(value),
    masked: value ? maskKey(value) : "",
    source: fileKey ? "file" : shellKey ? "shell" : null,
    keyUrl: info.keyUrl,
  };
  if (fileKey && env[fileKey] && env[fileKey] !== inFile.get(fileKey)) {
    row.note = `${fileKey} is also set in the shell that started this, and that one wins until it restarts.`;
  } else if (shellKey) {
    row.note = `${shellKey} comes from the shell that started this, not from the file. Saving here won't change it until it restarts.`;
  }
  return row;
}

/** What the keys window draws. */
export function keysState(file: string = homeEnvFile(), env: NodeJS.ProcessEnv = process.env): KeysState {
  const inFile = existsSync(file) ? parseEnv(readFileText(file)) : new Map<string, string>();
  const keys = KEY_PROVIDERS.map((id) => rowFor(PROVIDERS[id], inFile, env));
  return { file, ready: keys.some((k) => k.set), keys };
}

/**
 * Save a cleaned key, or remove it with null. Nothing is returned on purpose: a state read before the
 * process environment catches up (reloadHomeEnv) still shows the old key, so callers read it after.
 */
export function saveKey(provider: ProviderId, value: string | null, file: string = homeEnvFile()): void {
  const info = PROVIDERS[provider];
  if (!KEY_PROVIDERS.includes(provider)) throw new Error(`${info.label} isn't set up with a key. It needs COS_COMPATIBLE_BASE_URL in ${file}.`);
  let text = readFileText(file);
  // Remove every name this provider accepts, so an old ANTHROPIC_AUTH_TOKEN can't shadow a new key.
  for (const name of info.keyEnv) text = upsertEnvLine(text, name, null);
  if (value !== null) text = upsertEnvLine(text, info.keyEnv[0], value);
  writeEnvFile(text, file);
}
