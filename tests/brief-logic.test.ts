import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildContext } from "../src/core/context.js";
import { buildBrief, buildDecisions, buildNudges, greetingFor, rankFocus } from "../src/logic/brief.js";
import { noneProvider, type CalendarProvider } from "../src/sensors/calendar.js";

const config = loadConfig({ COS_SELFHUB: resolve("examples/selfhub-sample"), COS_NAME: "Dimitri" });
const THU = "2026-09-17";
const withEvents: CalendarProvider = {
  name: "fixture",
  available: async () => true,
  eventsBetween: async () => [
    { title: "Standup", start: `${THU}T10:00:00`, end: `${THU}T10:30:00`, allDay: false },
    { title: "Lunch w/ Marwan", start: `${THU}T13:00:00`, end: `${THU}T14:00:00`, allDay: false },
    { title: "Dentist", start: "2026-09-18T09:30:00", end: "2026-09-18T10:30:00", allDay: false },
    { title: "Conference", start: "2026-09-21T00:00:00", end: "2026-09-22T00:00:00", allDay: true },
  ],
};

describe("rule-based brief", () => {
  it("ranks cadence-due first, then near deadlines, then silence; only active projects with a next action", async () => {
    const ctx = await buildContext({ config, intent: "brief", today: THU, calendarProvider: noneProvider });
    const focus = rankFocus(ctx);
    expect(focus.map((f) => f.project)).toEqual(["MLGuerrilla", "Autodesk design review", "nuonc_rag"]);
    expect(focus[0].why).toBe("you said Thursdays · idle 15 days");
    expect(focus[0].title).toBe("Record the intro video for lesson 3");
    expect(focus[1].why).toBe("due tomorrow");
    expect(focus.map((f) => f.project)).not.toContain("Fampy Nails academy");
  });

  it("does not ask keep/park/kill about a project whose cadence fires today", async () => {
    const ctx = await buildContext({ config, intent: "brief", today: THU, calendarProvider: noneProvider });
    expect(buildDecisions(ctx).map((d) => d.project)).toEqual(["nuonc_rag"]);
    expect(buildDecisions(ctx)[0].options).toEqual(["keep", "park", "kill"]);
  });

  it("writes a nudge in the chief-of-staff voice", async () => {
    const ctx = await buildContext({ config, intent: "brief", today: THU, calendarProvider: noneProvider });
    expect(buildNudges(ctx)).toEqual([
      "It's Thursday. You said Thursdays are for MLGuerrilla. Idle 15 days. Next: Record the intro video for lesson 3.",
    ]);
  });

  it("places focus into real free blocks and mirrors them in the schedule", async () => {
    const ctx = await buildContext({ config, intent: "brief", today: THU, calendarProvider: withEvents });
    const brief = buildBrief(ctx, new Date(2026, 8, 17, 7, 2));
    expect(brief.greeting).toBe("Good morning, Dimitri");
    expect(brief.headline).toBe("Thursday, September 17 · 3 things today · 2 events · 1 decision");
    // Half a day (180 min) does not fit the 150-minute late-morning gap, so it takes the afternoon.
    expect(brief.focus[0].when).toBe("14:00–17:00");
    expect(brief.focus[1].when).toBe("09:00–10:00");
    expect(brief.focus[2].when).toBe("10:30–11:30");
    const planned = brief.schedule.filter((s) => s.plan);
    expect(planned.map((s) => `${s.start}–${s.end} ${s.plan}`)).toEqual([
      "09:00–10:00 Reply with the three concerns and a proposed API shape",
      "10:30–11:30 Evaluate the reranker",
      "14:00–17:00 Record the intro video for lesson 3",
    ]);
    // Leftover gaps stay visible as free.
    expect(brief.schedule.filter((s) => s.free && !s.plan).map((s) => `${s.start}–${s.end}`)).toEqual(["11:30–13:00", "17:00–18:00"]);
    // Other days never leak into today's schedule; they show up as coming up.
    expect(brief.schedule.map((s) => s.title)).not.toContain("Dentist");
    expect(brief.upcoming).toEqual([
      { date: "2026-09-18", time: "09:30", title: "Dentist" },
      { date: "2026-09-21", time: "all day", title: "Conference" },
    ]);
    expect(brief.reminders).toEqual([
      { date: "2026-09-19", text: "email the UIUC advisor about the spring course", overdue: false },
    ]);
  });

  it("greets by time of day", () => {
    expect(greetingFor("Dimitri", new Date(2026, 8, 17, 7))).toBe("Good morning, Dimitri");
    expect(greetingFor("", new Date(2026, 8, 17, 15))).toBe("Good afternoon");
    expect(greetingFor("D", new Date(2026, 8, 17, 21))).toBe("Good evening, D");
  });
});
