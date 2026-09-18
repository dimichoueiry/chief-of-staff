import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/** The pill's mic-error copy, as the browser runs it: a plain script that sets window.cosMicErrors. */
function load() {
  const src = readFileSync(resolve("src/ui/web/mic-errors.js"), "utf8");
  const window: Record<string, unknown> = {};
  vm.runInNewContext(src, { window });
  return window.cosMicErrors as { messageFor(error: string): string };
}

describe("what to say when the browser's microphone fails", () => {
  it("explains a blocked microphone and how to retry, without ever naming System Settings (there's no such thing in a browser)", () => {
    const { messageFor } = load();
    for (const denied of ["not-allowed", "service-not-allowed"]) {
      const text = messageFor(denied);
      expect(text).toContain("typing still works");
      expect(text).toMatch(/allow it/i);
      expect(text).not.toMatch(/system settings/i);
    }
  });

  it("says there's no microphone, not that access was denied", () => {
    expect(load().messageFor("audio-capture")).toBe("No microphone found — typing still works.");
  });

  it("stays quiet for a plain timeout or a stop it asked for itself", () => {
    const { messageFor } = load();
    expect(messageFor("no-speech")).toBe("");
    expect(messageFor("aborted")).toBe("");
  });

  it("never returns nothing for a surprise error — silence is the bug this fixes", () => {
    expect(load().messageFor("network")).toBe("Couldn't use the microphone — typing still works.");
    expect(load().messageFor(undefined as unknown as string)).not.toBe("");
  });
});
