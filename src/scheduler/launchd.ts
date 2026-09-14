/**
 * The thing that makes it speak first. Three launchd agents in
 * ~/Library/LaunchAgents run the CLI on a clock; launchd also fires a missed
 * job when the machine wakes, which is what "brief on wake" needs.
 */
import { execFile } from "node:child_process";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const LABEL_PREFIX = "com.chief-of-staff";
export const AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
export const LOG_DIR = join(homedir(), ".cos", "logs");

export interface Job {
  name: string;
  /** HH:MM local time */
  at: string;
  args: string[];
  description: string;
}

export interface Schedule {
  morning: string;
  evening: string;
  silence: string;
}

export const DEFAULT_SCHEDULE: Schedule = { morning: "07:00", evening: "18:00", silence: "12:00" };

export function jobs(s: Schedule = DEFAULT_SCHEDULE): Job[] {
  return [
    { name: "morning", at: s.morning, args: ["brief", "--notify"], description: "the morning brief (notification + cached for the UI)" },
    { name: "silence", at: s.silence, args: ["silence-check", "--notify"], description: "projects gone quiet: keep / park / kill" },
    { name: "evening", at: s.evening, args: ["nudge", "wrap"], description: "reminder to write the two-line journal" },
  ];
}

export function parseTime(hhmm: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`time must be HH:MM, got "${hhmm}"`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`time out of range: "${hhmm}"`);
  return { hour, minute };
}

export interface PlistOptions {
  node: string;
  entry: string;
  cwd: string;
  path?: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function label(job: Job): string {
  return `${LABEL_PREFIX}.${job.name}`;
}

export function plistFor(job: Job, o: PlistOptions): string {
  const { hour, minute } = parseTime(job.at);
  const args = [o.node, o.entry, ...job.args].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const path = o.path ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(job)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${xml(o.cwd)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>HOME</key><string>${xml(homedir())}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(join(LOG_DIR, `${job.name}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(LOG_DIR, `${job.name}.log`))}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;
}

export function plistPath(job: Job): string {
  return join(AGENTS_DIR, `${label(job)}.plist`);
}

async function launchctl(args: string[]): Promise<string> {
  const { stdout } = await exec("launchctl", args);
  return stdout;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function bootout(plist: string): Promise<void> {
  try {
    await launchctl(["bootout", domain(), plist]);
  } catch {
    /* not loaded */
  }
}

export async function install(o: PlistOptions, schedule: Schedule = DEFAULT_SCHEDULE): Promise<Job[]> {
  await mkdir(AGENTS_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  const installed: Job[] = [];
  for (const job of jobs(schedule)) {
    const file = plistPath(job);
    await bootout(file);
    await writeFile(file, plistFor(job, o), "utf8");
    await launchctl(["bootstrap", domain(), file]);
    installed.push(job);
  }
  return installed;
}

export async function uninstall(): Promise<string[]> {
  const removed: string[] = [];
  for (const job of jobs()) {
    const file = plistPath(job);
    try {
      await access(file);
    } catch {
      continue;
    }
    await bootout(file);
    await rm(file);
    removed.push(label(job));
  }
  return removed;
}

export async function status(): Promise<Array<{ label: string; installed: boolean; loaded: boolean; at: string }>> {
  let loaded = "";
  try {
    loaded = await launchctl(["list"]);
  } catch {
    /* ignore */
  }
  let files: string[] = [];
  try {
    files = await readdir(AGENTS_DIR);
  } catch {
    /* ignore */
  }
  return jobs().map((job) => ({
    label: label(job),
    installed: files.includes(`${label(job)}.plist`),
    loaded: loaded.includes(label(job)),
    at: job.at,
  }));
}
