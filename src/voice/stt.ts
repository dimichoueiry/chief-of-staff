/**
 * Speech to text. Records a short clip and transcribes it locally with
 * whisper.cpp when both a recorder (sox `rec` or ffmpeg) and `whisper-cli`
 * with a model are present. Otherwise `cos talk` falls back to typing.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function has(bin: string): Promise<boolean> {
  try {
    await exec("which", [bin]);
    return true;
  } catch {
    return false;
  }
}

export interface SttProvider {
  name: string;
  available(): Promise<boolean>;
  /** Record for up to `seconds` (stopping early on silence when the recorder supports it) and return the transcript. */
  listen(seconds: number): Promise<string>;
}

async function record(file: string, seconds: number): Promise<void> {
  if (await has("rec")) {
    // sox: 16 kHz mono wav, stop after 1.5 s of silence or at the cap
    await exec("rec", ["-q", "-r", "16000", "-c", "1", file, "trim", "0", String(seconds), "silence", "1", "0.1", "1%", "1", "1.5", "1%"]);
    return;
  }
  if (await has("ffmpeg")) {
    await exec("ffmpeg", ["-y", "-loglevel", "error", "-f", "avfoundation", "-i", ":0", "-t", String(seconds), "-ar", "16000", "-ac", "1", file]);
    return;
  }
  throw new Error("No recorder found. Install sox (brew install sox) or ffmpeg.");
}

export const whisperCpp: SttProvider = {
  name: "whisper.cpp",
  async available() {
    const model = process.env.COS_WHISPER_MODEL;
    return Boolean(model) && (await has("whisper-cli")) && ((await has("rec")) || (await has("ffmpeg")));
  },
  async listen(seconds) {
    const dir = await mkdtemp(join(tmpdir(), "cos-stt-"));
    const wav = join(dir, "clip.wav");
    try {
      await record(wav, seconds);
      await exec("whisper-cli", ["-m", process.env.COS_WHISPER_MODEL!, "-f", wav, "-nt", "-otxt", "-of", join(dir, "clip")]);
      return (await readFile(join(dir, "clip.txt"), "utf8")).trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

export async function pickStt(order: SttProvider[] = [whisperCpp]): Promise<SttProvider | null> {
  for (const p of order) if (await p.available()) return p;
  return null;
}
