import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CUE_RATE, CUE_SHAPES, cueFile, cueSeconds, renderCue } from "../src/voice/cues.js";

/** Samples as -1..1, from a 16-bit mono WAV. */
function read(wav: Buffer): number[] {
  const out: number[] = [];
  for (let i = 44; i < wav.length; i += 2) out.push(wav.readInt16LE(i) / 32767);
  return out;
}
const db = (x: number) => 20 * Math.log10(x);
/** Rough pitch from how often the wave crosses zero. */
function pitch(samples: number[]): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 !== samples[i] < 0) crossings++;
  return (crossings / 2) * (CUE_RATE / samples.length);
}

describe("cue sounds", () => {
  it("writes short, quiet 16-bit mono WAVs that start and end in silence, with padding a timed stop lands in", () => {
    for (const name of ["turn", "start"] as const) {
      const wav = renderCue(name);
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
      expect([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)]).toEqual([1, 1, CUE_RATE, 16]);
      expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
      const all = read(wav);
      const end = Math.round(CUE_SHAPES[name].length * CUE_RATE);
      const s = all.slice(0, end);
      expect(Math.max(...s.map(Math.abs))).toBeCloseTo(CUE_SHAPES[name].peak, 2);
      // No click: the first and last few milliseconds are near silent.
      expect(Math.max(...s.slice(0, 20).map(Math.abs))).toBeLessThan(0.01);
      expect(Math.abs(s.at(-1)!)).toBeLessThan(0.001);
      // Played for just past the sound, stopping inside silence well before the file ends.
      expect(all.slice(end).every((x) => x === 0)).toBe(true);
      expect(cueSeconds(name)).toBeGreaterThan(CUE_SHAPES[name].length);
      expect(all.length / CUE_RATE - cueSeconds(name)).toBeGreaterThan(0.2);
    }
  });

  it("makes the turn chime rise and the start cue lower, shorter and about 9 dB quieter", () => {
    const turn = read(renderCue("turn")).slice(0, Math.round(CUE_SHAPES.turn.length * CUE_RATE));
    const start = read(renderCue("start")).slice(0, Math.round(CUE_SHAPES.start.length * CUE_RATE));
    const first = pitch(turn.slice(Math.round(0.01 * CUE_RATE), Math.round(0.09 * CUE_RATE)));
    const second = pitch(turn.slice(Math.round(0.12 * CUE_RATE), Math.round(0.3 * CUE_RATE)));
    expect(first).toBeGreaterThan(560);
    expect(first).toBeLessThan(640);
    expect(second).toBeGreaterThan(840);
    expect(second).toBeLessThan(930);
    expect(pitch(start.slice(0, Math.round(0.1 * CUE_RATE)))).toBeLessThan(first);
    expect(start.length).toBeLessThan(turn.length / 2);
    const quieter = db(Math.max(...turn.map(Math.abs))) - db(Math.max(...start.map(Math.abs)));
    expect(quieter).toBeGreaterThan(8);
    expect(quieter).toBeLessThan(10);
  });

  it("writes each cue once and reuses the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cos-cues-"));
    const file = await cueFile("turn", dir);
    expect(await cueFile("turn", dir)).toBe(file);
    expect(await readFile(file)).toEqual(renderCue("turn"));
    expect(await readdir(dir)).toEqual([file.split("/").pop()]);
    await rm(dir, { recursive: true, force: true });
  });
});
