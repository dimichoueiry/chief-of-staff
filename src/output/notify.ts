/** macOS notification and the last-brief cache the UI and scheduler share. */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Brief } from "../brain/schema.js";
import { cosHome } from "../util/home.js";

const exec = promisify(execFile);

export function lastBriefFile(): string {
  return join(cosHome(), "last-brief.json");
}

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
  await mkdir(cosHome(), { recursive: true });
  await writeFile(lastBriefFile(), JSON.stringify({ savedAt: new Date().toISOString(), source, brief }, null, 2), "utf8");
}

export async function loadLastBrief(): Promise<{ savedAt: string; source: string; brief: Brief } | null> {
  try {
    return JSON.parse(await readFile(lastBriefFile(), "utf8"));
  } catch {
    return null;
  }
}
