import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildContext, readIdentity, renderContext } from "../src/core/context.js";
import { noneProvider } from "../src/sensors/calendar.js";

const config = loadConfig({ COS_SELFHUB: resolve("examples/selfhub-sample"), COS_NAME: "Dimitri" });

describe("buildContext on the sample selfhub", () => {
  it("assembles identity, ledger, journal, reminders and computed flags", async () => {
    const ctx = await buildContext({ config, intent: "brief", today: "2026-09-17", calendarProvider: noneProvider });
    expect(ctx.weekday).toBe("Thursday");
    expect(ctx.identity).toContain("### meta/profile.md");
    expect(ctx.identity).not.toContain("projects.md");
    expect(ctx.projects.map((p) => p.name)).toContain("MLGuerrilla");
    expect(ctx.journal.map((j) => j.date)).toEqual(["2026-09-12", "2026-09-13"]);
    expect(ctx.remindersUpcoming.map((r) => r.text)).toEqual(["email the UIUC advisor about the spring course"]);
    expect(ctx.flags.cadenceDue).toEqual(["MLGuerrilla"]);
    expect(ctx.flags.silent.sort()).toEqual(["MLGuerrilla", "nuonc_rag"]);
    expect(ctx.flags.parkedReview).toEqual([]);
    expect(ctx.calendarProvider).toBe("none");
  });

  it("renders a prompt block with flags, omitting done projects and keeping parked ones", async () => {
    const ctx = await buildContext({ config, intent: "focus", project: "drawcal", today: "2026-09-17", calendarProvider: noneProvider });
    const text = renderContext(ctx);
    expect(text).toContain("Thursday, September 17");
    expect(text).toContain("The user's name is Dimitri");
    expect(text).toContain("## MLGuerrilla — active");
    expect(text).toContain("cadence: Thursdays  ← DUE TODAY");
    expect(text).toContain("(15 days idle)  ← SILENT");
    expect(text).toContain("## Fampy Nails academy — parked");
    expect(text).toContain("# Focus project\ndrawcal");
    expect(text).toContain("No events. The day is free.");
    expect(text).toContain("# Calendar, coming days (2026-09-18 to 2026-09-23)");
    expect(text).toContain("use the get_calendar tool");
    expect(text).toContain("# 2026-09-13");
  });
});

/**
 * Identity is in the prompt on every single message, so it has a budget. What matters is that the
 * short files that say who someone is are always in it, that asking about something reaches the
 * file it is about, and that whatever is left out is named rather than quietly missing.
 */
describe("how much of selfhub goes into a prompt", () => {
  let dir: string;
  const named = (text: string) => (text.match(/^### (.+)$/gm) ?? []).map((l) => l.slice(4));
  /** The three short files are about 60 characters each; the working documents are 2k and 5k. */
  const SHORT = ["meta/profile.md", "preferences/coding-workflow.md", "voice/writing-style.md"];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-identity-"));
    for (const sub of ["meta", "preferences", "voice", "bigproject"]) await mkdir(join(dir, sub), { recursive: true });
    await writeFile(join(dir, "meta/profile.md"), "Dimitri, building MLGuerrilla.");
    await writeFile(join(dir, "preferences/coding-workflow.md"), "Small commits. Tests first.");
    await writeFile(join(dir, "voice/writing-style.md"), "Short sentences. No hedging.");
    // Working documents kept inside selfhub: the things that used to crowd out everything else.
    await writeFile(join(dir, "bigproject/content-authoring.md"), `How the bigproject lessons are authored. ${"detail ".repeat(700)}`);
    await writeFile(join(dir, "bigproject/notes.md"), `Bigproject notes. ${"note ".repeat(400)}`);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("keeps the short files that say who you are, and names the long ones it left out", async () => {
    const text = await readIdentity(dir, { maxChars: 1_000 });
    expect(named(text)).toEqual([...SHORT, "not loaded"]); // path order, then what missed it
    expect(text).toContain("No hedging.");
    expect(text).toContain("bigproject/content-authoring.md (5k)");
    expect(text).toContain("bigproject/notes.md (2k)");
    expect(text).toContain("Say so rather than guessing");
  });

  it("never cuts a file in half: it is either all there or named as one you aren't looking at", async () => {
    const text = await readIdentity(dir, { maxChars: 1_000 });
    expect(text).toContain("### preferences/coding-workflow.md\nSmall commits. Tests first.");
    expect(text).not.toContain("detail detail"); // not a word of the long one, rather than the start of it
    expect(text).not.toMatch(/…|\(cut\)/);
  });

  it("loads the file a question is about, without giving up the short ones for it", async () => {
    const asked = await readIdentity(dir, { query: "how do I author bigproject content?", maxChars: 6_000 });
    expect(named(asked)).toContain("bigproject/content-authoring.md"); // 5k, over the 3k allowance, and still reached
    for (const f of SHORT) expect(named(asked)).toContain(f);
    expect(asked).not.toContain("### not loaded"); // with that one in, everything fits
  });

  it("gives the same answer to the same question, and asks for nothing when nothing was asked", async () => {
    const a = await readIdentity(dir, { maxChars: 1_000 });
    expect(await readIdentity(dir, { maxChars: 1_000 })).toBe(a);
    expect(named(a)).not.toContain("bigproject/content-authoring.md");
    // A question about something else leaves the same memory: nothing in selfhub is about the calendar.
    expect(await readIdentity(dir, { query: "what is on my calendar today?", maxChars: 1_000 })).toBe(a);
  });

  it("stays bounded even when the question is about the longest files there are", async () => {
    const asked = await readIdentity(dir, { query: "bigproject content authoring notes", maxChars: 6_000 });
    expect(asked.length).toBeLessThan(2 * 6_000 + 500); // never more than the budget over again
    // And a file bigger than the whole budget is never pulled in by a question, however well it matches.
    const tight = await readIdentity(dir, { query: "bigproject content authoring", maxChars: 1_000 });
    expect(named(tight)).not.toContain("bigproject/content-authoring.md");
  });

  it("says everything when everything fits, and never nothing when nothing does", async () => {
    expect(await readIdentity(dir, { maxChars: 1_000_000 })).not.toContain("### not loaded");
    const tiny = await readIdentity(dir, { maxChars: 1 });
    expect(named(tiny)).toEqual(["meta/profile.md", "not loaded"]); // the shortest one, rather than an empty memory
  });
});
