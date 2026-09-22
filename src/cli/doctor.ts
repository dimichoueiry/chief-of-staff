/**
 * `cos doctor`: is this machine ready to run it, and if not, what to do next.
 *
 * Each check turns facts into pass / warn / fail with one line of detail and,
 * when something is off, the command that fixes it. The checks are pure over
 * their inputs so they can be tested; gatherChecks() collects the real facts.
 * Keys are reported by name only, never by value.
 */
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { PROVIDERS, PROVIDER_ORDER, providerConfigured } from "../brain/llm/registry.js";
import type { Config } from "../config.js";
import { memoryState } from "../core/memory.js";
import { bold, dim, green, amber, rose } from "../output/render.js";
import * as launchd from "../scheduler/launchd.js";
import { PROVIDERS as CALENDAR_PROVIDERS, pickProvider } from "../sensors/calendar.js";
import { homeEnvFile } from "../util/env.js";
import { cosHome } from "../util/home.js";

/** The oldest Node every runtime dependency accepts: commander 15 declares >=22.12.0. Keep package.json "engines" in step. */
export const MIN_NODE = "22.12.0";

export type Status = "pass" | "warn" | "fail";

export interface Check {
  name: string;
  status: Status;
  detail: string;
  /** What to run or do when the status is not pass. */
  fix?: string;
}

// ---------- versions ----------

/** "v22.11.0" or "22.11.0" → [22, 11, 0]; anything unreadable → null. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is version a at least version b? */
export function atLeast(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

export function checkNode(version: string = process.versions.node, min: string = MIN_NODE): Check {
  const name = "Node";
  if (atLeast(version, min)) return { name, status: "pass", detail: `${version} (needs ${min} or newer)` };
  return { name, status: "fail", detail: `${version} is older than ${min}, which commander and vitest require`, fix: `install Node ${min} or newer (e.g. nvm install 22), then npm install` };
}

// ---------- install and build ----------

export function checkInstall(root: string, resolves: (pkg: string) => boolean = installedIn(root)): Check {
  const name = "Dependencies";
  const needed = ["commander", "@anthropic-ai/sdk", "openai", "@modelcontextprotocol/sdk", "@playwright/mcp"];
  const missing = needed.filter((p) => !resolves(p));
  if (!missing.length) return { name, status: "pass", detail: "installed" };
  return { name, status: "fail", detail: `missing: ${missing.join(", ")}`, fix: `cd ${root} && npm install` };
}

/** Looks in the project's node_modules directly: several packages' "exports" maps hide package.json from require.resolve. */
function installedIn(root: string): (pkg: string) => boolean {
  return (pkg) => existsSync(join(root, "node_modules", pkg, "package.json"));
}

export function checkBuild(root: string): Check {
  const name = "Build";
  const entry = join(root, "dist", "cli", "cos.js");
  if (existsSync(entry)) return { name, status: "pass", detail: "dist/cli/cos.js is there" };
  return { name, status: "warn", detail: "not built; `npm run cos` works, the `cos` command and packaging need a build", fix: "npm run build" };
}

// ---------- ~/.cos ----------

export function checkCosHome(dir: string = cosHome()): Check {
  const name = "App state";
  if (!existsSync(dir)) return { name, status: "warn", detail: `${dir} does not exist yet; it is created on first use` };
  try {
    if (!statSync(dir).isDirectory()) return { name, status: "fail", detail: `${dir} is a file, not a folder`, fix: `move ${dir} aside` };
    accessSync(dir, constants.W_OK);
  } catch {
    return { name, status: "fail", detail: `${dir} is not writable`, fix: `check the permissions on ${dir}` };
  }
  // A settings file that no longer parses is silently ignored by the app, so name it here.
  const broken = readdirSync(dir).filter((f) => f.endsWith(".json") && !parsesAsJson(join(dir, f)));
  if (broken.length) return { name, status: "warn", detail: `${dir}: unreadable ${broken.join(", ")} (defaults are used instead)`, fix: `fix or delete ${broken.map((f) => join(dir, f)).join(", ")}` };
  return { name, status: "pass", detail: dir };
}

function parsesAsJson(file: string): boolean {
  try {
    JSON.parse(readFileSync(file, "utf8"));
    return true;
  } catch {
    return false;
  }
}

// ---------- keys and memory ----------

/** Names of the providers with a key, and where the keys file is. Never the values. */
export function checkKeys(env: NodeJS.ProcessEnv = process.env, keysFile: string = homeEnvFile()): Check {
  const name = "Model keys";
  const ready = PROVIDER_ORDER.filter((id) => providerConfigured(id, env)).map((id) => PROVIDERS[id].label);
  if (ready.length) return { name, status: "pass", detail: ready.join(", ") };
  return {
    name,
    status: "warn",
    detail: `no provider key set; the brief falls back to rules and ask/capture won't run${existsSync(keysFile) ? "" : ` (${keysFile} not created yet)`}`,
    fix: "cp .env.example .env and add ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY; see cos env",
  };
}

export async function checkMemory(selfhubDir: string): Promise<Check> {
  const name = "Memory";
  const s = await memoryState(selfhubDir);
  if (!s.exists) return { name, status: "warn", detail: `${selfhubDir} does not exist`, fix: "cos init (or set COS_SELFHUB)" };
  if (!s.ready) return { name, status: "warn", detail: `${selfhubDir} is missing ${s.missing.join(", ")}`, fix: "cos init" };
  if (!s.history.on) return { name, status: "warn", detail: `${selfhubDir} ready, but history is off: ${s.history.reason}` };
  return { name, status: "pass", detail: selfhubDir };
}

// ---------- scheduler ----------

export interface JobState {
  label: string;
  installed: boolean;
  loaded: boolean;
}

export function checkScheduler(platform: string, jobs: JobState[]): Check {
  const name = "Scheduler";
  if (platform !== "darwin") return { name, status: "warn", detail: "launchd is macOS only; nothing speaks first on this system" };
  const installed = jobs.filter((j) => j.installed);
  if (!installed.length) return { name, status: "warn", detail: "not installed; the morning brief won't come on its own", fix: "cos scheduler install" };
  const notLoaded = installed.filter((j) => !j.loaded).map((j) => j.label);
  const missing = jobs.filter((j) => !j.installed).map((j) => j.label);
  if (notLoaded.length) return { name, status: "fail", detail: `installed but not loaded: ${notLoaded.join(", ")}`, fix: "cos scheduler install" };
  if (missing.length) return { name, status: "warn", detail: `partly installed; missing ${missing.join(", ")}`, fix: "cos scheduler install" };
  return { name, status: "pass", detail: `${installed.length} jobs loaded` };
}

// ---------- calendar and browser ----------

export function checkCalendar(pinned: string | undefined, picked: string | null): Check {
  const name = "Calendar";
  if (pinned && pinned !== "auto" && !CALENDAR_PROVIDERS[pinned.toLowerCase()]) {
    return { name, status: "fail", detail: `COS_CALENDAR="${pinned}" is not a provider`, fix: "set COS_CALENDAR to icalbuddy, eventkit, none or auto" };
  }
  if (picked === "none") {
    if (pinned === "none") return { name, status: "pass", detail: "off (COS_CALENDAR=none)" };
    return { name, status: "warn", detail: "no calendar reader found; briefs will show no events", fix: "brew install ical-buddy, or xcode-select --install for the EventKit helper" };
  }
  return { name, status: "pass", detail: `${picked}${pinned && pinned !== "auto" ? " (pinned)" : ""}; macOS asks for calendar access on first read` };
}

export interface BrowserFacts {
  /** COS_BROWSER, if set. */
  channel?: string;
  chrome: boolean;
  edge: boolean;
  playwright: boolean;
}

export function checkBrowser(f: BrowserFacts): Check {
  const name = "Browser";
  if (!f.playwright) return { name, status: "fail", detail: "@playwright/mcp is not installed", fix: "npm install" };
  if (f.channel) return { name, status: "pass", detail: `${f.channel} (COS_BROWSER)` };
  if (f.chrome) return { name, status: "pass", detail: "Google Chrome" };
  if (f.edge) return { name, status: "pass", detail: "Microsoft Edge" };
  return { name, status: "warn", detail: "neither Google Chrome nor Microsoft Edge is in /Applications; its own browser won't open", fix: "install Google Chrome, or set COS_BROWSER" };
}

// ---------- the run ----------

/** Run a check, turning a crash into a failure that says what broke rather than stopping the report. */
async function safely(name: string, run: () => Check | Promise<Check>): Promise<Check> {
  try {
    return await run();
  } catch (err) {
    return { name, status: "fail", detail: `could not check: ${(err as Error).message.split("\n")[0]}` };
  }
}

export async function gatherChecks(cfg: Config, root: string): Promise<Check[]> {
  const resolves = installedIn(root);
  return Promise.all([
    safely("Node", () => checkNode()),
    safely("Dependencies", () => checkInstall(root, resolves)),
    safely("Build", () => checkBuild(root)),
    safely("App state", () => checkCosHome()),
    safely("Model keys", () => checkKeys()),
    safely("Memory", () => checkMemory(cfg.selfhubDir)),
    safely("Scheduler", async () => checkScheduler(process.platform, process.platform === "darwin" ? await launchd.status() : [])),
    safely("Calendar", async () => {
      const pinned = process.env.COS_CALENDAR;
      if (pinned && pinned !== "auto" && !CALENDAR_PROVIDERS[pinned.toLowerCase()]) return checkCalendar(pinned, null);
      return checkCalendar(pinned, (await pickProvider(pinned)).name);
    }),
    safely("Browser", () =>
      checkBrowser({
        channel: process.env.COS_BROWSER || undefined,
        chrome: existsSync("/Applications/Google Chrome.app"),
        edge: existsSync("/Applications/Microsoft Edge.app"),
        playwright: resolves("@playwright/mcp"),
      }),
    ),
  ]);
}

const MARK: Record<Status, string> = { pass: green("✓"), warn: amber("!"), fail: rose("✗") };

export function formatReport(checks: Check[]): string {
  const w = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.map((c) => `${MARK[c.status]} ${c.name.padEnd(w)}  ${c.detail}${c.fix ? `\n  ${" ".repeat(w)}  ${dim(`→ ${c.fix}`)}`: ""}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const summary = fails ? `${fails} to fix${warns ? `, ${warns} to look at` : ""}.` : warns ? `Ready. ${warns} to look at.` : "Ready.";
  return `${lines.join("\n")}\n\n${bold(summary)}`;
}

/** 1 when anything failed; warnings alone still exit 0, so a missing optional piece doesn't break scripts. */
export function exitCode(checks: Check[]): number {
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
