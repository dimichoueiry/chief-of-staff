import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Conversations, historyMessages, visibleTurns, type Conversation } from "../src/brain/conversation.js";

describe("conversation store", () => {
  let dir: string;
  let clock: Date;
  const store = () => new Conversations(dir, 60, () => clock);
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-convo-"));
    clock = new Date("2026-09-14T10:00:00Z");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("continues the same conversation until it goes quiet, then starts fresh", () => {
    const first = store().current();
    expect(first.turns).toEqual([]);
    store().append(first, { role: "user", text: "what should I do today?" }, { role: "assistant", text: "Record the intro.", model: "openai:gpt-test" });

    clock = new Date("2026-09-14T10:59:00Z");
    const again = store().current();
    expect(again.id).toBe(first.id);
    expect(again.turns.map((t) => t.text)).toEqual(["what should I do today?", "Record the intro."]);
    store().append(again, { role: "user", text: "and tomorrow?" }, { role: "assistant", text: "Nothing booked." });

    clock = new Date("2026-09-14T11:58:00Z"); // 59 minutes after the last message, not the first
    expect(store().current().id).toBe(first.id);
    clock = new Date("2026-09-14T13:00:00Z");
    const later = store().current();
    expect(later.id).not.toBe(first.id);
    expect(later.turns).toEqual([]);
  });

  it("starts a new conversation on request without piling up empty ones, and skips damaged files", async () => {
    const c = store().current();
    store().append(c, { role: "user", text: "hi" }, { role: "assistant", text: "Hello." });
    clock = new Date("2026-09-14T10:01:00Z");
    const fresh = store().startNew();
    expect(fresh.id).not.toBe(c.id);
    expect(store().current().id).toBe(fresh.id);
    expect(store().startNew().id).toBe(fresh.id);
    await writeFile(join(dir, "9999-broken.json"), "{ not json");
    expect(store().current().id).toBe(fresh.id);
    expect((await readdir(dir)).filter((n) => n.endsWith(".json"))).toHaveLength(3);
  });

  it("shows turns to the page without the tool steps", () => {
    const c: Conversation = {
      id: "x", startedAt: "", updatedAt: "",
      turns: [{ role: "assistant", text: "Done.", at: "", steps: [{ role: "tool", results: [] }] }],
    };
    expect(visibleTurns(c)).toEqual([{ role: "assistant", text: "Done.", at: "" }]);
  });
});

describe("history sent to the model", () => {
  const at = "2026-09-14T10:00:00Z";
  const convo = (turns: Conversation["turns"]): Conversation => ({ id: "c", startedAt: at, updatedAt: at, turns });

  it("replays exchanges with their tool steps, rewrites ids, drops provider data and cuts long results", () => {
    const h = historyMessages(
      convo([
        { role: "user", text: "what's on friday?", at },
        {
          role: "assistant", text: "Board meeting at 2.", at, model: "anthropic:claude-opus-5",
          steps: [
            { role: "assistant", text: "", toolCalls: [{ id: "toolu_01:A", name: "get_calendar", input: { from: "2026-09-18" } }], providerData: [{ type: "thinking" }] },
            { role: "tool", results: [{ id: "toolu_01:A", content: "x".repeat(3000) }] },
          ],
        },
        { role: "user", text: "and saturday?", at },
        { role: "assistant", text: "", at },
      ]),
      { maxToolChars: 100 },
    );
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant"]);
    expect(h[1]).toEqual({ role: "assistant", text: "", toolCalls: [{ id: "h1_toolu_01_A", name: "get_calendar", input: { from: "2026-09-18" } }] });
    expect(h[2]).toMatchObject({ role: "tool", results: [{ id: "h1_toolu_01_A" }] });
    expect(h[2].role === "tool" && h[2].results[0].content).toMatch(/^x{100}\n… \(cut\)$/);
    expect(h[3]).toEqual({ role: "assistant", text: "Board meeting at 2.", toolCalls: [] });
    expect(h[5]).toEqual({ role: "assistant", text: "(no reply)", toolCalls: [] });
  });

  it("tells the model about confirmations with the next message and ignores unanswered messages", () => {
    const h = historyMessages(
      convo([
        { role: "user", text: "find the tauri docs", at },
        { role: "assistant", text: "Want me to open https://tauri.app?", at, kind: "confirm" },
        { role: "event", text: "They confirmed, and https://tauri.app/ was opened.", at },
        { role: "user", text: "a message whose reply was lost", at },
        { role: "user", text: "thanks, now the menubar guide", at },
        { role: "assistant", text: "Here it is.", at },
      ]),
    );
    expect(h).toHaveLength(4);
    expect(h[2]).toEqual({ role: "user", content: "(Since your last reply: They confirmed, and https://tauri.app/ was opened.)\n\nthanks, now the menubar guide" });
  });

  it("keeps the newest exchanges that fit, dropping whole exchanges", () => {
    const turns: Conversation["turns"] = [];
    for (let i = 1; i <= 6; i++) turns.push({ role: "user", text: `question ${i}`, at }, { role: "assistant", text: "a".repeat(200), at });
    const bySize = historyMessages(convo(turns), { maxChars: 900 }); // each exchange is about 290 characters
    expect(bySize.filter((m) => m.role === "user").map((m) => m.role === "user" && m.content)).toEqual([
      "(3 earlier exchanges in this conversation are not repeated here; get_conversations can look them up.)\n\nquestion 4",
      "question 5",
      "question 6",
    ]);
    const byCount = historyMessages(convo(turns), { maxExchanges: 2 });
    expect(byCount).toHaveLength(4);
    expect(byCount[0].role === "user" && byCount[0].content).toMatch(/^\(4 earlier exchanges/);
    expect(historyMessages(convo(turns)).every((m) => m.role !== "user" || !m.content.startsWith("("))).toBe(true); // nothing left out, no note
    // A single exchange bigger than the budget is still kept: the last thing said matters most.
    expect(historyMessages(convo(turns.slice(0, 2)), { maxChars: 10 })).toHaveLength(2);
  });
});
