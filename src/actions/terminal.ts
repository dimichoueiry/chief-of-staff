/**
 * The terminal, for the assistant. Commands run in your login shell (zsh), not
 * interactively, with a timeout, in a folder you can see.
 *
 * What runs without asking is decided here, not by the model:
 * - safe:    every part only looks (ls, find, git log, grep…) or opens something on screen
 *            (an app, a folder). Runs.
 * - change:  anything else. Waits for your OK in "ask" mode; runs in "auto".
 * - risky:   deletes, force pushes, kills, keychain, piping downloads into a shell.
 *            Waits for your OK even in "auto".
 * - blocked: sudo, erasing disks and the like. Never runs.
 *
 * Provider keys are stripped from the environment commands see, every command is
 * logged to ~/.cos/logs/terminal.log, and long output is saved in full to a file
 * with the part shown to the model said plainly.
 */
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cosHome } from "../util/home.js";
import type { AccessMode } from "./access.js";

export type CommandLevel = "safe" | "change" | "risky" | "blocked";

export interface Classification {
  level: CommandLevel;
  reason: string;
}

// ---------- reading a command line ----------

interface Scan {
  /** Simple commands, split at |, &&, ||, ; and newlines, as word lists. */
  commands: string[][];
  /** Shell features that can hide what runs or write files. */
  features: string[];
}

/** A small shell-aware scanner: quotes respected, operators found, words split. Not a full parser, so anything unusual counts as a change. */
export function scanCommand(line: string): Scan {
  const commands: string[][] = [];
  const features = new Set<string>();
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  /** At a ">" (index i): skip harmless redirects (>/dev/null, 2>&1); flag anything that writes a file. Returns the last index consumed. */
  const redirect = (i: number): number => {
    if (inWord && (word === "1" || word === "2")) {
      word = "";
      inWord = false;
    } else endWord();
    let j = i + 1;
    if (line[j] === ">") j++;
    if (line[j] === "&") {
      j++;
      while (/[0-9-]/.test(line[j] ?? "")) j++;
      return j - 1;
    }
    while (line[j] === " ") j++;
    if (line.startsWith("/dev/null", j)) return j + "/dev/null".length - 1;
    features.add("redirect to a file");
    return j - 1;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) {
        features.add("unclosed quote");
        word += line.slice(i + 1);
        inWord = true;
        break;
      }
      word += line.slice(i + 1, close);
      inWord = true;
      i = close;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\") j++;
        else if (line[j] === "`" || (line[j] === "$" && line[j + 1] === "(")) features.add("command substitution");
      }
      if (j >= line.length) features.add("unclosed quote");
      word += line.slice(i + 1, j);
      inWord = true;
      i = j;
    } else if (c === "\\") {
      word += next ?? "";
      inWord = true;
      i++;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "\n" || c === ";") {
      endCommand();
    } else if (c === "&" && next === ">") {
      i = redirect(i + 1);
    } else if (c === "|" || c === "&") {
      if (c === "&" && next !== "&") features.add("background job");
      if (next === c || (c === "|" && next === "&")) i++;
      endCommand();
    } else if (c === "`" || (c === "$" && next === "(")) {
      features.add("command substitution");
      word += c;
      inWord = true;
    } else if ((c === "<" || c === ">") && next === "(") {
      features.add("process substitution");
      word += c;
      inWord = true;
    } else if (c === ">") {
      i = redirect(i);
    } else if (c === "<") {
      features.add(next === "<" ? "heredoc" : "input from a file");
      endWord();
      if (next === "<") i++;
    } else if (c === "(" || c === ")" || c === "{" || c === "}") {
      features.add("subshell");
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return { commands, features: [...features] };
}

const READ_PROGRAMS = new Set([
  "ls", "pwd", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "wc", "sort", "uniq", "cut", "tr", "column",
  "file", "stat", "du", "df", "tree", "which", "whereis", "type", "echo", "printf", "date", "cal", "whoami", "id", "uname",
  "sw_vers", "hostname", "uptime", "ps", "pgrep", "lsof", "mdfind", "mdls", "locate", "basename", "dirname", "realpath",
  "readlink", "jq", "diff", "cmp", "md5", "shasum", "otool", "nproc", "sysctl", "system_profiler", "defaults", "env", "printenv",
  "true", "test", "[", "less", "more", "bat", "fd", "tldr", "man", "whatis", "sleep", "networksetup", "scutil", "pmset", "ioreg",
  "brew", "npm", "pnpm", "yarn", "pip", "pip3", "node", "python", "python3", "ruby", "go", "cargo", "rustc", "swift", "java",
  "git", "gh", "docker", "open", "find", "sed", "awk", "xargs", "curl", "wget", "code", "cursor", "cd",
]);

/** Files that hold keys and passwords: reading them sends secrets to the model, so it asks first. */
const SECRETS = /(^|[\s\/'"=])(\.env(\.[\w-]+)?|\.ssh|id_(rsa|ed25519|ecdsa)\w*|\.aws|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials(\.json)?|Keychains|Cookies|Login Data|web\.json|\.gnupg)([\s\/'"]|$)/i;

/** Programs that only read in some forms: the args decide. */
function readOnlyUse(words: string[]): boolean {
  const [rawProgram, ...rawArgs] = words;
  // /usr/bin/ls is ls; ./script is not a known program.
  const program = /^\/(usr\/|opt\/homebrew\/|usr\/local\/)?s?bin\/[^/]+$/.test(rawProgram) ? rawProgram.split("/").pop()! : rawProgram;
  // git's global options come before the subcommand: git -C ~/x log.
  const args = program === "git" ? rawArgs.filter((a, i) => !["-C", "-c"].includes(a) && !["-C", "-c"].includes(rawArgs[i - 1]) && a !== "--no-pager" && !a.startsWith("--git-dir") && !a.startsWith("--work-tree")) : rawArgs;
  const sub = args.find((a) => !a.startsWith("-")) ?? "";
  const has = (...flags: string[]) => args.some((a) => flags.includes(a) || flags.some((f) => f.endsWith("=") && a.startsWith(f)));
  switch (program) {
    case "find":
      return !has("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls");
    case "sort":
      return !args.some((a) => a === "-o" || a.startsWith("--output"));
    case "defaults":
      return ["read", "domains", "read-type", "find"].includes(sub);
    case "git":
      if (["status", "log", "diff", "show", "blame", "describe", "rev-parse", "ls-files", "ls-tree", "shortlog", "reflog", "grep", "whatchanged", "cat-file"].includes(sub)) return true;
      if (sub === "branch") return !has("-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--set-upstream-to", "-u") && args.filter((a) => !a.startsWith("-")).length <= 1;
      if (sub === "remote") return args.length === 1 || has("-v", "--verbose") || args[1] === "show" || args[1] === "get-url";
      if (sub === "stash") return args[1] === "list" || args[1] === "show";
      if (sub === "tag") return args.length === 1 || has("-l", "--list");
      if (sub === "config") return has("--get", "--list", "-l", "--get-all");
      return false;
    case "gh":
      return ["status", "view", "list", "diff", "checks"].some((w) => args.includes(w)) && !args.some((a) => ["create", "merge", "close", "delete", "edit", "comment", "review"].includes(a));
    case "brew":
      return ["list", "ls", "info", "search", "outdated", "deps", "config", "doctor", "--version", "--prefix", "leaves", "desc", "home"].includes(sub || args[0]);
    case "npm": case "pnpm": case "yarn":
      return ["ls", "list", "view", "info", "outdated", "why", "-v", "--version", "config"].includes(sub || args[0]) && !(sub === "config" && args[1] !== "get" && args[1] !== "list");
    case "pip": case "pip3":
      return ["list", "show", "freeze", "--version", "-V", "check"].includes(sub || args[0]);
    case "docker":
      return ["ps", "images", "logs", "inspect", "version", "info", "stats"].includes(sub) && !has("-f", "--follow") && !(sub === "stats" && !has("--no-stream"));
    case "node": case "python": case "python3": case "ruby": case "go": case "cargo": case "rustc": case "swift": case "java":
      return args.length > 0 && args.every((a) => ["--version", "-v", "-V", "version"].includes(a));
    case "sed":
      // No in-place edits and no script commands that write or run.
      return !has("-i", "--in-place") && !args.some((a) => /(^|[;\s}])[wWe]\s|\/[wWe]\s/.test(a)) && !args.some((a) => a.startsWith("-i"));
    case "awk":
      return !args.some((a) => /system\s*\(|print[^;]*>|getline|close\s*\(/.test(a));
    case "open": case "code": case "cursor":
      // Opening an app, a folder or a document is fine; web addresses, scripts, installers and passing arguments are not.
      return !args.some((a) => /^[a-z][a-z0-9+.-]*:/i.test(a) || /\.(command|sh|zsh|bash|tool|pkg|dmg|mpkg|terminal|scpt|applescript|workflow|app\/?)$/i.test(a) || a === "--args" || a === "-e" || a === "-t" || a === "-f");
    case "curl": case "wget": case "xargs":
      return false; // network access or running other commands: treated as changes
    case "env": case "printenv":
      return args.every((a) => !a.includes("=") && !/^[a-z]/.test(a)) || program === "printenv";
    case "sleep":
      return Number(args[0]) <= 30;
    case "less": case "more": case "man":
      return false; // interactive: they would wait forever with no terminal
    default:
      return READ_PROGRAMS.has(program);
  }
}

const BLOCKED: [RegExp, string][] = [
  [/(^|[\s;&|(])(sudo|su|doas)(\s|$)/, "it needs an administrator password, which the assistant never has or asks for"],
  [/\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*("?(\/|~|\$HOME)\/?\*?"?)(\s|$)/, "it would delete your whole disk or home folder"],
  [/\b(mkfs|newfs_\w+|fdisk)\b|\bdiskutil\s+(erase\w*|partition\w*|reformat|zero\w*|secureErase)/i, "it erases or repartitions disks"],
  [/\bdd\b[^|;]*\bof=\/dev\//, "it writes straight to a disk device"],
  [/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, "it's a fork bomb"],
  [/(^|[\s;&|])(shutdown|reboot|halt)(\s|$)/, "it shuts down or restarts the Mac"],
  [/\b(csrutil|nvram|spctl\s+--master-disable)\b/, "it changes the Mac's security settings"],
];

const RISKY: [RegExp, string][] = [
  [/(^|[\s;&|])(rm|rmdir|unlink|trash|srm)(\s|$)/, "it deletes files"],
  [/\bgit\s+(push|reset\s+--hard|clean|checkout\s+--\s|restore|rebase|filter-branch|branch\s+-D)/, "it can overwrite or throw away git history"],
  [/(^|[\s;&|])(kill|killall|pkill)(\s|$)/, "it stops running programs"],
  [/\b(chmod|chown)\s+-R\b/, "it changes permissions on a whole folder"],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python3?|node)\b/, "it runs a script straight from the internet"],
  [/(^|[\s;&|])(security|launchctl|crontab|osascript)(\s|$)/, "it touches the keychain, background services or other apps"],
  [/\b(defaults\s+(write|delete)|brew\s+uninstall|npm\s+(publish|unpublish)|docker\s+(rm|rmi|system\s+prune)|dropdb)\b/, "it removes or publishes something"],
];

export function classifyCommand(command: string): Classification {
  const line = command.trim();
  if (!line) return { level: "blocked", reason: "the command is empty" };
  for (const [re, why] of BLOCKED) if (re.test(line)) return { level: "blocked", reason: `never runs: ${why}` };
  for (const [re, why] of RISKY) if (re.test(line)) return { level: "risky", reason: why };
  if (SECRETS.test(line)) return { level: "risky", reason: "it touches a file that holds keys or passwords" };
  const { commands, features } = scanCommand(line);
  if (features.length) return { level: "change", reason: `uses ${features.join(", ")}` };
  const writer = commands.find((words) => {
    const w = words[0]?.includes("=") ? ["env-assignment"] : words;
    return !readOnlyUse(w);
  });
  if (writer) return { level: "change", reason: `${writer[0]} can change things` };
  return { level: "safe", reason: "only looks or opens something" };
}

/** Whether a command at this level runs now, waits for an OK, or never runs, in a given mode. */
export function decide(level: CommandLevel, mode: AccessMode): "run" | "confirm" | "refuse" {
  if (mode === "off" || level === "blocked") return "refuse";
  if (level === "safe") return "run";
  if (level === "risky") return "confirm";
  return mode === "auto" ? "run" : "confirm";
}

// ---------- running ----------

export interface CommandRequest {
  command: string;
  /** Folder to run in; defaults to home. */
  cwd?: string;
  timeoutSeconds?: number;
  /** Open in a Terminal window you can watch instead of running in the background. */
  visible?: boolean;
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export const MAX_SHOWN_CHARS = 12_000;
export const MAX_TIMEOUT_SECONDS = 600;

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function tildePath(p: string): string {
  const home = homedir();
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export async function resolveCwd(raw?: string): Promise<string> {
  const dir = resolve(expandHome((raw ?? "").trim() || "~"));
  let s;
  try {
    s = await stat(dir);
  } catch {
    throw new Error(`the folder ${raw} doesn't exist`);
  }
  if (!s.isDirectory()) throw new Error(`${raw} is a file, not a folder`);
  return dir;
}

/** The environment commands see: yours, minus API keys and other secrets. */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/(_API_KEY|_TOKEN|_SECRET|PASSWORD|_KEY)$/i.test(k) || /^COS_COMPATIBLE_API_KEY$/.test(k)) continue;
    out[k] = v;
  }
  out.TERM = out.TERM ?? "dumb";
  out.NO_COLOR = "1";
  out.GIT_PAGER = "cat";
  out.PAGER = "cat";
  return out;
}

function terminalDir(): string {
  return join(cosHome(), "terminal");
}

function audit(line: string): void {
  try {
    const dir = join(cosHome(), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "terminal.log"), `${new Date().toISOString()}\t${line}\n`, { mode: 0o600 });
  } catch {
    /* logging must never stop a command */
  }
}

export type Shell = (command: string, cwd: string, timeoutMs: number) => Promise<{ exitCode: number | null; timedOut: boolean; output: string }>;

export const loginShell: Shell = (command, cwd, timeoutMs) =>
  new Promise((done) => {
    const child = spawn("/bin/zsh", ["-lc", command], { cwd, env: commandEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.stderr.on("data", (b: Buffer) => chunks.push(b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* gone */
          }
        }, 2000);
      } catch {
        /* gone */
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ exitCode: null, timedOut: false, output: `could not start the shell: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ exitCode: code, timedOut, output: Buffer.concat(chunks).toString("utf8") });
    });
  });

export async function runCommand(req: CommandRequest, how: { shell?: Shell; confirmed?: boolean } = {}): Promise<CommandResult> {
  const cwd = await resolveCwd(req.cwd);
  const timeout = Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.round(req.timeoutSeconds ?? 60)));
  const started = Date.now();
  const r = await (how.shell ?? loginShell)(req.command, cwd, timeout * 1000);
  const result = { command: req.command, cwd, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: Date.now() - started, output: r.output };
  audit(`${how.confirmed ? "confirmed" : "auto"}\texit=${r.timedOut ? "timeout" : r.exitCode}\t${tildePath(cwd)}\t${req.command.replace(/\s*\n\s*/g, " ⏎ ")}`);
  return result;
}

export type Opener = (args: string[]) => Promise<void>;

/** Run in a Terminal window you can watch and type into. Nothing comes back but the fact it opened. */
export async function runVisible(req: CommandRequest, open: Opener, how: { confirmed?: boolean } = {}): Promise<string> {
  const cwd = await resolveCwd(req.cwd);
  const dir = terminalDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.command`);
  const quoted = `'${cwd.replace(/'/g, `'\\''`)}'`;
  writeFileSync(file, `#!/bin/zsh -l\ncd ${quoted} || exit 1\n${req.command}\necho\necho "[finished: exit $?]"\nexec /bin/zsh -l\n`, { mode: 0o700 });
  chmodSync(file, 0o700);
  await open(["-a", "Terminal", file]);
  audit(`${how.confirmed ? "confirmed" : "auto"}\tvisible\t${tildePath(cwd)}\t${req.command.replace(/\s*\n\s*/g, " ⏎ ")}`);
  return `Opened a Terminal window running \`${req.command}\` in ${tildePath(cwd)}. Its output stays in that window.`;
}

/** The result for the model: exit, time, and output with any cut stated and the full text saved. */
export function formatResult(r: CommandResult): string {
  const head = `$ ${r.command}\n(in ${tildePath(r.cwd)}; ${r.timedOut ? "stopped: took longer than the timeout" : `exit ${r.exitCode}`}; ${(r.durationMs / 1000).toFixed(1)}s)`;
  const out = r.output.replace(/\[[0-9;?]*[A-Za-z]/g, "");
  if (!out.trim()) return `${head}\n(no output)`;
  if (out.length <= MAX_SHOWN_CHARS) return `${head}\n${out.trimEnd()}`;
  const dir = terminalDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `output-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  writeFileSync(file, out, { mode: 0o600 });
  const first = out.slice(0, 4_000);
  const last = out.slice(-8_000);
  return `${head}\nThe output is ${out.length.toLocaleString("en-US")} characters; showing the first 4,000 and the last 8,000. The full output is saved at ${tildePath(file)} (search it with grep).\n${first}\n\n… ${(out.length - 12_000).toLocaleString("en-US")} characters not shown …\n\n${last.trimEnd()}`;
}
