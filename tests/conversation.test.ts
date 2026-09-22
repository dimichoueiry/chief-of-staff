import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { Conversations, KEEP_DELETED_DAYS, displayTitle, historyMessages, messageCount, visibleTurns, type Conversation } from "../src/brain/conversation.js";

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

  it("switches between saved chats: a picked one carries on until it goes quiet, then the next message starts fresh", () => {
    const s = store();
    const review = s.current();
    s.append(review, { role: "user", text: "review module 6" }, { role: "assistant", text: "Here's the review." });
    clock = new Date("2026-09-14T10:05:00Z");
    const favorites = s.startNew();
    s.append(favorites, { role: "user", text: "open campuswire" }, { role: "assistant", text: "Opened." });

    clock = new Date("2026-09-14T12:00:00Z"); // both quiet for over the hour
    expect(s.open(review.id)?.id).toBe(review.id);
    expect(s.current().id).toBe(review.id); // picking it counts as activity
    s.append(s.current(), { role: "user", text: "and the quiz?" }, { role: "assistant", text: "Add one." });
    expect(store().get(review.id)?.turns.map((t) => t.text)).toEqual(["review module 6", "Here's the review.", "and the quiz?", "Add one."]);
    expect(store().get(favorites.id)?.turns).toHaveLength(2);

    clock = new Date("2026-09-14T12:30:00Z");
    expect(store().current().id).toBe(review.id); // the choice is saved, not held in memory
    clock = new Date("2026-09-14T13:31:00Z");
    const fresh = store().current();
    expect([review.id, favorites.id]).not.toContain(fresh.id);
    store().append(fresh, { role: "user", text: "hi" });
    expect(store().current().id).toBe(fresh.id); // the new one, not the old pick

    expect(store().open("../../etc/passwd")).toBeNull();
    expect(store().open("2026-no-such-chat")).toBeNull();
  });

  it("steps out for an aside and back: the main chat is untouched, the aside is never listed and is thrown away", async () => {
    const s = store();
    const main = s.current();
    s.append(main, { role: "user", text: "plan the launch" }, { role: "assistant", text: "Three steps." });
    clock = new Date("2026-09-14T10:05:00Z");

    const aside = s.startAside();
    expect(aside.id).toMatch(/^aside-/);
    expect(aside).toMatchObject({ asideOf: main.id, turns: [] });
    expect(store().current().id).toBe(aside.id);
    expect(store().startAside().id).toBe(aside.id); // already in one: it carries on
    s.append(s.current(), { role: "user", text: "how tall is the eiffel tower?" }, { role: "assistant", text: "330 m." });
    expect(store().current().turns).toHaveLength(2);
    // Not a chat: never listed, counted or remembered.
    expect(s.list().conversations.map((c) => c.id)).toEqual([main.id]);
    expect(s.count()).toBe(1);
    expect(store().get(main.id)?.turns.map((t) => t.text)).toEqual(["plan the launch", "Three steps."]);

    clock = new Date("2026-09-14T12:00:00Z"); // even after a quiet spell, "back on topic" lands on the main chat
    const back = s.endAside();
    expect(back?.id).toBe(main.id);
    expect(store().current().id).toBe(main.id);
    expect(store().get(aside.id)).toBeNull();
    expect((await readdir(dir)).filter((n) => n.startsWith("aside-"))).toEqual([]);
    expect(s.endAside()).toBeNull(); // nothing to leave
    s.append(s.current(), { role: "user", text: "and step two?" });
    expect(store().get(main.id)?.turns.map((t) => t.text)).toEqual(["plan the launch", "Three steps.", "and step two?"]);
  });

  it("throws an aside away when a new chat starts or another is opened, and comes back to a new chat if the main one was deleted", async () => {
    const s = store();
    const main = s.current();
    s.append(main, { role: "user", text: "hi" }, { role: "assistant", text: "Hello." });
    clock = new Date("2026-09-14T10:01:00Z");
    const aside = s.startAside();
    s.append(aside, { role: "user", text: "quick one" }, { role: "assistant", text: "Sure." });
    const fresh = s.startNew();
    expect(fresh.id).not.toBe(aside.id);
    expect(fresh.asideOf).toBeUndefined();
    expect(store().get(aside.id)).toBeNull();
    expect(s.endAside()).toBeNull();

    clock = new Date("2026-09-14T10:02:00Z");
    const second = s.startAside();
    expect(s.open(main.id)?.id).toBe(main.id);
    expect(store().get(second.id)).toBeNull();

    // After a quiet spell the chat in progress is a fresh one that isn't saved yet: it's saved, so there's somewhere to come back to.
    clock = new Date("2026-09-14T13:00:00Z");
    const third = s.startAside();
    expect(third.asideOf).not.toBe(main.id);
    const unsaved = store().get(third.asideOf!)!;
    expect(unsaved).toMatchObject({ turns: [] });
    expect(unsaved.asideOf).toBeUndefined();
    expect(s.endAside()?.id).toBe(unsaved.id);
    expect(store().current().id).toBe(unsaved.id);

    const fourth = s.startAside();
    expect(s.delete(unsaved.id)).toBe(true);
    const landed = s.endAside();
    expect(landed).not.toBeNull();
    expect(landed!.id).not.toBe(unsaved.id);
    expect(landed!.asideOf).toBeUndefined();
    expect(store().get(fourth.id)).toBeNull();
    expect(store().current().id).toBe(landed!.id);
  });

  it("names chats, and keeps a name given while a reply was still being written", () => {
    const s = store();
    const c = s.current();
    s.append(c, { role: "user", text: "can you please look at my screen and tell me what this error is about, it keeps coming back" });
    expect(displayTitle(store().get(c.id)!)).toBe("can you please look at my screen and tell me what this error…");
    // Named in the background, then renamed, while `c` (read before) is still being answered.
    store().patch(c.id, (x) => {
      x.autoTitle = "Recurring error";
      x.autoTitleMessages = 1;
    });
    s.append(c, { role: "assistant", text: "It's a permissions error." });
    expect(displayTitle(store().get(c.id)!)).toBe("Recurring error");
    store().rename(c.id, "  Permissions   bug ");
    s.append(c, { role: "user", text: "thanks" });
    const saved = store().get(c.id)!;
    expect(displayTitle(saved)).toBe("Permissions bug");
    expect(saved.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(messageCount(saved)).toBe(2);
    store().rename(c.id, "");
    expect(displayTitle(store().get(c.id)!)).toBe("Recurring error");
    clock = new Date("2026-09-14T10:01:00Z");
    expect(displayTitle(store().startNew())).toBe("New chat");
  });

  it("deletes a chat safely: gone from the list at once, set aside, never brought back by a late reply, cleared after 30 days", async () => {
    const s = store();
    const keep = s.current();
    s.append(keep, { role: "user", text: "plan the week" }, { role: "assistant", text: "Here's the plan." });
    clock = new Date("2026-09-14T10:05:00Z");
    const doomed = s.startNew();
    s.append(doomed, { role: "user", text: "my bank password hint" }, { role: "assistant", text: "Noted." });
    expect(s.current().id).toBe(doomed.id);

    expect(s.delete(doomed.id)).toBe(true);
    expect(s.get(doomed.id)).toBeNull();
    expect(s.list().conversations.map((c) => c.id)).toEqual([keep.id]);
    expect(s.count()).toBe(1);
    expect(s.isDeleted(doomed.id)).toBe(true);
    expect(existsSync(join(dir, "deleted", `${doomed.id}.json`))).toBe(true); // set aside, not erased
    expect(s.current().id).toBe(keep.id); // the picked chat is gone, so the last active one carries on

    // A reply that was still being written, a rename or a summary landing afterwards doesn't bring it back.
    s.append(doomed, { role: "assistant", text: "late reply" });
    s.update(doomed);
    expect(s.rename(doomed.id, "x")).toBeNull();
    expect(s.get(doomed.id)).toBeNull();
    expect((await readdir(dir)).filter((n) => n.endsWith(".json"))).toEqual([`${keep.id}.json`]);

    expect(s.delete(doomed.id)).toBe(false); // already deleted
    expect(s.delete("../conversations/x")).toBe(false);
    expect(s.delete("no-such-chat")).toBe(false);

    // Deleting something else a month later clears out what was deleted before.
    clock = new Date(clock.getTime() + (KEEP_DELETED_DAYS + 1) * 86_400_000);
    const another = s.startNew();
    s.append(another, { role: "user", text: "hello" });
    expect(s.delete(another.id)).toBe(true);
    expect(s.isDeleted(doomed.id)).toBe(false);
    expect(s.isDeleted(another.id)).toBe(true);
  });

  it("forgets the old summary when an ended chat is picked up again", () => {
    const s = store();
    const c = s.current();
    s.append(c, { role: "user", text: "hi" });
    s.patch(c.id, (x) => (x.summary = { text: "They said hi.", model: "rules", at: "" }));
    clock = new Date("2026-09-15T10:00:00Z");
    s.open(c.id);
    s.append(s.current(), { role: "user", text: "back again" });
    expect(store().get(c.id)?.summary).toBeUndefined();
    expect(store().get(c.id)?.turns).toHaveLength(2);
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

  it("still has the post it was given after several turns of clicking through LinkedIn", () => {
    // What happened on 2026-09-22: the post was dictated first, then each browser turn carried whole
    // pages back into history and pushed the post out, so it asked for it again.
    const page = `Page: Feed | LinkedIn\nAddress: https://www.linkedin.com/feed/\n${"- button \"Like\" [ref=e1]\n".repeat(400)}`;
    const turns: Conversation["turns"] = [
      { role: "user", text: "Here is my post: For the past few months I have been thinking about my personal AI setup.", at },
      { role: "assistant", text: "Got it. Want me to put it on LinkedIn?", at },
    ];
    for (let i = 0; i < 6; i++) {
      turns.push(
        { role: "event", text: `They said yes and it is already done: click Next. Result: ${page}`, at },
        { role: "user", text: `click next ${i}`, at },
        {
          role: "assistant", text: "Clicked it.", at,
          steps: [
            { role: "assistant", text: "", toolCalls: [{ id: `t${i}`, name: "browser_do", input: { goal: "click next" } }] },
            { role: "tool", results: [{ id: `t${i}`, content: `Did this, in order: clicked button "Next".\n${page}` }] },
          ],
        },
      );
    }
    const h = historyMessages(convo(turns));
    const said = h.filter((m) => m.role === "user").map((m) => (m.role === "user" ? m.content : ""));
    expect(said[0]).toMatch(/personal AI setup/);
    expect(said).toHaveLength(7);
    // What it did survives; the stale page is reduced to its title.
    const results = h.flatMap((m) => (m.role === "tool" ? m.results.map((r) => r.content) : []));
    expect(results.at(-1)).toBe('Did this, in order: clicked button "Next".\nPage: Feed | LinkedIn (as it was then; read it again to see it now)');
    expect(said[1]).not.toMatch(/ref=e1/);
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
