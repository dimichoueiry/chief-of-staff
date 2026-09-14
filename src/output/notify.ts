/** macOS notification and the last-brief cache the UI and scheduler share. */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Brief } from "../brain/schema.js";

const exec = promisify(execFile);

export const COS_HOME = join(homedir(), ".cos");
export const LAST_BRIEF = join(COS_HOME, "last-brief.json");

export async function notify(title: string, body: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    await exec("osascript", ["-e", `display notification "${q(body)}" with title "${q(title)}"`]);
    return true;
  } catch {
    return false;
  }
}

export async function saveBrief(brief: Brief, source: string): Promise<void> {
  await mkdir(COS_HOME, { recursive: true });
  await writeFile(LAST_BRIEF, JSON.stringify({ savedAt: new Date().toISOString(), source, brief }, null, 2), "utf8");
}

export async function loadLastBrief(): Promise<{ savedAt: string; source: string; brief: Brief } | null> {
  try {
    return JSON.parse(await readFile(LAST_BRIEF, "utf8"));
  } catch {
    return null;
  }
}
