/**
 * Build, open and install the native menubar shell (apps/menubar, Swift).
 * The shell hosts the same local page `cos ui` serves, adds the system-wide
 * hotkey and native listening, and starts the server itself.
 */
import { execFile } from "node:child_process";
import { access, chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENTS_DIR, LOG_DIR } from "../scheduler/launchd.js";

const exec = promisify(execFile);

export const APP_NAME = "Chief of Staff";
export const APP_PATH = join(homedir(), "Applications", `${APP_NAME}.app`);
export const SHELL_CONFIG = join(homedir(), ".cos", "menubar.json");
export const LOGIN_LABEL = "com.chief-of-staff.menubar";

export interface BuildOptions {
  repoRoot: string;
  node: string;
  port: number;
  log?: (line: string) => void;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** swift build → assemble the .app bundle → ad-hoc sign → write the shell config. */
export async function buildMenubar(o: BuildOptions): Promise<string> {
  const log = o.log ?? (() => {});
  const pkg = join(o.repoRoot, "apps", "menubar");
  const entry = join(o.repoRoot, "dist", "cli", "cos.js");
  if (!(await exists(entry))) throw new Error(`Build the CLI first: npm run build   (missing ${entry})`);
  if (process.platform !== "darwin") throw new Error("The menubar shell is macOS only.");

  log("swift build -c release …");
  await exec("swift", ["build", "-c", "release", "--package-path", pkg], { maxBuffer: 32 * 1024 * 1024 });
  const { stdout } = await exec("swift", ["build", "-c", "release", "--package-path", pkg, "--show-bin-path"]);
  const binary = join(stdout.trim(), "ChiefOfStaff");

  log(`assembling ${APP_PATH}`);
  const contents = join(APP_PATH, "Contents");
  await rm(APP_PATH, { recursive: true, force: true });
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"), { recursive: true });
  await cp(binary, join(contents, "MacOS", "ChiefOfStaff"));
  await chmod(join(contents, "MacOS", "ChiefOfStaff"), 0o755);
  await cp(join(pkg, "Info.plist"), join(contents, "Info.plist"));
  await writeFile(join(contents, "PkgInfo"), "APPL????");
  // Ad-hoc signature so Accessibility / Microphone grants stick to this bundle.
  await exec("codesign", ["--force", "--deep", "--sign", "-", APP_PATH]);

  await mkdir(join(homedir(), ".cos"), { recursive: true });
  await writeFile(SHELL_CONFIG, JSON.stringify({ node: o.node, repo: o.repoRoot, port: o.port }, null, 2) + "\n");
  log(`wrote ${SHELL_CONFIG}`);
  return APP_PATH;
}

export async function openMenubar(): Promise<void> {
  if (!(await exists(APP_PATH))) throw new Error(`Not built yet: cos menubar build   (expected ${APP_PATH})`);
  await exec("open", ["-a", APP_PATH]);
}

export async function quitMenubar(): Promise<void> {
  try {
    await exec("osascript", ["-e", `tell application id "com.chief-of-staff.menubar" to quit`]);
  } catch {
    /* not running */
  }
}

/** Open the app at login through a LaunchAgent (no Automation permission needed). */
export async function installLoginItem(): Promise<string> {
  await mkdir(AGENTS_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  const file = join(AGENTS_DIR, `${LOGIN_LABEL}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LOGIN_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>${APP_PATH}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(LOG_DIR, "menubar-login.log")}</string>
  <key>StandardErrorPath</key><string>${join(LOG_DIR, "menubar-login.log")}</string>
</dict>
</plist>
`;
  const domain = `gui/${process.getuid?.() ?? 501}`;
  try {
    await exec("launchctl", ["bootout", domain, file]);
  } catch {
    /* not loaded */
  }
  await writeFile(file, plist);
  await exec("launchctl", ["bootstrap", domain, file]);
  return file;
}

export async function uninstallMenubar(): Promise<string[]> {
  const removed: string[] = [];
  await quitMenubar();
  const file = join(AGENTS_DIR, `${LOGIN_LABEL}.plist`);
  if (await exists(file)) {
    try {
      await exec("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, file]);
    } catch {
      /* ignore */
    }
    await rm(file);
    removed.push(file);
  }
  if (await exists(APP_PATH)) {
    await rm(APP_PATH, { recursive: true, force: true });
    removed.push(APP_PATH);
  }
  return removed;
}
