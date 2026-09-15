/**
 * Where keys come from, in one place.
 *
 * - ~/.cos/.env is the file everything reads: the CLI, the menubar app's server,
 *   and the scheduler. Background processes can't read a repo on the Desktop.
 * - The project's own .env is copied there automatically whenever it is newer,
 *   the next time any `cos` command runs from the project folder.
 * - A long-running server re-reads ~/.cos/.env when it changes, so adding or
 *   changing a key never needs a restart.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { cosHome } from "./home.js";

export function homeEnvFile(): string {
  return join(cosHome(), ".env");
}

/** KEY=value lines; `export`, quotes and trailing comments allowed; empty values ignored. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const quoted = /^(['"])(.*)\1$/.exec(m[2]);
    const value = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, "");
    if (value) out.set(m[1], value);
  }
  return out;
}

function readEnv(file: string): Map<string, string> | null {
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Load a file into process.env without overriding anything already set. */
export function loadEnvFile(file: string): void {
  for (const [k, v] of readEnv(file) ?? []) if (process.env[k] === undefined) process.env[k] = v;
}

/** Keys this process took from ~/.cos/.env, so a reload updates or removes exactly those. */
const fromHome = new Set<string>();
let loadedMtime = -1;
let loadedFile = "";

/**
 * Bring process.env in line with ~/.cos/.env if the file changed since last time.
 * Real environment variables and values from the working directory's .env are never overwritten.
 * Returns true when it re-read the file.
 */
export function reloadHomeEnv(file: string = homeEnvFile()): boolean {
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (mtime === loadedMtime && file === loadedFile) return false;
  loadedMtime = mtime;
  loadedFile = file;
  const values = (mtime && readEnv(file)) || new Map<string, string>();
  for (const k of [...fromHome]) {
    if (!values.has(k)) {
      delete process.env[k];
      fromHome.delete(k);
    }
  }
  for (const [k, v] of values) {
    if (process.env[k] === undefined || fromHome.has(k)) {
      process.env[k] = v;
      fromHome.add(k);
    }
  }
  return true;
}

export type SyncResult = "copied" | "unchanged" | "none";

/** Copy this project's .env to ~/.cos/.env when it is newer. Only for the chief-of-staff folder, never another project's .env. */
export function syncProjectEnv(projectDir: string = process.cwd(), target: string = homeEnvFile()): SyncResult {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as { name?: string };
    if (pkg.name !== "chief-of-staff") return "none";
  } catch {
    return "none";
  }
  const source = join(projectDir, ".env");
  let src;
  try {
    src = statSync(source);
  } catch {
    return "none";
  }
  let dst = null;
  try {
    dst = statSync(target);
  } catch {
    /* not there yet */
  }
  if (dst && dst.mtimeMs >= src.mtimeMs) return "unchanged";
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  return "copied";
}
