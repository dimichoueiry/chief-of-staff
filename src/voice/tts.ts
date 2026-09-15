/**
 * Text to speech.
 *
 * - openai: gpt-4o-mini-tts, a natural voice you can steer with plain-English
 *   instructions. Used automatically when OPENAI_API_KEY is set.
 * - say: the built-in macOS voice. The fallback, and what runs without a key.
 *
 * Long answers are split into sentence-sized pieces that are synthesised a few
 * at a time and played in order, so speech starts after the first piece instead
 * of after the whole answer. stopSpeaking() silences playback and cancels
 * pending synthesis immediately.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import OpenAI from "openai";
import { cosHome } from "../util/home.js";

// ---------- settings ----------

export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"] as const;
export type TtsProvider = "auto" | "openai" | "say";

export interface VoiceSettings {
  provider: TtsProvider;
  /** OpenAI voice name, or a custom voice id like voice_123abc. */
  voice: string;
  model: string;
  /** How it should sound: tone, pace, emotion. */
  instructions: string;
  /** 0.25 to 4.0; 1 is normal. */
  speed: number;
  /** macOS voice for the fallback, e.g. "Samantha". Empty uses the system voice. */
  sayVoice: string;
}

export const DEFAULT_VOICE: VoiceSettings = {
  provider: "auto",
  voice: "marin",
  model: "gpt-4o-mini-tts",
  instructions:
    "You are a calm, warm chief of staff giving a short spoken briefing to someone you work with every day. " +
    "Natural conversational pace, clear and friendly, confident but never theatrical. Pause briefly between items.",
  speed: 1,
  sayVoice: "",
};

export function voiceSettingsFile(): string {
  return join(cosHome(), "voice.json");
}

/** Defaults, then COS_TTS_* environment variables, then what `cos voice` saved. */
export function readVoiceSettings(env: NodeJS.ProcessEnv = process.env, file: string = voiceSettingsFile()): VoiceSettings {
  let saved: Partial<VoiceSettings> = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8")) as Partial<VoiceSettings>;
  } catch {
    /* nothing saved */
  }
  const fromEnv: Partial<VoiceSettings> = {};
  if (env.COS_TTS) fromEnv.provider = env.COS_TTS as TtsProvider;
  if (env.COS_TTS_VOICE) fromEnv.voice = env.COS_TTS_VOICE;
  if (env.COS_TTS_MODEL) fromEnv.model = env.COS_TTS_MODEL;
  if (env.COS_TTS_INSTRUCTIONS) fromEnv.instructions = env.COS_TTS_INSTRUCTIONS;
  if (env.COS_TTS_SPEED && Number(env.COS_TTS_SPEED)) fromEnv.speed = Number(env.COS_TTS_SPEED);
  if (env.COS_VOICE) fromEnv.sayVoice = env.COS_VOICE;
  const merged = { ...DEFAULT_VOICE, ...fromEnv, ...saved };
  if (!["auto", "openai", "say"].includes(merged.provider)) merged.provider = "auto";
  merged.speed = Math.min(4, Math.max(0.25, Number(merged.speed) || 1));
  return merged;
}

export function saveVoiceSettings(patch: Partial<VoiceSettings> | null, file: string = voiceSettingsFile()): VoiceSettings {
  let saved: Partial<VoiceSettings> = {};
  if (patch !== null) {
    try {
      saved = JSON.parse(readFileSync(file, "utf8")) as Partial<VoiceSettings>;
    } catch {
      /* start fresh */
    }
    saved = { ...saved, ...patch };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(saved, null, 2) + "\n", "utf8");
  return readVoiceSettings(process.env, file);
}

export function isKnownVoice(voice: string): boolean {
  return (OPENAI_VOICES as readonly string[]).includes(voice) || /^voice_[A-Za-z0-9]+$/.test(voice);
}

/** Which engine will actually speak. */
export function activeTts(s: VoiceSettings = readVoiceSettings(), env: NodeJS.ProcessEnv = process.env): "openai" | "say" {
  if (process.platform !== "darwin" && s.provider !== "openai") return "openai";
  if (s.provider === "say") return "say";
  if (s.provider === "openai") return "openai";
  return env.OPENAI_API_KEY ? "openai" : "say";
}

// ---------- chunking ----------

/** Sentence-sized pieces of at most `max` characters, never splitting a word. */
export function chunkText(text: string, max = 400): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+(?:[.!?]+["')\]]?|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean];
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > max) {
      push();
      let rest = sentence;
      while (rest.length > max) {
        const cut = rest.lastIndexOf(" ", max);
        const at = cut > max / 2 ? cut : max;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      current = rest;
      continue;
    }
    // Keep the first piece short so speech starts quickly.
    const limit = chunks.length === 0 ? Math.min(max, 160) : max;
    if (current && current.length + 1 + sentence.length > limit) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return chunks;
}

// ---------- engines ----------

export interface SpeechEngine {
  /** mp3 bytes for one piece of text. */
  synthesize(text: string, s: VoiceSettings, signal: AbortSignal): Promise<Buffer>;
  /** Play an audio file; resolves when playback ends. */
  play(file: string, track: (child: ChildProcess) => void): Promise<void>;
  /** Speak with the built-in macOS voice. */
  say(text: string, s: VoiceSettings, track: (child: ChildProcess) => void): Promise<void>;
}

function run(cmd: string, args: string[], track: (child: ChildProcess) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    track(child);
    child.on("error", reject);
    // Killed by stopSpeaking() is a normal end.
    child.on("exit", (code, signal) => (code === 0 || signal ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

export const systemEngine: SpeechEngine = {
  async synthesize(text, s, signal) {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.audio.speech.create(
      { model: s.model, voice: s.voice, input: text, instructions: s.instructions, speed: s.speed, response_format: "mp3" },
      { signal },
    );
    return Buffer.from(await res.arrayBuffer());
  },
  play: (file, track) => run("afplay", [file], track),
  say: (text, s, track) => run("say", [...(s.sayVoice ? ["-v", s.sayVoice] : []), ...(process.env.COS_SPEECH_RATE ? ["-r", process.env.COS_SPEECH_RATE] : []), text], track),
};

// ---------- playback ----------

class Playback {
  readonly controller = new AbortController();
  child: ChildProcess | null = null;
  stopped = false;

  track = (child: ChildProcess) => {
    this.child = child;
    if (this.stopped) child.kill();
  };

  stop() {
    this.stopped = true;
    this.controller.abort();
    this.child?.kill();
  }
}

let current: Playback | null = null;

/** Stop whatever is being spoken. Returns true if something was playing. */
export function stopSpeaking(): boolean {
  if (!current) return false;
  current.stop();
  current = null;
  return true;
}

export function isSpeaking(): boolean {
  return current !== null;
}

export interface SpeakOptions {
  settings?: VoiceSettings;
  engine?: SpeechEngine;
  /** How many pieces to synthesise ahead of the one playing. */
  lookahead?: number;
  onFallback?: (reason: string) => void;
}

export interface SpeakResult {
  engine: "openai" | "say";
  pieces: number;
  fellBack?: string;
  stopped: boolean;
}

export async function speak(text: string, o: SpeakOptions = {}): Promise<SpeakResult> {
  const s = o.settings ?? readVoiceSettings();
  const engine = o.engine ?? systemEngine;
  stopSpeaking();
  const pb = new Playback();
  current = pb;
  const finish = (r: SpeakResult): SpeakResult => {
    if (current === pb) current = null;
    return { ...r, stopped: pb.stopped };
  };

  if (activeTts(s) === "say") {
    await engine.say(text, s, pb.track);
    return finish({ engine: "say", pieces: 1, stopped: false });
  }

  const pieces = chunkText(text);
  const dir = await mkdtemp(join(tmpdir(), "cos-tts-"));
  const lookahead = o.lookahead ?? 2;
  const pending: Promise<string>[] = [];
  const start = (i: number) => {
    pending[i] ??= engine.synthesize(pieces[i], s, pb.controller.signal).then(async (audio) => {
      const file = join(dir, `${String(i).padStart(3, "0")}.mp3`);
      await writeFile(file, audio);
      return file;
    });
    // Don't leave an unhandled rejection if playback stops before this piece is awaited.
    pending[i].catch(() => {});
    return pending[i];
  };

  try {
    for (let i = 0; i < pieces.length; i++) {
      if (pb.stopped) break;
      for (let j = i; j < Math.min(pieces.length, i + 1 + lookahead); j++) start(j);
      let file: string;
      try {
        file = await pending[i];
      } catch (err) {
        if (pb.stopped) break;
        // Keep talking: finish with the built-in voice rather than going silent.
        const reason = (err as Error).message.split("\n")[0];
        o.onFallback?.(reason);
        await engine.say(pieces.slice(i).join(" "), s, pb.track);
        return finish({ engine: i === 0 ? "say" : "openai", pieces: pieces.length, fellBack: reason, stopped: false });
      }
      if (pb.stopped) break;
      await engine.play(file, pb.track);
    }
    return finish({ engine: "openai", pieces: pieces.length, stopped: false });
  } finally {
    pb.controller.abort();
    await rm(dir, { recursive: true, force: true });
  }
}
