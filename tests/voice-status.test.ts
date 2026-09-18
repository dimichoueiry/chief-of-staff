import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/** The pill's failure-message logic, as the browser runs it: a plain script that sets window.cosVoiceStatus. */
function load() {
  const src = readFileSync(resolve("src/ui/web/voice-status.js"), "utf8");
  const window: Record<string, unknown> = {};
  vm.runInNewContext(src, { window });
  return window.cosVoiceStatus as {
    forSpeakResult(r: unknown): { tone: string; text: string } | null;
    forSpeechError(code: string): { tone: string; text: string } | null;
  };
}

describe("voice status messages", () => {
  it("says nothing when a reply was read fine, or stopped on purpose", () => {
    const v = load();
    expect(v.forSpeakResult({ ok: true, stopped: false, cued: [] })).toBeNull();
    expect(v.forSpeakResult({ ok: true, stopped: true, cued: [] })).toBeNull();
  });

  it("flags a muted, failed, or unreachable voice as an error, and says the reply is still in the chat", () => {
    const v = load();
    expect(v.forSpeakResult({ ok: true, muted: true })).toEqual({ tone: "error", text: expect.stringContaining("chat") });
    expect(v.forSpeakResult({ error: "boom" })).toEqual({ tone: "error", text: expect.stringContaining("chat") });
    expect(v.forSpeakResult(null)).toMatchObject({ tone: "error" });
  });

  it("maps speech-recognition errors to a message, staying quiet only for a deliberate stop", () => {
    const v = load();
    expect(v.forSpeechError("not-allowed")).toMatchObject({ tone: "error" });
    expect(v.forSpeechError("service-not-allowed")).toMatchObject({ tone: "error" });
    expect(v.forSpeechError("audio-capture")).toMatchObject({ tone: "error" });
    expect(v.forSpeechError("network")).toMatchObject({ tone: "error" });
    expect(v.forSpeechError("no-speech")).toEqual({ tone: "", text: expect.stringContaining("try again") });
    expect(v.forSpeechError("aborted")).toBeNull();
  });
});
