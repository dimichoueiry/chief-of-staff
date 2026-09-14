import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Notes } from "../src/core/notes.js";
import { Reminders, parseReminders } from "../src/core/reminders.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

describe("Reminders", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await makeTmpSelfhub()));
  afterEach(() => cleanup());

  it("parses several separators and done markers", () => {
    const r = parseReminders("- [ ] 2026-09-19 · email advisor\n- [x] 2026-09-12 - renew domain\n* [ ] 2026-10-01: taxes");
    expect(r).toEqual([
      { date: "2026-09-19", text: "email advisor", done: false },
      { date: "2026-09-12", text: "renew domain", done: true },
      { date: "2026-10-01", text: "taxes", done: false },
    ]);
  });

  it("adds sorted, reports due and upcoming, completes by text", async () => {
    const rem = new Reminders(dir);
    await rem.add("2026-09-19", "email the UIUC advisor");
    await rem.add("2026-09-12", "renew the domain");
    await rem.add("2026-09-25", "book flights");
    expect((await rem.list()).map((r) => r.date)).toEqual(["2026-09-12", "2026-09-19", "2026-09-25"]);
    expect((await rem.due("2026-09-14")).map((r) => r.text)).toEqual(["renew the domain"]);
    expect((await rem.upcoming(7, "2026-09-14")).map((r) => r.text)).toEqual(["email the UIUC advisor"]);
    expect((await rem.complete("domain"))?.done).toBe(true);
    expect(await rem.due("2026-09-14")).toEqual([]);
    expect(await readFile(rem.paths.reminders, "utf8")).toContain("- [x] 2026-09-12 · renew the domain");
  });
});

describe("Notes", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await makeTmpSelfhub()));
  afterEach(() => cleanup());

  it("groups notes under date headings and appends to an existing day", async () => {
    const notes = new Notes(dir);
    await notes.add("first thought", "2026-09-13");
    await notes.add("second thought", "2026-09-14");
    await notes.add("third thought", "2026-09-13");
    expect(await readFile(notes.paths.notesInbox, "utf8")).toBe(
      "# Inbox\n\n## 2026-09-13\n- first thought\n- third thought\n\n## 2026-09-14\n- second thought\n",
    );
    expect((await notes.recent(1, "2026-09-14")).map((n) => n.text)).toEqual(["second thought"]);
    expect((await notes.recent(7, "2026-09-14")).map((n) => n.text)).toEqual([
      "first thought", "third thought", "second thought",
    ]);
  });
});
