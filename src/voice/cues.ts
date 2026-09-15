/**
 * Turn-taking cues: short chimes around the spoken voice.
 *
 * - turn: two soft notes rising a fifth, played after the last word when the mic is
 *   about to open for a reply. It means "your turn".
 * - start: one lower, shorter note about 9 dB quieter, played as a spoken reply begins
 *   so the first words aren't missed.
 *
 * Both sit well under the voice (peaks at -14 and -23 dBFS). They are synthesised here,
 * so there are no audio assets, and written once to ~/.cos/sounds as 16-bit mono WAV.
 *
 * Each file ends in silence that is never played. afplay keeps running about a second
 * after a file's last sample, which would hold the mic shut after the chime; told to
 * stop partway (-t), it exits at once. So a cue plays for cueSeconds(), just past its
 * sound and short of the padding.
 */
import { createHash } from "node:crypto";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cosHome } from "../util/home.js";

export type CueName = "start" | "turn";

export const CUE_RATE = 44_100;

interface Note {
  /** Seconds from the start of the cue. */
  at: number;
  freq: number;
  gain: number;
  /** Seconds for the note to fall to about a third. */
  decay: number;
}

interface CueShape {
  /** Seconds, including the fade to silence. */
  length: number;
  /** Loudest sample, 0 to 1. */
  peak: number;
  notes: Note[];
}

export const CUE_SHAPES: Record<CueName, CueShape> = {
  // D5 then A5: an open, rising interval that reads as a question.
  turn: {
    length: 0.42,
    peak: 0.2,
    notes: [
      { at: 0, freq: 587.33, gain: 0.8, decay: 0.09 },
      { at: 0.1, freq: 880, gain: 1, decay: 0.14 },
    ],
  },
  // A4 alone: a soft tap, distinct from the turn cue by pitch, length and loudness.
  start: {
    length: 0.16,
    peak: 0.07,
    notes: [{ at: 0, freq: 440, gain: 1, decay: 0.05 }],
  },
};

const ATTACK = 0.005;
const FADE = 0.04;
/** Silence after the sound, so a timed stop lands inside the file. */
const PADDING = 0.3;
/** Played past the sound, so the fade is never cut. */
const MARGIN = 0.06;

/** How long to play a cue: all of its sound and none of its padding. */
export function cueSeconds(name: CueName): number {
  return CUE_SHAPES[name].length + MARGIN;
}

/** The cue as WAV bytes: a sine with a quiet octave and a brief bell partial, no clicks at either end, then silence. */
export function renderCue(name: CueName): Buffer {
  const shape = CUE_SHAPES[name];
  const n = Math.round(shape.length * CUE_RATE);
  const samples = new Float64Array(n + Math.round(PADDING * CUE_RATE));
  for (const note of shape.notes) {
    for (let i = Math.round(note.at * CUE_RATE); i < n; i++) {
      const t = i / CUE_RATE - note.at;
      const attack = t < ATTACK ? 0.5 - 0.5 * Math.cos((Math.PI * t) / ATTACK) : 1;
      const w = 2 * Math.PI * note.freq * t;
      const body = (Math.sin(w) + 0.2 * Math.sin(2 * w)) * Math.exp(-t / note.decay);
      const shimmer = 0.05 * Math.sin(2.76 * w) * Math.exp((-3 * t) / note.decay);
      samples[i] += note.gain * attack * (body + shimmer);
    }
  }
  const fade = Math.round(FADE * CUE_RATE);
  for (let k = 0; k < fade; k++) samples[n - fade + k] *= 0.5 + 0.5 * Math.cos((Math.PI * (k + 1)) / fade);
  const loudest = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  const scale = loudest ? shape.peak / loudest : 0;

  const bytes = samples.length * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(CUE_RATE, 24);
  wav.writeUInt32LE(CUE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.round(samples[i] * scale * 32767), 44 + i * 2);
  return wav;
}

export function cueDir(): string {
  return join(cosHome(), "sounds");
}

/** The cue's file, written on first use. The name carries the shape, so a changed sound gets a new file. */
export async function cueFile(name: CueName, dir: string = cueDir()): Promise<string> {
  const version = createHash("sha1").update(JSON.stringify([CUE_SHAPES[name], PADDING])).digest("hex").slice(0, 8);
  const file = join(dir, `${name}-${version}.wav`);
  try {
    await access(file);
  } catch {
    await mkdir(dir, { recursive: true });
    const partial = `${file}.${process.pid}.tmp`;
    await writeFile(partial, renderCue(name));
    await rename(partial, file);
  }
  return file;
}
