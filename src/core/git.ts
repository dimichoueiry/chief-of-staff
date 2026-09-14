import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repoDir, ...args], {
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

/** Create the directory and initialise a git repo there if it is not one already. */
export async function ensureRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (!(await isRepo(dir))) {
    await git(dir, ["init", "-q", "-b", "main"]);
  }
}

/**
 * Stage and commit the given paths. Returns the short commit hash, or null when
 * there was nothing to commit. Only the listed paths are committed, so unrelated
 * hand edits in the repo are left alone.
 */
export async function commitPaths(
  repoDir: string,
  paths: string[],
  message: string,
): Promise<string | null> {
  await git(repoDir, ["add", "--", ...paths]);
  const staged = await git(repoDir, ["diff", "--cached", "--name-only", "--", ...paths]);
  if (!staged.trim()) return null;
  await git(repoDir, ["commit", "-q", "-m", message, "--", ...paths]);
  return (await git(repoDir, ["rev-parse", "--short", "HEAD"])).trim();
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
