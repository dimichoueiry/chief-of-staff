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
 *
 * In a voice conversation the voice can be wrapped in cues (see cues.ts): a quiet
 * one as it starts and a chime after the last word, before the mic opens. Cues play
 * through the same playback, so they never overlap the voice and stop with it.
 *
 * An acknowledgement (ack.ts, speak with ack: true) gives way to the reply that follows:
 * if it isn't audible yet it is dropped, and if it is the reply waits for it to end
 * (at most ACK_WAIT_MS), so the two never overlap and no word is cut in half.
 * stopSpeaking() silences both.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import OpenAI from "openai";
import { cosHome } from "../util/home.js";
import { cueFile, type CueName } from "./cues.js";
import { readyPlayer } from "./player.js";

// ---------- settings ----------

export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"] as const;
export type TtsProvider = "auto" | "openai" | "say";
/** both: a quiet cue as a reply starts and a chime when it's your turn; turn: only the chime; off: none. */
export type CueMode = "both" | "turn" | "off";
export const CUE_MODES: readonly CueMode[] = ["both", "turn", "off"];

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
  /** Seconds of quiet that end what you're saying in the menubar app (1 to 10). */
  listenPause: number;
  /** Chimes around the voice in a conversation. */
  cues: CueMode;
  /** The menubar app waits for its name: "<wakeName> wake up" listens, "… listen" interrupts, "… sleep" closes. */
  wake: boolean;
  wakeName: string;
  /** Say a few words ("Looking into it.") the moment a spoken request arrives. */
  ack: boolean;
}

export const LISTEN_PAUSE = { min: 1, max: 10 } as const;

export const DEFAULT_VOICE: VoiceSettings = {
  provider: "auto",
  voice: "marin",
  model: "gpt-4o-mini-tts",
  instructions:
    "You are a calm, warm chief of staff giving a short spoken briefing to someone you work with every day. " +
    "Natural conversational pace, clear and friendly, confident but never theatrical. Pause briefly between items.",
  speed: 1,
  sayVoice: "",
  listenPause: 2.5,
  cues: "both",
  wake: true,
  wakeName: "Darius",
  ack: true,
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
  if (!CUE_MODES.includes(merged.cues)) merged.cues = DEFAULT_VOICE.cues;
  if (typeof merged.wake !== "boolean") merged.wake = DEFAULT_VOICE.wake;
  if (typeof merged.ack !== "boolean") merged.ack = DEFAULT_VOICE.ack;
  merged.wakeName = typeof merged.wakeName === "string" && isWakeName(merged.wakeName) ? merged.wakeName.trim() : DEFAULT_VOICE.wakeName;
  merged.speed = Math.min(4, Math.max(0.25, Number(merged.speed) || 1));
  merged.listenPause = Math.min(LISTEN_PAUSE.max, Math.max(LISTEN_PAUSE.min, Number(merged.listenPause) || DEFAULT_VOICE.listenPause));
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

/** A name to wake it with: one word of 3 to 20 letters, so it can be heard and matched. */
export function isWakeName(name: string): boolean {
  return /^\p{L}[\p{L}'-]{2,19}$/u.test(name.trim());
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
  // The native player ends with the sound; afplay lingers about a second after it, so it's only the fallback.
  async play(file, track) {
    const player = readyPlayer();
    if (!player) return run("afplay", [file], track);
    try {
      await run(player, [file], track);
    } catch {
      await run("afplay", [file], track);
    }
  },
  say: (text, s, track) => run("say", [...(s.sayVoice ? ["-v", s.sayVoice] : []), ...(process.env.COS_SPEECH_RATE ? ["-r", process.env.COS_SPEECH_RATE] : []), text], track),
};

// ---------- playback ----------

/** How long a reply waits for an acknowledgement that is already being heard. Acks are a second or less. */
export const ACK_WAIT_MS = 2_500;

class Playback {
  readonly controller = new AbortController();
  child: ChildProcess | null = null;
  stopped = false;
  /** Something is coming out of the speakers (or did): a player or `say` has started. */
  audible = false;
  private ended!: () => void;
  /** Settles when this playback is over, however it ended. */
  readonly done = new Promise<void>((resolve) => (this.ended = resolve));

  constructor(readonly ack = false) {}

  track = (child: ChildProcess) => {
    this.child = child;
    this.audible = true;
    if (this.stopped) child.kill();
  };

  stop() {
    this.stopped = true;
    this.controller.abort();
    this.child?.kill();
    this.ended();
  }

  end() {
    this.ended();
  }
}

let current: Playback | null = null;
/** An acknowledgement being heard out while the reply after it waits. */
let yielding: Playback | null = null;

/** Stop whatever is being spoken, and an acknowledgement a reply is waiting on. Returns true if something was playing. */
export function stopSpeaking(): boolean {
  const any = current !== null || yielding !== null;
  current?.stop();
  yielding?.stop();
  current = null;
  yielding = null;
  return any;
}

export function isSpeaking(): boolean {
  return current !== null || yielding !== null;
}

export interface SpeakOptions {
  settings?: VoiceSettings;
  engine?: SpeechEngine;
  /** How many pieces to synthesise ahead of the one playing. */
  lookahead?: number;
  onFallback?: (reason: string) => void;
  /** Which cues this speech wants, if the voice settings allow them: start as it begins, turn after the last word. */
  cues?: Partial<Record<CueName, boolean>>;
  /** Where a cue's sound is. */
  cueFile?: (name: CueName) => Promise<string>;
  /** An acknowledgement: the next speech drops it if it isn't audible yet, or waits for it to end. */
  ack?: boolean;
  /** Keep synthesised pieces here, by text and voice, and reuse them (for phrases said often, like acks). */
  cacheDir?: string;
}

export interface SpeakResult {
  engine: "openai" | "say";
  pieces: number;
  fellBack?: string;
  stopped: boolean;
  /** The cues that played to the end. */
  cued: CueName[];
}

/** The cached audio for this text in this voice. Every setting that changes the sound is in the name. */
export function cacheFile(dir: string, text: string, s: VoiceSettings): string {
  const key = createHash("sha1").update(JSON.stringify([text, s.voice, s.model, s.instructions, s.speed])).digest("hex").slice(0, 16);
  return join(dir, `speech-${key}.mp3`);
}

async function cached(dir: string, text: string, s: VoiceSettings): Promise<string | null> {
  const file = cacheFile(dir, text, s);
  try {
    await access(file);
    return file;
  } catch {
    return null;
  }
}

async function keep(dir: string, text: string, s: VoiceSettings, audio: Buffer): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = cacheFile(dir, text, s);
  const partial = `${file}.${process.pid}.tmp`;
  await writeFile(partial, audio);
  await rename(partial, file);
}

/**
 * Synthesise these into the cache ahead of time, so the first time one is said it starts at once.
 * Only for the OpenAI voice; the Mac voice has nothing to wait for. Returns how many were made.
 */
export async function preload(texts: string[], dir: string, o: { settings?: VoiceSettings; engine?: SpeechEngine } = {}): Promise<number> {
  const s = o.settings ?? readVoiceSettings();
  if (activeTts(s) !== "openai") return 0;
  const engine = o.engine ?? systemEngine;
  let made = 0;
  for (const text of texts) {
    if (await cached(dir, text, s)) continue;
    await keep(dir, text, s, await engine.synthesize(text, s, AbortSignal.timeout(15_000)));
    made++;
  }
  return made;
}

export async function speak(text: string, o: SpeakOptions = {}): Promise<SpeakResult> {
  const s = o.settings ?? readVoiceSettings();
  const engine = o.engine ?? systemEngine;
  // An acknowledgement never talks over other speech: a reply, or an agent's news, carries on.
  if (o.ack && ((current && !current.ack) || yielding)) return { engine: activeTts(s), pieces: 0, stopped: true, cued: [] };
  // An acknowledgement already being heard is let finish; anything else, or one still being made, stops here.
  const before = current;
  current = null;
  if (before?.ack && before.audible && !before.stopped && !o.ack) {
    yielding?.stop();
    yielding = before;
  } else {
    before?.stop();
  }
  const pb = new Playback(o.ack === true);
  current = pb;
  const cued: CueName[] = [];
  const finish = (r: Omit<SpeakResult, "cued">): SpeakResult => {
    if (current === pb) current = null;
    pb.end();
    return { ...r, stopped: pb.stopped, cued };
  };
  const waitFor = yielding;
  if (waitFor && waitFor !== pb) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([waitFor.done, pb.done, new Promise<void>((r) => (timer = setTimeout(r, ACK_WAIT_MS)))]);
    clearTimeout(timer);
    if (pb.stopped) return finish({ engine: activeTts(s), pieces: 0, stopped: true });
    waitFor.stop();
    if (yielding === waitFor) yielding = null;
  }
  try {
    return await speakNow(text, s, engine, pb, o, cued, finish);
  } finally {
    // However it ended, even by throwing, nothing waits on it any longer.
    if (current === pb) current = null;
    pb.end();
  }
}

async function speakNow(
  text: string, s: VoiceSettings, engine: SpeechEngine, pb: Playback, o: SpeakOptions, cued: CueName[],
  finish: (r: Omit<SpeakResult, "cued">) => SpeakResult,
): Promise<SpeakResult> {
  /** Play a cue to its end. A missing or broken cue never costs the voice. */
  const cue = async (name: CueName) => {
    if (!o.cues?.[name] || s.cues === "off" || (s.cues === "turn" && name !== "turn") || pb.stopped) return;
    try {
      await engine.play(await (o.cueFile ?? cueFile)(name), pb.track);
      if (!pb.stopped) cued.push(name);
    } catch {
      /* speak without it */
    }
  };

  if (activeTts(s) === "say") {
    await cue("start");
    if (!pb.stopped) await engine.say(text, s, pb.track);
    await cue("turn");
    return finish({ engine: "say", pieces: 1, stopped: false });
  }

  const pieces = chunkText(text);
  // The start cue plays while the first piece is synthesised, so it adds no wait; the voice waits for it to end.
  const starting = pieces.length ? cue("start") : Promise.resolve();
  const dir = await mkdtemp(join(tmpdir(), "cos-tts-"));
  const lookahead = o.lookahead ?? 2;
  const pending: Promise<string>[] = [];
  const start = (i: number) => {
    pending[i] ??= (o.cacheDir ? cached(o.cacheDir, pieces[i], s) : Promise.resolve(null)).then(async (hit) => {
      if (hit) return hit;
      const audio = await engine.synthesize(pieces[i], s, pb.controller.signal);
      const file = join(dir, `${String(i).padStart(3, "0")}.mp3`);
      await writeFile(file, audio);
      if (o.cacheDir) await keep(o.cacheDir, pieces[i], s, audio).catch(() => {});
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
        await starting;
        if (!pb.stopped) await engine.say(pieces.slice(i).join(" "), s, pb.track);
        await cue("turn");
        return finish({ engine: i === 0 ? "say" : "openai", pieces: pieces.length, fellBack: reason, stopped: false });
      }
      if (i === 0) await starting;
      if (pb.stopped) break;
      await engine.play(file, pb.track);
    }
    await cue("turn");
    return finish({ engine: "openai", pieces: pieces.length, stopped: false });
  } finally {
    pb.controller.abort();
    await rm(dir, { recursive: true, force: true });
  }
}
