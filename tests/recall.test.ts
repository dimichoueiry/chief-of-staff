import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Conversations, type Conversation, type Turn } from "../src/brain/conversation.js";
import type { ChatRequest, ChatResponse, LLMProvider } from "../src/brain/llm/types.js";
import { digest, findConversation, nameConversations, renderRecall, searchConversations, summarizeEnded, transcript } from "../src/brain/recall.js";
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
    // Stepping out for an aside doesn't end the chat in progress either, and the aside itself is never summarised.
    const aside = store.startAside();
    store.append(aside, ...long("an aside"));
    expect(await summarizeEnded(store, llm, { now: clock })).toEqual({ summarized: 0, failed: 0, waiting: 0 });
    expect(store.get(active.id)?.summary).toBeUndefined();
    expect(store.endAside()?.id).toBe(active.id);
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

  it("never saves a summary over a chat that was picked up again while it was being written", async () => {
    const said = `let's plan the roadmap ${"details ".repeat(60)}`;
    const ended = past("2026-09-10", [{ role: "user", text: said }, { role: "assistant", text: "Here's a plan." }]);
    const provider: LLMProvider = {
      id: "openai",
      async chat() {
        clock = new Date(on("2026-09-14", 10));
        store.open(ended.id);
        store.append(store.current(), { role: "user", text: "back to the roadmap" }); // said during the model call
        return { text: "They planned the roadmap.", toolCalls: [], stop: "end", model: "x" };
      },
    };
    clock = new Date(on("2026-09-14", 9));
    await summarizeEnded(store, { provider, spec: { provider: "openai", model: "gpt-test" } }, { now: clock });
    const saved = store.list().conversations.find((c) => c.id === ended.id)!;
    expect(saved.summary).toBeUndefined();
    expect(saved.turns.map((t) => t.text)).toEqual([said, "Here's a plan.", "back to the roadmap"]);
  });

  it("finds the chat someone means by a few words: by its name first, then anything said in it", () => {
    const review = past("2026-09-10", [{ role: "user", text: "review module six for me" }, { role: "assistant", text: "It needs a recovery section." }]);
    const favorites = past("2026-09-11", [{ role: "user", text: "open campuswire from my UIUC favorites" }, { role: "assistant", text: "Opened Campuswire." }]);
    const cache = past("2026-09-12", [{ role: "user", text: "what did we decide about redis?" }, { role: "assistant", text: "Module 6 says Redis can go stale." }]);
    store.rename(review.id, "Module 6 review");

    expect(findConversation(store, "module 6")?.id).toBe(review.id); // in its name beats a newer chat that mentions it
    expect(findConversation(store, "the module six one")?.id).toBe(review.id);
    expect(findConversation(store, "campus")?.id).toBe(favorites.id); // from the start of a word
    expect(findConversation(store, "wire")).toBeNull(); // never from inside one
    expect(findConversation(store, "stale redis")?.id).toBe(cache.id); // anything said in it
    expect(findConversation(store, "module 6 kubernetes")).toBeNull(); // every word has to be there
    expect(findConversation(store, "the last one", { excludeId: cache.id })?.id).toBe(favorites.id);
    expect(findConversation(store, "module 6", { excludeId: review.id })?.id).toBe(cache.id);
    expect(findConversation(store, "chat")).toBeNull();
  });

  it("names new chats from their first messages, then leaves the name alone", async () => {
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
    const answer = (text: string): ChatResponse => ({ text, toolCalls: [], stop: "end", model: "x" });

    const named = past("2026-09-10", [{ role: "user", text: "hi" }, { role: "assistant", text: "Hello." }]);
    store.rename(named.id, "Mine");
    const favorites = past("2026-09-11", [{ role: "user", text: "open campuswire" }, { role: "assistant", text: "Opened." }]);
    clock = new Date(on("2026-09-14", 10));
    const live = store.startNew();
    store.append(live, { role: "user", text: "look at the module 6 quizzes" });
    expect(await nameConversations(store, llm, { now: clock })).toEqual({ named: 0, failed: 1 }); // no reply yet: only the older one is due, and it fails
    expect(requests).toHaveLength(1);

    store.append(live, { role: "assistant", text: "Two quizzes are missing." });
    replies = [answer('"Module 6 quizzes."')];
    expect(await nameConversations(store, llm, { now: clock })).toEqual({ named: 1, failed: 0 }); // the failed one waits six hours
    const byId = () => new Map(store.list().conversations.map((c) => [c.id, c]));
    expect(byId().get(live.id)).toMatchObject({ autoTitle: "Module 6 quizzes", autoTitleMessages: 1 });
    expect(byId().get(favorites.id)?.titleFailedAt).toBe(clock.toISOString());
    expect(byId().get(named.id)?.autoTitle).toBeUndefined();
    expect(requests[1]).toMatchObject({ tools: [], effort: "low" });
    expect(requests[1].messages[0].role === "user" && requests[1].messages[0].content).toMatch(/Them: look at the module 6 quizzes\nYou: Two quizzes are missing\./);

    expect(await nameConversations(store, llm, { now: clock })).toEqual({ named: 0, failed: 0 }); // nothing new said

    store.append(live, { role: "user", text: "and the answers?" }, { role: "assistant", text: "Also missing." });
    store.append(live, { role: "user", text: "write them" }, { role: "assistant", text: "Done." });
    replies = [answer("Module 6 quiz answers")];
    expect(await nameConversations(store, llm, { now: clock })).toEqual({ named: 1, failed: 0 });
    expect(byId().get(live.id)).toMatchObject({ autoTitle: "Module 6 quiz answers", autoTitleMessages: 3 });
    store.append(live, { role: "user", text: "thanks" }, { role: "assistant", text: "Anytime." });
    expect(await nameConversations(store, llm, { now: clock })).toEqual({ named: 0, failed: 0 }); // named after three messages: it stays
    expect(await nameConversations(store, null, { now: clock })).toEqual({ named: 0, failed: 0 });
    expect(requests).toHaveLength(3);
  });

  /**
   * What a message costs. Recall used to read and parse every conversation ever saved, three
   * times over (recall, names, summaries), so the price of asking anything grew with everything
   * that had been said before. These are the tests that keep that from coming back.
   */
  describe("what a message reads", () => {
    /** Counts conversation files read, whichever way they are reached. */
    class Counted extends Conversations {
      reads = 0;
      override get(id: string) {
        const c = super.get(id);
        if (c) this.reads++;
        return c;
      }
      override list() {
        const r = super.list();
        this.reads += r.conversations.length + r.unreadable;
        return r;
      }
      override metas() {
        const r = super.metas();
        this.reads += r.read;
        return r;
      }
    }

    const dirs: string[] = [];
    afterEach(async () => {
      await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
    });

    /** A store used for a while: `chats` conversations, all ended, named and summarised. */
    async function settled(chats: number): Promise<string> {
      const d = await mkdtemp(join(tmpdir(), "cos-cost-"));
      dirs.push(d);
      let at = new Date(on("2026-01-01"));
      const s = new Conversations(d, 60, () => at);
      for (let i = 0; i < chats; i++) {
        at = new Date(new Date(on("2026-01-01")).getTime() + i * 86_400_000);
        const c = s.startNew();
        s.append(c, ...pricing());
        const day = todayISO(at);
        s.patch(c.id, (fresh) => {
          fresh.title = `Chat ${i}`;
          fresh.summary = { text: `They talked about pricing on ${day}.`, model: "openai:gpt-test", at: at.toISOString() };
        });
      }
      new Conversations(d, 60, () => clock).metas(); // the index is built once, on the first message
      return d;
    }

    /** What one message costs: the summaries in memory, then naming and summarising in the background. */
    async function costOfAMessage(d: string): Promise<number> {
      const s = new Counted(d, 60, () => clock);
      renderRecall(s, { today: todayISO(clock) });
      await summarizeEnded(s, null, { now: clock });
      await nameConversations(s, null, { now: clock });
      return s.reads;
    }

    it("costs the same whether a dozen conversations were saved before it or a hundred", async () => {
      const few = await settled(12);
      const many = await settled(100);
      expect(await costOfAMessage(many)).toBe(await costOfAMessage(few));

      // For contrast, the old way round: the price was the whole history, every time.
      const everything = new Counted(many, 60, () => clock);
      everything.list();
      expect(everything.reads).toBe(100);
    });

    it("reads only the conversation that changed when something is said", async () => {
      const d = await settled(12);
      // One, whatever the history: the chat in progress, which has to be read to be answered.
      expect(await costOfAMessage(d)).toBe(1);

      const writer = new Conversations(d, 60, () => clock);
      const older = writer.metas().metas[3];
      writer.append(writer.get(older.id)!, { role: "user", text: "one more thing" }, { role: "assistant", text: "Noted." });

      const s = new Counted(d, 60, () => clock);
      renderRecall(s, { today: todayISO(clock) });
      expect(s.reads).toBe(1); // the one that changed, re-indexed; the other eleven untouched
      // Picking it up again dropped its summary, so it is one to write again: that reads it, and the chat in progress.
      expect(await summarizeEnded(s, null, { now: clock })).toEqual({ summarized: 1, failed: 0, waiting: 0 });
      expect(s.reads).toBe(4); // it, the chat in progress, and it again to write the summary on top of what is saved now
    });

    it("searches only the conversations the dates leave in, and reads none at all without keywords", async () => {
      const d = await settled(12);
      const listing = new Counted(d, 60, () => clock);
      expect(searchConversations(listing, { from: "2026-01-01" })).toContain("12 saved conversations");
      expect(listing.reads).toBe(0); // the summaries are in the index

      const dated = new Counted(d, 60, () => clock);
      expect(searchConversations(dated, { query: "launch pro tier", from: "2026-01-02", to: "2026-01-03" })).toMatch(/in 2 conversations/);
      expect(dated.reads).toBe(2);
    });

    it("says the same thing when there is no index to lean on", async () => {
      const d = await settled(12);
      const withIndex = renderRecall(new Conversations(d, 60, () => clock), { today: todayISO(clock) });
      rmSync(join(d, ".index"), { force: true });
      const cold = new Counted(d, 60, () => clock);
      expect(renderRecall(cold, { today: todayISO(clock) })).toBe(withIndex);
      expect(cold.reads).toBe(12); // it builds the index first, this once
    });
  });
});
