/**
 * Package the menubar app so it runs on a Mac that has nothing installed: no Node, no Xcode, no repo.
 *
 * `cos menubar build` makes a developer build: the shell reads ~/.cos/menubar.json and runs the Node on this
 * machine against ~/.cos/app. This makes a self-contained one instead, and a .dmg to hand over:
 *
 *   Chief of Staff.app/Contents/
 *     MacOS/ChiefOfStaff          the Swift shell
 *     Helpers/node                Node itself, this Mac's architecture only
 *     Helpers/cos-calendar …      the Swift helpers, prebuilt (the server otherwise compiles them with swiftc)
 *     Resources/runtime/          dist + production node_modules, what ~/.cos/app holds for a developer build
 *
 * The shell sees Helpers/node and Resources/runtime and uses them (ShellConfig.bundled), copying the helpers to
 * ~/.cos/bin on first launch. Signing is the local certificate unless a Developer ID is named, in which case the
 * app gets the hardened runtime and entitlements notarization needs (docs/DISTRIBUTION.md).
 */
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { ensureEventKitHelper } from "../sensors/calendar.js";
import { ensureScreenHelper } from "../sensors/screen.js";
import { PLAYER_SRC, playerBin } from "../voice/player.js";
import { copyRuntime } from "./deploy.js";
import { APP_NAME } from "./menubar.js";
import { ensureSigningIdentity } from "./signing.js";

const exec = promisify(execFile);

export interface PackageOptions {
  repoRoot: string;
  /** The Node binary to bundle; normally the one running this command. */
  node: string;
  /** Where the .app and .dmg go. Default: <repo>/.build/package. */
  out?: string;
  dmg?: boolean;
  /** A "Developer ID Application: …" identity in the login keychain. Without one, the local certificate signs. */
  identity?: string;
  log?: (line: string) => void;
}

export interface PackageResult {
  app: string;
  dmg?: string;
  signedWith: string;
}

/** What `lipo -archs` printed, as a list. */
export function parseArchs(output: string): string[] {
  return output.trim().split(/\s+/).filter(Boolean);
}

/** The architecture name lipo and Apple use for this process. */
export function appleArch(nodeArch: string = process.arch): string {
  return nodeArch === "x64" ? "x86_64" : nodeArch;
}

/** "Chief-of-Staff-0.1.0-arm64.dmg" */
export function dmgName(version: string, arch: string = appleArch()): string {
  return `${APP_NAME.replace(/\s+/g, "-")}-${version}-${arch}.dmg`;
}

export async function packageApp(o: PackageOptions): Promise<PackageResult> {
  const log = o.log ?? (() => {});
  if (process.platform !== "darwin") throw new Error("Packaging the menubar app is macOS only.");
  const pkgDir = join(o.repoRoot, "apps", "menubar");
  const out = o.out ?? join(o.repoRoot, ".build", "package");
  const app = join(out, `${APP_NAME}.app`);
  const contents = join(app, "Contents");
  const helpers = join(contents, "Helpers");
  const runtime = join(contents, "Resources", "runtime");
  const arch = appleArch();

  log("swift build -c release …");
  await exec("swift", ["build", "-c", "release", "--package-path", pkgDir], { maxBuffer: 32 * 1024 * 1024 });
  const { stdout: binPath } = await exec("swift", ["build", "-c", "release", "--package-path", pkgDir, "--show-bin-path"]);

  log(`assembling ${app}`);
  await rm(app, { recursive: true, force: true });
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(helpers, { recursive: true });
  await cp(join(binPath.trim(), "ChiefOfStaff"), join(contents, "MacOS", "ChiefOfStaff"));
  await chmod(join(contents, "MacOS", "ChiefOfStaff"), 0o755);
  await cp(join(pkgDir, "Info.plist"), join(contents, "Info.plist"));
  await writeFile(join(contents, "PkgInfo"), "APPL????");

  log(`copying the runtime (dist + production packages)`);
  await copyRuntime(o.repoRoot, runtime);

  const node = join(helpers, "node");
  const { stdout: archs } = await exec("lipo", ["-archs", o.node]);
  if (parseArchs(archs).length > 1) {
    log(`bundling node ${process.version} (${arch} slice of ${o.node})`);
    await exec("lipo", ["-thin", arch, "-output", node, o.node]);
  } else {
    log(`bundling node ${process.version} (${o.node})`);
    await cp(o.node, node);
  }
  await chmod(node, 0o755);

  // Built after the runtime is copied, so each helper is newer than its source and the server never recompiles it.
  log("compiling the calendar, screen and player helpers");
  await ensureEventKitHelper(join(helpers, "cos-calendar"));
  await ensureScreenHelper(join(helpers, "cos-screen"));
  await exec("swiftc", ["-O", "-o", join(helpers, basename(playerBin(PLAYER_SRC))), PLAYER_SRC], { timeout: 180_000 });

  const signedWith = await sign(app, helpers, o.identity, pkgDir, log);

  let dmg: string | undefined;
  if (o.dmg !== false) {
    const version = JSON.parse(await readFile(join(o.repoRoot, "package.json"), "utf8")).version as string;
    dmg = join(out, dmgName(version, arch));
    const stage = join(out, "dmg");
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    await cp(app, join(stage, basename(app)), { recursive: true, verbatimSymlinks: true });
    await symlink("/Applications", join(stage, "Applications"));
    await rm(dmg, { force: true });
    log(`writing ${dmg}`);
    // Not -quiet: when hdiutil fails it explains itself on stderr, and that is the only clue there is.
    try {
      await exec("hdiutil", ["create", "-volname", APP_NAME, "-srcfolder", stage, "-ov", "-format", "UDZO", dmg], { maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message: string };
      const said = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`Couldn't write the disk image. hdiutil said:\n${said || e.message}\n\nThe app itself is fine: ${app}`);
    }
    await rm(stage, { recursive: true, force: true });
  }
  return { app, dmg, signedWith };
}

/** Nested executables first, then the bundle. A Developer ID gets the hardened runtime, a timestamp and entitlements. */
async function sign(app: string, helpers: string, identity: string | undefined, pkgDir: string, log: (line: string) => void): Promise<string> {
  const nested = (await readdir(helpers)).map((f) => join(helpers, f));
  let args: string[];
  let name: string;
  if (identity) {
    name = identity;
    args = ["--force", "--sign", identity, "--options", "runtime", "--timestamp", "--entitlements", join(pkgDir, "Entitlements.plist")];
    log(`signing with ${identity} (hardened runtime)`);
  } else {
    try {
      const id = await ensureSigningIdentity(log);
      name = "the local certificate";
      args = ["--force", "--sign", id.sha1, "--keychain", id.keychain];
    } catch (err) {
      log(`couldn't sign with the local certificate (${(err as Error).message.split("\n")[0]}); signing ad-hoc`);
      name = "ad-hoc";
      args = ["--force", "--sign", "-"];
    }
    log(`signing with ${name} (Gatekeeper will ask the first time it opens: right-click › Open)`);
  }
  for (const file of nested) await exec("codesign", [...args, file]);
  await exec("codesign", [...args, app]);
  return name;
}
