/**
 * Looking at the screen. A small Swift helper (compiled on first use, like the
 * calendar one) takes one still of the display under the pointer with
 * ScreenCaptureKit, leaving out Chief of Staff's own windows, shrunk to about
 * 1600px. The image is read into memory and the file deleted at once: nothing is kept.
 *
 * macOS permission: Screen & System Audio Recording, for Chief of Staff.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { STALE_SWITCH } from "../actions/permissions.js";
import { cosHome } from "../util/home.js";
import { swiftFlags } from "../util/swift.js";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const HELPER_SRC = join(here, "screen", "cos-screen.swift");

export interface Screenshot {
  /** Base64 JPEG. */
  data: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
  /** The app they're in and its front window's title, when known. */
  app: string;
  window: string;
}

export interface ScreenCapturer {
  capture(): Promise<Screenshot>;
  permission(): Promise<boolean>;
  /** Show macOS's permission prompt (it also adds the app to the Screen Recording list). */
  request(): Promise<boolean>;
}

export class ScreenPermissionError extends Error {
  constructor() {
    super(SCREEN_PERMISSION_HELP);
    this.name = "ScreenPermissionError";
  }
}

export const SCREEN_PERMISSION_HELP = `I can't see your screen yet. Turn on Chief of Staff in System Settings › Privacy & Security › Screen & System Audio Recording (say "open Screen Recording settings" to go there), then ask me again. ${STALE_SWITCH}`;

/** What someone says when they want it to look: "look at this", "what am I looking at?", "can you see my screen?", "what does this say?". */
export const LOOK_REQUEST =
  /\b(?:look(?:ing)? at (?:this|that|my screen|the screen|what i'?m (?:looking at|seeing)|it)|take a look|have a look|what (?:am i|are we) looking at|what(?:'s| is) (?:on )?(?:my|the) screen|(?:can|do) you see (?:this|that|my screen|the screen|what i see)|see my screen|check (?:out )?(?:this|my screen)|what does (?:this|that|it) say|read (?:this|that|what'?s on (?:my|the) screen)|what(?:'s| is) (?:this|that)(?: (?:error|thing|page|window|message|button|popup|screen))?\b(?! (?:project|reminder|note|meeting|event|week|month|year|about))|screenshot)\b/i;

export function helperBin(): string {
  return join(cosHome(), "bin", "cos-screen");
}

/** Compile the Swift helper if it is missing or older than its source. */
export async function ensureScreenHelper(bin = helperBin()): Promise<string> {
  const [src, built] = await Promise.all([stat(HELPER_SRC), stat(bin).catch(() => null)]);
  if (built && built.mtimeMs >= src.mtimeMs) return bin;
  await mkdir(dirname(bin), { recursive: true });
  await exec("swiftc", [...swiftFlags(), "-o", bin, HELPER_SRC], { timeout: 180_000 });
  return bin;
}

async function run(args: string[]): Promise<Record<string, unknown>> {
  const bin = await ensureScreenHelper();
  try {
    const { stdout } = await exec(bin, args, { timeout: 20_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
  } catch (err) {
    const out = (err as { stdout?: string }).stdout ?? "";
    try {
      return JSON.parse(out.trim().split("\n").at(-1) ?? "");
    } catch {
      throw new Error(`screen helper failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

export const helperCapturer: ScreenCapturer = {
  async permission() {
    return (await run(["check"])).permission === true;
  },
  async request() {
    return (await run(["request"])).permission === true;
  },
  async capture() {
    const dir = join(cosHome(), "screens");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `look-${Date.now()}-${process.pid}.jpg`);
    try {
      const r = await run(["capture", file, "1600"]);
      if (r.error === "permission") throw new ScreenPermissionError();
      if (r.error) throw new Error(String(r.message ?? r.error));
      const data = (await readFile(file)).toString("base64");
      return { data, mediaType: "image/jpeg", width: Number(r.width), height: Number(r.height), app: String(r.app ?? ""), window: String(r.window ?? "") };
    } finally {
      await rm(file, { force: true });
    }
  },
};

/** One line saying what was captured, for the model and the conversation record. */
export function describeShot(s: Pick<Screenshot, "app" | "window" | "width" | "height">): string {
  const where = s.app ? `${s.app}${s.window ? ` (“${s.window}”)` : ""}` : "their screen";
  return `A screenshot of their screen, taken just now (${s.width}×${s.height}); in front: ${where}. Chief of Staff's own windows are left out.`;
}
