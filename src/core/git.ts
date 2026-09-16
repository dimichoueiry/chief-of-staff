/**
 * git, as an optional part of the machine rather than a given.
 *
 * Memory is markdown in a git repo, and every write is a commit, so you can see and undo anything
 * it did. But `/usr/bin/git` exists on every Mac and *works* only where Apple's command line
 * developer tools are installed. On a Mac without them it is a stub that opens an "install the
 * developer tools?" dialog and fails, so a write that went through git lost the note it was saving.
 *
 * So: the git that runs is resolved once (never touching the stub unless the tools are there, which
 * is what would open that dialog), a missing one is a state the app can show and offer to fix, and a
 * write without it still writes. What is lost then is the history, not the memory.
 */
import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitUnavailableError";
  }
}

export interface GitFound {
  ok: true;
  /** Absolute path of the git that works. */
  path: string;
  version: string;
  /** True when it is Apple's /usr/bin/git, which needs the developer tools. */
  apple: boolean;
}
export interface GitMissing {
  ok: false;
  reason: string;
  /** What fixes it, when something does. */
  fix?: "install-tools";
}
export type GitAvailability = GitFound | GitMissing;

const APPLE_GIT = "/usr/bin/git";

export const NO_TOOLS_REASON =
  "git needs Apple's command line developer tools, which aren't installed on this Mac. Your memory is still written; its history isn't kept until they are.";

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Candidate git binaries from PATH, Apple's stub last, so a Homebrew one is preferred. */
export function gitCandidates(pathVar = process.env.PATH ?? "", override = process.env.COS_GIT): string[] {
  if (override) return [override];
  const dirs = pathVar.split(delimiter).filter(Boolean);
  const found = dirs.map((d) => join(d, "git")).filter((p) => p !== APPLE_GIT);
  return [...new Set([...found, APPLE_GIT])];
}

/** Whether the developer tools are installed. Only `xcode-select`, which never opens the installer. */
async function toolsInstalled(): Promise<boolean> {
  try {
    const { stdout } = await exec("xcode-select", ["-p"], { timeout: 10_000 });
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

/** The machine facts resolution depends on, replaceable so the no-tools path is testable anywhere. */
export interface GitProbe {
  candidates?: string[];
  exists?: (path: string) => Promise<boolean>;
  toolsInstalled?: () => Promise<boolean>;
  version?: (path: string) => Promise<string>;
}

let cached: Promise<GitAvailability> | null = null;

/** Forget the resolved git, so the next call looks again (after installing the tools, and in tests). */
export function resetGit(): void {
  cached = null;
}

/** The git this machine can actually run, resolved once. */
export function gitAvailability(): Promise<GitAvailability> {
  cached ??= resolveGit();
  return cached;
}

export async function resolveGit(probe: GitProbe = {}): Promise<GitAvailability> {
  const exists = probe.exists ?? isExecutable;
  const tools = probe.toolsInstalled ?? toolsInstalled;
  const version = probe.version ?? (async (p: string) => (await exec(p, ["--version"], { timeout: 20_000 })).stdout);
  let sawApple = false;
  for (const candidate of probe.candidates ?? gitCandidates()) {
    if (!(await exists(candidate))) continue;
    // Running Apple's stub is what opens the dialog, so ask xcode-select first and never guess.
    if (candidate === APPLE_GIT) {
      sawApple = true;
      if (!(await tools())) continue;
    }
    try {
      return { ok: true, path: candidate, version: (await version(candidate)).trim(), apple: candidate === APPLE_GIT };
    } catch {
      /* not this one */
    }
  }
  if (sawApple) return { ok: false, reason: NO_TOOLS_REASON, fix: "install-tools" };
  return { ok: false, reason: "No git was found on this machine. Your memory is still written; its history isn't kept until there is one." };
}

/** Ask macOS to install the developer tools: its own installer, the same as `xcode-select --install`. */
export async function installDeveloperTools(): Promise<{ started: boolean; message: string }> {
  const have = await gitAvailability();
  if (have.ok) return { started: false, message: `git already works here (${have.version}).` };
  try {
    await exec("xcode-select", ["--install"], { timeout: 30_000 });
    resetGit();
    return { started: true, message: "macOS is asking to install the command line developer tools. Say yes, then check back in a few minutes." };
  } catch (err) {
    // It exits non-zero when a request is already in flight, which is not a failure worth reporting as one.
    const said = String((err as { stderr?: string }).stderr ?? (err as Error).message);
    resetGit();
    if (/already installed/i.test(said)) return { started: false, message: "The tools are already installed. History will be kept from the next write." };
    if (/already requested|in progress/i.test(said)) return { started: true, message: "macOS is already installing them. Check back in a few minutes." };
    return { started: false, message: `Couldn't start the installer: ${said.split("\n")[0]}. Install Xcode's command line tools by hand, then reopen.` };
  }
}

/**
 * One write at a time per repo. Several surfaces commit to the same memory folder — the pill, the
 * brief, a background catch-up — and two overlapping commits fight over git's index.lock, which
 * surfaces as a write that simply failed. Reads don't queue; only the things that take the lock do.
 */
const writing = new Map<string, Promise<unknown>>();

export function serializeWrites<T>(repoDir: string, work: () => Promise<T>): Promise<T> {
  const queued = (writing.get(repoDir) ?? Promise.resolve()).then(work, work);
  // Keep the chain going whatever happened, and let it be collected once it is the last one.
  const settled = queued.then(
    (v) => v,
    (e) => {
      throw e;
    },
  );
  writing.set(
    repoDir,
    settled.catch(() => undefined),
  );
  void settled.catch(() => undefined).finally(() => {
    if (writing.get(repoDir) === undefined) writing.delete(repoDir);
  });
  return settled;
}

/** Another process is mid-write. Waiting a moment is almost always enough. */
function isLocked(err: unknown): boolean {
  return /index\.lock|Another git process/i.test(String((err as Error)?.message ?? ""));
}

export async function git(repoDir: string, args: string[]): Promise<string> {
  const have = await gitAvailability();
  if (!have.ok) throw new GitUnavailableError(have.reason);
  const { stdout } = await exec(have.path, ["-C", repoDir, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export async function isRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** Absolute path of the repo that owns `dir`, or null. */
export async function topLevel(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Make `dir` the top level of its own git repo. A memory folder nested inside
 * some other repo (a sample inside a project, a folder under ~/Documents that
 * happens to be tracked) gets its own repo so commit-on-write never lands in
 * the parent's history.
 *
 * Without git the folder is still made: the stores are written there, unversioned,
 * and the repo appears the first time git works.
 */
export async function ensureRepo(dir: string): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  if (!(await gitAvailability()).ok) return false;
  const top = await topLevel(dir);
  if (top && top === (await realpath(dir))) return true;
  await serializeWrites(dir, async () => {
    // Another caller may have made it while this one waited.
    if ((await topLevel(dir)) === (await realpath(dir))) return;
    await git(dir, ["init", "-q", "-b", "main"]);
  });
  return true;
}

/**
 * Stage and commit the given paths. Returns the short commit hash, or null when
 * there was nothing to commit — or nothing to commit with. Only the listed paths
 * are committed, so unrelated hand edits in the repo are left alone.
 *
 * A write has already happened by the time this runs, so a machine without git
 * never loses it: this is the history, and it is allowed to be missing.
 */
export async function commitPaths(
  repoDir: string,
  paths: string[],
  message: string,
): Promise<string | null> {
  if (!(await gitAvailability()).ok) return null;
  return serializeWrites(repoDir, async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await git(repoDir, ["add", "--", ...paths]);
        const staged = await git(repoDir, ["diff", "--cached", "--name-only", "--", ...paths]);
        if (!staged.trim()) return null;
        await git(repoDir, ["commit", "-q", "-m", message, "--", ...paths]);
        return (await git(repoDir, ["rev-parse", "--short", "HEAD"])).trim();
      } catch (err) {
        // Another process (the CLI, the scheduler) held the lock. Wait once, then give up quietly:
        // the file is already written, and the history is allowed to lag.
        if (!isLocked(err) || attempt > 0) throw err;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  });
}

/** Which of these paths git doesn't have the current contents of: untracked or changed. */
export async function uncommitted(repoDir: string, paths: string[]): Promise<string[]> {
  if (!paths.length || !(await gitAvailability()).ok) return [];
  try {
    const out = await git(repoDir, ["ls-files", "--others", "--modified", "--exclude-standard", "--", ...paths]);
    return [...new Set(out.split("\n").map((l) => l.trim()).filter(Boolean))];
  } catch {
    return paths; // can't tell, so let the caller try
  }
}

/** Author date (ISO) of the most recent commit in `dir`, or null if none. */
export async function lastCommitDate(dir: string): Promise<string | null> {
  try {
    const out = await git(dir, ["log", "-1", "--format=%aI"]);
    return out.trim() || null;
  } catch {
    return null;
  }
}
