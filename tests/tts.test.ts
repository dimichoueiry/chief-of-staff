import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE, activeTts, chunkText, isKnownVoice, readVoiceSettings, saveVoiceSettings, speak, stopSpeaking,
  type SpeechEngine, type VoiceSettings,
} from "../src/voice/tts.js";

describe("chunkText", () => {
  it("keeps the first piece short and never splits words", () => {
    const text = "Good morning. " + "This is a longer sentence about the day ahead that goes on for a while. ".repeat(8);
    const chunks = chunkText(text); // default 400-character pieces
    expect(chunks[0].startsWith("Good morning. ")).toBe(true);
    expect(chunks[0].length).toBeLessThanOrEqual(160); // short first piece so audio starts fast
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.slice(1).some((c) => c.length > 160)).toBe(true); // later pieces use the full size
    expect(chunks.every((c) => c.length <= 400 && /[.!?]$/.test(c))).toBe(true); // whole sentences
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("breaks an overlong sentence at spaces", () => {
    const chunks = chunkText("word ".repeat(300).trim(), 100);
    expect(chunks.every((c) => c.length <= 100 && !c.startsWith(" ") && !c.endsWith(" "))).toBe(true);
    expect(chunks.join(" ").split(" ")).toHaveLength(300);
    expect(chunkText("   ")).toEqual([]);
  });
});

describe("voice settings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-voice-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("uses OpenAI only when a key exists unless forced, and saved choices beat env", async () => {
    const file = join(dir, "voice.json");
    const s = readVoiceSettings({}, file);
    expect(s).toEqual(DEFAULT_VOICE);
    expect(activeTts(s, {})).toBe("say");
    expect(activeTts(s, { OPENAI_API_KEY: "sk" })).toBe("openai");
    expect(activeTts({ ...s, provider: "say" }, { OPENAI_API_KEY: "sk" })).toBe("say");

    expect(readVoiceSettings({ COS_TTS_VOICE: "ash", COS_TTS_SPEED: "9" }, file)).toMatchObject({ voice: "ash", speed: 4 });
    saveVoiceSettings({ voice: "cedar" }, file);
    expect(readVoiceSettings({ COS_TTS_VOICE: "ash" }, file).voice).toBe("cedar");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ voice: "cedar" });
    saveVoiceSettings(null, file);
    expect(readVoiceSettings({}, file).voice).toBe("marin");

    expect(isKnownVoice("marin")).toBe(true);
    expect(isKnownVoice("voice_123abc")).toBe(true);
    expect(isKnownVoice("robot")).toBe(false);
  });
});

/** A fake engine: records what was synthesised, played and said; playback ends when told to or when killed. */
function fakeEngine(opts: { failAt?: number; holdPlayback?: boolean } = {}) {
  const log: string[] = [];
  let release: (() => void) | null = null;
  const fakeChild = (onKill: () => void) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { kill: () => boolean }).kill = () => {
      onKill();
      return true;
    };
    return child;
  };
  const engine: SpeechEngine = {
    async synthesize(text, _s, signal) {
      log.push(`synth:${text.slice(0, 12)}`);
      if (opts.failAt !== undefined && log.filter((l) => l.startsWith("synth")).length - 1 === opts.failAt) {
        throw new Error("401 invalid key");
      }
      if (signal.aborted) throw new Error("aborted");
      return Buffer.from(text);
    },
    play: (file, track) =>
      new Promise((resolve) => {
        log.push(`play:${file.split("/").pop()}`);
        track(fakeChild(() => resolve()));
        if (opts.holdPlayback) release = resolve;
        else resolve();
      }),
    say: async (text, _s, track) => {
      track(fakeChild(() => {}));
      log.push(`say:${text.slice(0, 12)}`);
    },
  };
  return { engine, log, release: () => release?.() };
}

const openai: VoiceSettings = { ...DEFAULT_VOICE, provider: "openai" };
const threeSentences = "First thing today. Second thing to do after lunch, which is a longer sentence than the first one and needs its own piece for sure because it keeps going. Third thing.";

describe("speak", () => {
  it("plays pieces in order with the OpenAI engine", async () => {
    const { engine, log } = fakeEngine();
    const r = await speak(threeSentences, { settings: openai, engine, lookahead: 1 });
    expect(r).toMatchObject({ engine: "openai", stopped: false });
    const plays = log.filter((l) => l.startsWith("play"));
    expect(plays).toEqual(plays.slice().sort());
    expect(plays.length).toBe(r.pieces);
    expect(log[0]).toBe("synth:First thing ");
  });

  it("uses the Mac voice when told to", async () => {
    const { engine, log } = fakeEngine();
    const r = await speak("Hello there.", { settings: { ...DEFAULT_VOICE, provider: "say" }, engine });
    expect(r.engine).toBe("say");
    expect(log).toEqual(["say:Hello there."]);
  });

  it("finishes with the Mac voice if OpenAI fails partway", async () => {
    const { engine, log } = fakeEngine({ failAt: 1 });
    const reasons: string[] = [];
    const r = await speak(threeSentences, { settings: openai, engine, lookahead: 0, onFallback: (why) => reasons.push(why) });
    expect(reasons).toEqual(["401 invalid key"]);
    expect(r.fellBack).toBe("401 invalid key");
    expect(log.filter((l) => l.startsWith("play"))).toHaveLength(1);
    expect(log.at(-1)).toBe(`say:${chunkText(threeSentences).slice(1).join(" ").slice(0, 12)}`);
  });

  it("stops immediately and plays nothing more", async () => {
    const { engine, log } = fakeEngine({ holdPlayback: true });
    const talking = speak(threeSentences, { settings: openai, engine, lookahead: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopSpeaking()).toBe(true);
    const r = await talking;
    expect(r.stopped).toBe(true);
    expect(log.filter((l) => l.startsWith("play"))).toHaveLength(1);
    expect(stopSpeaking()).toBe(false);
  });
});
