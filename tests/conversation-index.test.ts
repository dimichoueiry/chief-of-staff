import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { Conversations, conversationMeta, type Conversation } from "../src/brain/conversation.js";

/**
 * The index behind metas(). What matters is that it says exactly what reading every file would
 * say, and that a message stops costing a read of everything ever said.
 */
describe("the conversation index", () => {
  let dir: string;
  let clock: Date;
  const store = () => new Conversations(dir, 60, () => clock);

  /** A saved conversation with enough said in it that re-reading one is measurable. */
  function saved(s: Conversations, said: string, replies = 3): Conversation {
    const c = s.startNew();
    for (let i = 0; i < replies; i++) {
      s.append(c, { role: "user", text: `${said} ${i}` }, { role: "assistant", text: "x".repeat(2_000), model: "openai:gpt-test" });
    }
    return c;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-index-"));
    clock = new Date("2026-09-14T10:00:00Z");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("says exactly what reading every conversation says", () => {
    const s = store();
    for (let i = 0; i < 5; i++) {
      clock = new Date(`2026-09-1${i}T10:00:00Z`);
      saved(s, `chat ${i}`);
    }
    const fromFiles = s.list().conversations.map(conversationMeta);
    expect(new Conversations(dir).metas().metas).toEqual(fromFiles);
  });

  it("reads each conversation once, then nothing until one of them changes", () => {
    const s = store();
    for (let i = 0; i < 6; i++) {
      clock = new Date(`2026-09-1${i}T10:00:00Z`);
      saved(s, `chat ${i}`);
    }

    // Cold: the index is built from the files, once.
    expect(new Conversations(dir).metas().read).toBe(6);
    expect(existsSync(join(dir, ".index"))).toBe(true);

    // Warm, and warm again in a fresh process: a message costs no reading at all.
    expect(new Conversations(dir).metas().read).toBe(0);
    const reused = new Conversations(dir);
    expect(reused.metas().read).toBe(0);
    expect(reused.metas().read).toBe(0); // recall, names and summaries, all in one reply

    // One more message in a chat that was already there: only that one is read again.
    clock = new Date("2026-09-16T10:00:00Z");
    const after = new Conversations(dir, 60, () => clock);
    const picked = after.open(after.metas().metas[0].id)!;
    after.append(picked, { role: "user", text: "and tomorrow?" }, { role: "assistant", text: "Nothing booked." });
    const fresh = new Conversations(dir);
    const one = fresh.metas();
    expect(one.read).toBe(1);
    expect(one.metas.find((m) => m.id === picked.id)?.messages).toBe(4);
    expect(fresh.metas().read).toBe(0);
  });

  it("rebuilds itself when the index is missing, damaged or written by an older build", async () => {
    const s = store();
    saved(s, "pricing");
    clock = new Date("2026-09-15T10:00:00Z");
    saved(s, "tauri");
    const expected = new Conversations(dir).metas().metas;

    for (const broken of ["", "{ not json", JSON.stringify({ v: 0, entries: {} }), JSON.stringify({ v: 1 })]) {
      await writeFile(join(dir, ".index"), broken);
      const rebuilt = new Conversations(dir).metas();
      expect(rebuilt.metas).toEqual(expected);
      expect(rebuilt.read).toBe(2);
    }

    await rm(join(dir, ".index"));
    expect(new Conversations(dir).metas().metas).toEqual(expected);
  });

  it("re-reads a conversation another process changed behind its back", async () => {
    const s = store();
    const c = saved(s, "pricing");
    expect(new Conversations(dir).metas().read).toBe(1);

    const file = join(dir, `${c.id}.json`);
    const edited = JSON.parse(await readFile(file, "utf8")) as Conversation;
    edited.title = "Named somewhere else";
    await writeFile(file, JSON.stringify(edited, null, 2));

    const after = new Conversations(dir).metas();
    expect(after.read).toBe(1);
    expect(after.metas[0].title).toBe("Named somewhere else");
    expect(after.metas[0].name).toBe("Named somewhere else");
  });

  it("counts damaged files instead of failing, and never lists the index itself", async () => {
    const s = store();
    saved(s, "pricing");
    await writeFile(join(dir, "0000-broken.json"), "{");
    const r = new Conversations(dir).metas();
    expect(r.unreadable).toBe(1);
    expect(r.metas).toHaveLength(1);
    expect(r.metas.map((m) => m.id)).not.toContain(".index");
    expect(r.read).toBe(2); // trying to read the damaged one still cost a read
    const warm = new Conversations(dir).metas(); // and the same answer, without touching either file
    expect(warm.metas).toEqual(r.metas);
    expect(warm.unreadable).toBe(1);
    expect(warm.read).toBe(0);
  });

  it("drops a deleted chat from the index at once", () => {
    const s = store();
    const c = saved(s, "pricing");
    clock = new Date("2026-09-15T10:00:00Z");
    saved(s, "tauri");
    expect(new Conversations(dir).metas().metas).toHaveLength(2);

    s.delete(c.id);
    const after = new Conversations(dir).metas();
    expect(after.metas).toHaveLength(1);
    expect(after.metas.map((m) => m.id)).not.toContain(c.id);
    expect(after.read).toBe(0); // the one that is left was already known
  });

  it("still answers when the index cannot be written", async () => {
    const s = store();
    saved(s, "pricing");
    const expected = new Conversations(dir).metas().metas;
    // A directory where the file should be: writing it fails, reading it fails, nothing else does.
    await rm(join(dir, ".index"));
    await writeFile(join(dir, ".index.tmp"), "");
    const { mkdirSync } = await import("node:fs");
    await rm(join(dir, ".index.tmp"));
    mkdirSync(join(dir, ".index"));
    const r = new Conversations(dir).metas();
    expect(r.metas).toEqual(expected);
    expect(r.read).toBe(1); // no index to lean on, so it reads, every time
  });
});
