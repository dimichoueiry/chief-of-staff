import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildContext, renderContext } from "../src/core/context.js";
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
    expect(text).toContain("# 2026-09-13");
  });
});
