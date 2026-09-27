import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACK_COPY, ackFor, lexicalIntent, type AckIntent } from "../src/voice/ack.js";
import { ACK_WAIT_MS, DEFAULT_VOICE, isSpeaking, preload, speak, stopSpeaking, type SpeechEngine, type VoiceSettings } from "../src/voice/tts.js";

describe("acknowledgement copy", () => {
  it("never claims anything was done, and is short enough to be over before most replies", () => {
    for (const text of Object.values(ACK_COPY)) {
      expect(text.split(" ").length).toBeLessThanOrEqual(3);
      // No past tense or promises of an outcome: done, opened, sent, saved, finished, "I've", "all set".
      expect(text).not.toMatch(/\b(?:done|opened|sent|saved|finished|complete[d]?|success|all set|i'?ve|here(?:'s| is))\b/i);
    }
  });
});

describe("intent from the words alone", () => {
  const cases: [string, AckIntent][] = [
    ["What's the capital of Peru?", "question"],
    ["how long is the flight to Lisbon", "question"],
    ["should I take the job", "question"],
    ["Can you tell me what's left on MLGuerrilla?", "question"],
    ["could you explain the heartbeat", "question"],
    ["tell me about the Q3 plan", "question"],
    ["Open Cursor", "action"],
    ["send Sam the deck", "action"],
    ["Could you draft an email to Mia", "action"],
    ["please start an agent on the docs", "action"],
    ["I need you to book a table for two", "action"],
    ["What's on my calendar today", "lookup"],
    ["check my email", "lookup"],
    ["search for flights to Tokyo", "lookup"],
    ["where are we on the launch", "lookup"],
    ["how's the migration going", "lookup"],
    ["can you look up the weather", "lookup"],
    ["Remember that Sam prefers mornings", "note"],
    ["note: call the bank", "note"],
    ["remind me to call Mom", "note"],
    ["the thing from before", "ambiguous"],
    ["Mia's birthday", "ambiguous"],
  ];
  it.each(cases)("%s → %s", (said, intent) => {
    expect(lexicalIntent(said)).toBe(intent);
    expect(ackFor(said)).toEqual({ intent, text: ACK_COPY[intent], source: "lexical" });
  });

  it("looks past fillers and a greeting in front", () => {
    expect(ackFor("okay so um what time is it")?.intent).toBe("question");
    expect(ackFor("hey, please open Slack")?.intent).toBe("action");
  });

  it("says nothing for small talk or silence: the reply is quick and there's nothing to wait for", () => {
    for (const said of ["", "   ", "thanks", "Thank you!", "hi", "good morning", "cool"]) expect(ackFor(said)).toBeNull();
  });
});

describe("intent the server already knows", () => {
  it("wins over the words", () => {
    expect(ackFor("Sam prefers mornings", { mode: "capture" })).toEqual({ intent: "note", text: "Got it.", source: "known" });
    expect(ackFor("what's this?", { mode: "capture" })?.intent).toBe("note");
    expect(ackFor("get Cursor up", { opens: true })).toMatchObject({ intent: "action", source: "known" });
    expect(ackFor("what do you make of this", { looks: true })).toMatchObject({ intent: "lookup", source: "known" });
  });

  it("answers a clear yes or no to something waiting with a plain okay, even a one-word one", () => {
    expect(ackFor("okay", { consent: "yes" })).toEqual({ intent: "reply", text: "Okay.", source: "known" });
    expect(ackFor("no, don't send it", { consent: "no" })?.intent).toBe("reply");
    // Unclear is left to the words, like the turn itself leaves it to the model.
    expect(ackFor("yes but change the subject", { consent: "unclear" })?.source).toBe("lexical");
  });

  it("is decided synchronously, with nothing to await", () => {
    const r = ackFor("what's the weather");
    expect(r).not.toBeInstanceOf(Promise);
  });
});

/**
 * A fake engine that plays in real (fake) time: synthesis and each playback end only when released or
 * killed, and it records how many sounds were ever playing at once.
 */
function timedEngine() {
  const log: string[] = [];
  let playing = 0;
  let mostAtOnce = 0;
  const synths: { text: string; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  const plays: { what: string; end: () => void }[] = [];
  const child = (onKill: () => void) => {
    const c = new EventEmitter() as unknown as ChildProcess;
    (c as unknown as { kill: () => boolean }).kill = () => (onKill(), true);
    return c;
  };
  const sound = (what: string, track: (c: ChildProcess) => void) =>
    new Promise<void>((resolve) => {
      playing++;
      mostAtOnce = Math.max(mostAtOnce, playing);
      log.push(`start ${what}`);
      let over = false;
      const entry = { what, end: () => end("end") };
      const end = (how: string) => {
        if (over) return;
        over = true;
        plays.splice(plays.indexOf(entry), 1);
        playing--;
        log.push(`${how} ${what}`);
        resolve();
      };
      plays.push(entry);
      track(child(() => end("killed")));
    });
  const engine: SpeechEngine = {
    synthesize: (text, _s, signal) =>
      new Promise((resolve, reject) => {
        log.push(`synth ${text}`);
        synths.push({ text, resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    play: (file, track) => sound(file.split("/").pop()!, track),
    say: (text, _s, track) => sound(text, track),
  };
  return {
    engine, log, synths, plays,
    get mostAtOnce() { return mostAtOnce; },
    get playing() { return playing; },
    /** Finish synthesising the oldest piece still being made. */
    synthDone(text: string) {
      const i = synths.findIndex((s) => s.text === text);
      synths.splice(i, 1)[0].resolve(Buffer.from(text));
    },
    /** End whatever is playing now. */
    endPlaying() {
      plays[0]?.end();
    },
  };
}

const openai: VoiceSettings = { ...DEFAULT_VOICE, provider: "openai", cues: "off" };
const mac: VoiceSettings = { ...DEFAULT_VOICE, provider: "say", cues: "off" };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("an acknowledgement gives way to the reply", () => {
  afterEach(() => {
    stopSpeaking();
  });

  it("is dropped, never heard, when the reply is ready before the acknowledgement could be", async () => {
    const e = timedEngine();
    const ack = speak("Looking into it.", { ack: true, settings: openai, engine: e.engine });
    await tick(); // still synthesising: nothing audible yet
    const reply = speak("It's 14 degrees.", { settings: openai, engine: e.engine });
    expect((await ack).stopped).toBe(true);
    await tick();
    e.synthDone("It's 14 degrees.");
    await tick();
    e.endPlaying();
    const r = await reply;
    expect(r.stopped).toBe(false);
    expect(e.log.filter((l) => l.startsWith("start"))).toHaveLength(1); // only the reply was ever played
    expect(e.log.some((l) => l.includes("Looking into it"))).toBe(true); // it was being made, then dropped
  });

  it("is heard to its end when already playing, and the reply starts only after: never both at once", async () => {
    const e = timedEngine();
    const ack = speak("On it.", { ack: true, settings: mac, engine: e.engine });
    await tick();
    expect(e.playing).toBe(1);
    const reply = speak("Opened Cursor.", { settings: mac, engine: e.engine });
    await tick();
    expect(e.log).toEqual(["start On it."]); // the reply waits; the ack isn't cut mid-word
    e.endPlaying(); // the ack ends by itself
    await tick();
    expect(e.log).toEqual(["start On it.", "end On it.", "start Opened Cursor."]);
    e.endPlaying();
    expect((await reply).stopped).toBe(false);
    expect((await ack).stopped).toBe(false);
    expect(e.mostAtOnce).toBe(1);
  });

  it("is cut if it runs past ACK_WAIT_MS, so a stuck player can't hold the reply", async () => {
    const e = timedEngine();
    speak("On it.", { ack: true, settings: mac, engine: e.engine });
    await tick();
    const started = Date.now();
    const reply = speak("Opened Cursor.", { settings: mac, engine: e.engine });
    while (!e.log.includes("start Opened Cursor.")) await tick();
    expect(Date.now() - started).toBeGreaterThanOrEqual(ACK_WAIT_MS - 50);
    expect(e.log).toContain("killed On it.");
    expect(e.mostAtOnce).toBe(1);
    e.endPlaying();
    await reply;
  }, ACK_WAIT_MS + 3_000);

  it("never talks over speech already under way", async () => {
    const e = timedEngine();
    const news = speak("Your agent finished the docs.", { settings: mac, engine: e.engine });
    await tick();
    const ack = await speak("Looking into it.", { ack: true, settings: mac, engine: e.engine });
    expect(ack).toMatchObject({ stopped: true, pieces: 0 });
    expect(e.log).toEqual(["start Your agent finished the docs."]);
    e.endPlaying();
    expect((await news).stopped).toBe(false);
  });
});

describe("stopping an acknowledgement", () => {
  afterEach(() => {
    stopSpeaking();
  });

  it("stops it at once while it plays", async () => {
    const e = timedEngine();
    const ack = speak("Looking into it.", { ack: true, settings: mac, engine: e.engine });
    await tick();
    expect(isSpeaking()).toBe(true);
    expect(stopSpeaking()).toBe(true);
    expect((await ack).stopped).toBe(true);
    expect(e.log).toEqual(["start Looking into it.", "killed Looking into it."]);
    expect(isSpeaking()).toBe(false);
  });

  it("stops both the acknowledgement and the reply waiting behind it", async () => {
    const e = timedEngine();
    const ack = speak("On it.", { ack: true, settings: mac, engine: e.engine });
    await tick();
    const reply = speak("Opened Cursor.", { settings: mac, engine: e.engine });
    await tick();
    expect(stopSpeaking()).toBe(true);
    const [a, r] = await Promise.all([ack, reply]);
    expect(a.stopped).toBe(true);
    expect(r.stopped).toBe(true);
    await tick();
    expect(e.log).toEqual(["start On it.", "killed On it."]); // the reply never started
    expect(isSpeaking()).toBe(false);
  });

  it("cancels synthesis of one not yet heard, so it can't start late", async () => {
    const e = timedEngine();
    const ack = speak("Looking into it.", { ack: true, settings: openai, engine: e.engine });
    await tick();
    stopSpeaking();
    expect((await ack).stopped).toBe(true);
    await tick();
    expect(e.log.filter((l) => l.startsWith("start"))).toEqual([]);
  });
});

describe("acknowledgement audio cache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-acks-"));
  });
  afterEach(async () => {
    stopSpeaking();
    await rm(dir, { recursive: true, force: true });
  });

  it("is made once, then played with no synthesis at all", async () => {
    const made: string[] = [];
    const engine: SpeechEngine = {
      synthesize: async (text) => (made.push(text), Buffer.from(text)),
      play: async () => {},
      say: async () => {},
    };
    expect(await preload(["On it.", "Got it."], dir, { settings: openai, engine })).toBe(2);
    expect(await preload(["On it.", "Got it."], dir, { settings: openai, engine })).toBe(0);
    expect(made).toEqual(["On it.", "Got it."]);
    await speak("On it.", { ack: true, settings: openai, engine, cacheDir: dir });
    expect(made).toHaveLength(2);
    // A different voice sounds different, so it gets its own file.
    await speak("On it.", { ack: true, settings: { ...openai, voice: "cedar" }, engine, cacheDir: dir });
    expect(made).toHaveLength(3);
    expect((await readdir(dir)).filter((f) => f.endsWith(".mp3"))).toHaveLength(3);
  });

  it("isn't made for the Mac voice, which has nothing to wait for", async () => {
    const engine: SpeechEngine = { synthesize: async () => { throw new Error("no"); }, play: async () => {}, say: async () => {} };
    expect(await preload(["On it."], dir, { settings: mac, engine })).toBe(0);
  });
});
