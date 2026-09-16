import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/** The page's command parser, as the browser runs it: a plain script that sets window.cosCommands. */
function load() {
  const src = readFileSync(resolve("src/ui/web/commands.js"), "utf8");
  const window: Record<string, unknown> = {};
  vm.runInNewContext(src, { window });
  return window.cosCommands as {
    setName(n: string): void;
    name: string;
    isName(w: string): boolean;
    addressed(text: string): { named: boolean; rest: string };
    aside(rest: string): string | null;
    backOnTopic(rest: string): boolean;
  };
}

describe("spoken commands by name", () => {
  it("strips the name from the front, as the recogniser may have heard it, and never matches the name alone", () => {
    const c = load();
    expect(c.addressed("Darius, start a new chat")).toEqual({ named: true, rest: "start a new chat" });
    expect(c.addressed("hey darius new chat")).toEqual({ named: true, rest: "new chat" });
    expect(c.addressed("Darius. Back on topic.")).toEqual({ named: true, rest: "Back on topic." });
    expect(c.addressed("Darias by the way, what time is it?")).toEqual({ named: true, rest: "by the way, what time is it?" });
    expect(c.addressed("Marius, quick question")).toEqual({ named: true, rest: "quick question" });
    expect(c.addressed("Dare us, by the way")).toEqual({ named: true, rest: "by the way" });
    expect(c.addressed("Darius's calendar")).toEqual({ named: true, rest: "calendar" });
    expect(c.addressed("Darius")).toEqual({ named: false, rest: "Darius" });
    expect(c.addressed("Various things to do")).toEqual({ named: false, rest: "Various things to do" });
    expect(c.addressed("what should I do today?")).toEqual({ named: false, rest: "what should I do today?" });
    expect(c.addressed("  ")).toEqual({ named: false, rest: "" });
  });

  it("answers to the name from cos voice name", () => {
    const c = load();
    c.setName("Nova");
    expect(c.name).toBe("nova");
    expect(c.addressed("Nova, new chat")).toEqual({ named: true, rest: "new chat" });
    expect(c.addressed("Nova new chat").named).toBe(true);
    expect(c.addressed("Darius, new chat").named).toBe(false);
    expect(c.isName("nova")).toBe(true);
    expect(c.isName("moba")).toBe(false); // short names take one slip, not two
    c.setName("");
    expect(c.name).toBe("nova");
  });

  it("hears a by-the-way, with or without the question in the same breath, but not inside other words", () => {
    const c = load();
    expect(c.aside("by the way, what's the capital of France?")).toBe("what's the capital of France?");
    expect(c.aside("by the way what time is it")).toBe("what time is it");
    expect(c.aside("quick question: how tall is the Eiffel Tower?")).toBe("how tall is the Eiffel Tower?");
    expect(c.aside("side note but is it raining")).toBe("is it raining");
    expect(c.aside("oh, unrelated, do I have anything on friday")).toBe("do I have anything on friday");
    expect(c.aside("by the way")).toBe("");
    expect(c.aside("Quick question.")).toBe("");
    expect(c.aside("by the wayside I fell")).toBeNull();
    expect(c.aside("what should I do today")).toBeNull();
    expect(c.aside("start a new chat")).toBeNull();
  });

  it("hears the way back on topic, but not a request to open another chat", () => {
    const c = load();
    for (const said of ["back on topic", "Back to the topic.", "okay, back to what we were saying", "let's get back to it", "where were we?", "and now back to the main chat", "end aside", "resume the main conversation", "thanks, back on topic"]) {
      expect(c.backOnTopic(said), said).toBe(true);
    }
    for (const said of ["back on the topic of pricing", "go back to the module 6 chat", "back to the chat about campuswire", "what were we saying about pricing", "new chat"]) {
      expect(c.backOnTopic(said), said).toBe(false);
    }
  });
});
