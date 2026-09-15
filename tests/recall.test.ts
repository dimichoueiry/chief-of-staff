import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Conversations, type Conversation, type Turn } from "../src/brain/conversation.js";
import type { ChatRequest, ChatResponse, LLMProvider } from "../src/brain/llm/types.js";
import { digest, renderRecall, searchConversations, summarizeEnded, transcript } from "../src/brain/recall.js";
import { ToolRuntime } from "../src/brain/tools.js";
import { loadConfig } from "../src/config.js";
import { todayISO } from "../src/util/dates.js";

/** Local noon on a day, as ISO, so dates never shift with the machine's time zone. */
const on = (date: string, hour = 12, minute = 0) => new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`).toISOString();

describe("recall across conversations", () => {
  let dir: string;
  let clock: Date;
  let store: Conversations;

  /** Save a finished conversation that happened at a given local time. */
  function past(date: string, turns: Omit<Turn, "at">[], hour = 12): Conversation {
    clock = new Date(on(date, hour));
    const c = store.startNew();
    store.append(c, ...turns);
    clock = new Date(on(date, hour, 20));
    store.append(c); // last message 20 minutes later
    return c;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-recall-"));
    clock = new Date(on("2026-09-01"));
    store = new Conversations(dir, 60, () => clock);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const pricing = (): Omit<Turn, "at">[] => [
    { role: "user", text: "which pricing tier should fampy launch with?" },
    { role: "assistant", text: "Launch with the pro tier at $29; keep a free trial.", model: "openai:gpt-test" },
    { role: "user", text: "ok save that as the next action" },
    {
      role: "assistant", text: "Saved.", model: "openai:gpt-test",
      steps: [
        { role: "assistant", text: "", toolCalls: [{ id: "a", name: "get_project", input: { name: "fampy" } }, { id: "b", name: "upsert_project", input: { name: "fampy" } }] },
        { role: "tool", results: [{ id: "a", content: '{"name":"fampy"}' }, { id: "b", content: 'Updated "fampy": {"next":"launch pro tier at $29"}' }] },
      ],
    },
  ];

  it("writes transcripts with what was done, and digests that say how much they left out", () => {
    const c = past("2026-09-10", pricing());
    const t = transcript(c);
    expect(t.partial).toBe(false);
    expect(t.text).toContain("Them: which pricing tier should fampy launch with?");
    expect(t.text).toContain('(Done: Updated "fampy": {"next":"launch pro tier at $29"})');
    expect(t.text).not.toContain('{"name":"fampy"}'); // lookups are not things that were done

    const long = transcript(c, 100);
    expect(long.partial).toBe(true);
    expect(long.text).toMatch(/^\(The start of this conversation is left out/);

    const many = past("2026-09-11", Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, text: `message ${i + 1}` })));
    expect(digest(many)).toBe('They said "message 1", "message 2", "message 3", and 3 more messages.');
    expect(digest(c)).toBe('They said "which pricing tier should fampy launch with?", "ok save that as the next action". Last reply: Saved.');
  });

  it("puts the last days in memory, newest first, leaving out the conversation in progress and saying what didn't fit", () => {
    past("2026-09-01", pricing()); // too old for a 7-day window ending 09-14
    past("2026-09-10", pricing(), 9);
    const summarized = past("2026-09-12", [{ role: "user", text: "what about tauri?" }, { role: "assistant", text: "Tauri fits the menubar." }]);
    summarized.summary = { text: "They picked Tauri for the menubar app.", model: "openai:gpt-test", at: on("2026-09-12") };
    store.update(summarized);
    const partial = past("2026-09-13", [{ role: "user", text: "long one" }, { role: "assistant", text: "…" }]);
    partial.summary = { text: "They planned the launch week.", model: "openai:gpt-test", at: on("2026-09-13"), partial: true };
    store.update(partial);
    const inProgress = past("2026-09-14", [{ role: "user", text: "right now" }, { role: "assistant", text: "yes" }]);
    past("2026-09-14", [], 15); // an empty conversation never shows

    const text = renderRecall(store, { today: "2026-09-14", excludeId: inProgress.id });
    const lines = text.split("\n");
    expect(lines[0]).toBe("# Earlier conversations (last 7 days, newest first)");
    expect(lines.slice(2)).toEqual([
      "- 2026-09-13 Sun 12:00–12:20: They planned the launch week. (summary of the later part only)",
      "- 2026-09-12 Sat 12:00–12:20: They picked Tauri for the menubar app.",
      '- 2026-09-10 Thu 09:00–09:20: They said "which pricing tier should fampy launch with?", "ok save that as the next action". Last reply: Saved.',
    ]);

    const tight = renderRecall(store, { today: "2026-09-14", excludeId: inProgress.id, maxChars: 150 });
    expect(tight.split("\n").slice(2)).toEqual([
      "- 2026-09-13 Sun 12:00–12:20: They planned the launch week. (summary of the later part only)",
      "(2 more conversations from these days are not listed here to save space; get_conversations finds them.)",
    ]);
    expect(renderRecall(new Conversations(join(dir, "none")), { today: "2026-09-14" })).toBe("");
  });

  it("searches every conversation, reports true counts, and says when results are cut", async () => {
    for (let d = 1; d <= 12; d++) past(`2026-09-${String(d).padStart(2, "0")}`, pricing());
    past("2026-09-13", [{ role: "user", text: "what about tauri?" }, { role: "assistant", text: "Tauri fits the menubar." }]);
    await writeFile(join(dir, "0000-broken.json"), "{");

    const r = searchConversations(store, { query: "What did we decide about the pricing tier?", limit: 3 });
    const [head, ...rest] = r.split("\n");
    expect(head).toBe(
      '12 exchanges matching "What did we decide about the pricing tier?" in 12 conversations (searched 13 saved conversations; 1 damaged file could not be read). Showing the best 3; use more specific words or dates to see the rest.',
    );
    expect(rest.filter((l) => l.startsWith("They said:"))).toHaveLength(3);
    expect(rest.join("\n")).toMatch(/^\n2026-09-12 Sat 12:00\nThey said: which pricing tier/); // equal scores: newest first

    // "save … next action" matched through what the reply did, not only its words.
    expect(searchConversations(store, { query: "launch pro tier", from: "2026-09-05", to: "2026-09-06" })).toMatch(/^4 exchanges matching "launch pro tier" in 2 conversations \(searched 2 saved conversations from 2026-09-05 to 2026-09-06/);
    expect(searchConversations(store, { query: "tauri" })).toContain("You replied: Tauri fits the menubar.");
    expect(searchConversations(store, { query: "kubernetes" })).toBe('Nothing matching "kubernetes" in 13 saved conversations; 1 damaged file could not be read.');

    const byDate = searchConversations(store, { from: "2026-09-13" });
    expect(byDate.split("\n")).toEqual([
      "1 saved conversation from 2026-09-13 to today, newest first; 1 damaged file could not be read:",
      "- 2026-09-13 Sun 12:00–12:20: They said \"what about tauri?\". Last reply: Tauri fits the menubar.",
    ]);
    expect(searchConversations(store, { from: "2027-01-01" })).toBe("No conversations from 2027-01-01 to today.");
  });

  it("is available to the model as get_conversations, with date checks", async () => {
    past("2026-09-10", pricing());
    const rt = new ToolRuntime(loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent" }), "2026-09-14", undefined, { conversations: store });
    expect((await rt.execute("get_conversations", { query: "pricing" })).result).toMatch(/^1 exchange matching "pricing"/);
    expect((await rt.execute("get_conversations", { from: "last week" })).isError).toBe(true);
    expect((await rt.execute("get_conversations", { from: "2026-09-12", to: "2026-09-01" })).isError).toBe(true);
  });

  it("summarises ended conversations: short ones from their words, long ones by the model, never the one in progress", async () => {
    const requests: ChatRequest[] = [];
    let replies: Array<ChatResponse | Error> = [];
    const provider: LLMProvider = {
      id: "openai",
      async chat(req) {
        requests.push(structuredClone(req));
        const next = replies.shift();
        if (!next || next instanceof Error) throw next ?? new Error("script exhausted");
        return next;
      },
    };
    const llm = { provider, spec: { provider: "openai" as const, model: "gpt-test" } };
    const long = (text: string): Omit<Turn, "at">[] => [
      { role: "user", text: `${text} ${"details ".repeat(40)}` },
      { role: "assistant", text: `Answer about ${text}. ${"more ".repeat(40)}` },
    ];

    const short = past("2026-09-10", [{ role: "user", text: "hi" }, { role: "assistant", text: "Hello." }]);
    const pricingTalk = past("2026-09-11", long("pricing"));
    const tauriTalk = past("2026-09-12", long("tauri"));
    clock = new Date(on("2026-09-14", 10));
    const active = store.current();
    store.append(active, ...long("right now"));

    replies = [{ text: "They chose the pro tier at $29.", toolCalls: [], stop: "end", model: "x" }, new Error("503 overloaded")];
    const first = await summarizeEnded(store, llm, { now: clock });
    expect(first).toEqual({ summarized: 2, failed: 1, waiting: 0 });
    const byId = new Map(store.list().conversations.map((c) => [c.id, c]));
    expect(byId.get(short.id)?.summary).toMatchObject({ model: "rules", text: 'They said "hi". Last reply: Hello.' });
    expect(byId.get(tauriTalk.id)?.summary).toMatchObject({ model: "openai:gpt-test", text: "They chose the pro tier at $29." }); // newest first
    expect(byId.get(pricingTalk.id)?.summaryFailedAt).toBe(clock.toISOString());
    expect(byId.get(active.id)?.summary).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ tools: [], effort: "low" });
    expect(requests[0].instructions).toContain("Refer to the user as \"they\"");
    expect(requests[0].messages[0].role === "user" && requests[0].messages[0].content).toMatch(/Them: tauri details/);

    // A failure waits six hours before it is tried again.
    clock = new Date(clock.getTime() + 30 * 60_000); // still inside the hour: nothing new has ended, nothing retried
    expect(await summarizeEnded(store, llm, { now: clock })).toEqual({ summarized: 0, failed: 0, waiting: 0 });
    // Six hours on: the failed one is retried, and the quiet one in progress has ended.
    replies = [{ text: "They talked about right now.", toolCalls: [], stop: "end", model: "x" }, { text: "They weighed pricing options.", toolCalls: [], stop: "end", model: "x" }];
    clock = new Date(clock.getTime() + 6 * 60 * 60_000);
    expect(await summarizeEnded(store, llm, { now: clock })).toEqual({ summarized: 2, failed: 0, waiting: 0 });
    const retried = store.list().conversations.find((c) => c.id === pricingTalk.id);
    expect(retried?.summary?.text).toBe("They weighed pricing options.");
    expect(retried?.summaryFailedAt).toBeUndefined();

    // No model: long conversations wait instead of getting a worse summary.
    past("2026-09-13", long("roadmap"));
    clock = new Date(on("2026-09-14", 23));
    expect(await summarizeEnded(store, null, { now: clock })).toEqual({ summarized: 0, failed: 0, waiting: 1 });
    expect(todayISO(clock)).toBe("2026-09-14");
  });
});
