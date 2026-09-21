/**
 * Install a runnable copy of the CLI outside the repo, in ~/.cos/app.
 *
 * Why: macOS protects Desktop, Documents and Downloads per app. A background
 * process started by the menubar app or by launchd that reads code from a repo
 * in one of those folders blocks on a permission prompt it may never show, or
 * is refused outright. The copy lives in a folder nobody needs permission for.
 */
import { execFile } from "node:child_process";
import { access, copyFile, cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { homeEnvFile, syncProjectEnv } from "../util/env.js";
import { cosHome } from "../util/home.js";

export { homeEnvFile };

const exec = promisify(execFile);

export function runtimeDir(): string {
  return join(cosHome(), "app");
}

export function runtimeEntry(dir: string = runtimeDir()): string {
  return join(dir, "dist", "cli", "cos.js");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Top-level package folders (node_modules/x or node_modules/@scope/x) needed at runtime. */
export function topLevelPackages(parseable: string, repoRoot: string): string[] {
  const out = new Set<string>();
  for (const line of parseable.split(/\r?\n/)) {
    const rel = relative(repoRoot, line.trim());
    if (!rel.startsWith(`node_modules${sep}`)) continue;
    const parts = rel.split(sep);
    out.add(parts[1]?.startsWith("@") ? parts.slice(0, 3).join(sep) : parts.slice(0, 2).join(sep));
  }
  return [...out].sort();
}

export interface DeployResult {
  dir: string;
  entry: string;
  packages: number;
  env: "copied" | "unchanged" | "none";
}

/** Everything the CLI needs at runtime (dist, package.json, production packages), copied into `dest`. */
export async function copyRuntime(repoRoot: string, dest: string): Promise<number> {
  if (!(await exists(join(repoRoot, "dist", "cli", "cos.js")))) {
    throw new Error(`Build the CLI first: npm run build   (missing ${join(repoRoot, "dist", "cli", "cos.js")})`);
  }
  await mkdir(dest, { recursive: true });
  await cp(join(repoRoot, "dist"), join(dest, "dist"), { recursive: true });
  await copyFile(join(repoRoot, "package.json"), join(dest, "package.json"));

  const { stdout } = await exec("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }).catch(
    // npm ls exits non-zero on harmless peer warnings; the output is still usable.
    (err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }),
  );
  const packages = topLevelPackages(stdout, repoRoot);
  for (const pkg of packages) {
    await mkdir(join(dest, dirname(pkg)), { recursive: true });
    await cp(join(repoRoot, pkg), join(dest, pkg), { recursive: true, dereference: true });
  }
  return packages.length;
}

/** The newest mtime under a folder, or 0 if it isn't there. */
async function newest(dir: string, ext: string): Promise<number> {
  let latest = 0;
  const walk = async (at: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(at, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(ext)) latest = Math.max(latest, (await stat(full)).mtimeMs);
    }
  };
  await walk(dir);
  return latest;
}

/**
 * The app runs the compiled copy, so deploying without building ships whatever was built last and
 * says it shipped what you just wrote. Refuse instead: it costs one command to be sure, where the
 * alternative is watching a change you made not happen and looking for the reason somewhere else.
 */
async function requireFreshBuild(repoRoot: string): Promise<void> {
  const [src, built] = await Promise.all([newest(join(repoRoot, "src"), ".ts"), newest(join(repoRoot, "dist"), ".js")]);
  if (!built) throw new Error("Nothing is built yet. Run `npm run build` first.");
  if (src > built) {
    const behind = Math.round((src - built) / 60_000);
    throw new Error(`dist is ${behind > 0 ? `${behind} minutes ` : ""}older than src, so this would deploy the previous version. Run \`npm run build\` first.`);
  }
}

export async function deployRuntime(repoRoot: string, log: (line: string) => void = () => {}): Promise<DeployResult> {
  await requireFreshBuild(repoRoot);
  const dir = runtimeDir();
  const next = `${dir}.next`;
  const old = `${dir}.old`;
  await rm(next, { recursive: true, force: true });
  log(`copying the runtime to ${dir}`);
  const packages = await copyRuntime(repoRoot, next);

  // Swap in place so a running server never sees a half-copied folder.
  await rm(old, { recursive: true, force: true });
  if (await exists(dir)) await rename(dir, old);
  await rename(next, dir);
  await rm(old, { recursive: true, force: true });

  // Keys: the project's .env is the one you edit; keep the app's copy in step with it.
  const env = syncProjectEnv(repoRoot);
  if (env === "copied") log(`copied .env to ${homeEnvFile()}`);
  return { dir, entry: runtimeEntry(dir), packages, env };
}
