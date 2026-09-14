import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepo, git } from "../../src/core/git.js";

/** A throwaway selfhub git repo with a committer identity, so commit-on-write works in CI. */
export async function makeTmpSelfhub(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cos-selfhub-"));
  await ensureRepo(dir);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
