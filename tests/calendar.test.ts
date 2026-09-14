import { describe, expect, it } from "vitest";
import {
  formatEvent, noneProvider, parseEventKit, parseIcalBuddy, pickProvider, todayEvents,
  type CalendarProvider,
} from "../src/sensors/calendar.js";

describe("calendar parsers", () => {
  it("parses icalBuddy timed, multi-day and all-day lines and ignores other days", () => {
    const out = [
      "2026-09-14 at 10:00 - 10:30 · Standup",
      "2026-09-14 · Company holiday",
      "2026-09-14 at 23:00 - 2026-09-15 at 01:00 · Late call",
      "2026-09-15 at 09:00 - 09:30 · Tomorrow thing",
      "garbage line",
    ].join("\n");
    expect(parseIcalBuddy(out, "2026-09-14")).toEqual([
      { title: "Standup", start: "2026-09-14T10:00:00", end: "2026-09-14T10:30:00", allDay: false },
      { title: "Company holiday", start: "2026-09-14T00:00:00", end: "2026-09-14T23:59:59", allDay: true },
      { title: "Late call", start: "2026-09-14T23:00:00", end: "2026-09-15T01:00:00", allDay: false },
    ]);
  });

  it("parses the EventKit helper's JSON", () => {
    const json = JSON.stringify([
      { title: "Lunch w/ Marwan", start: "2026-09-14T13:00:00-04:00", end: "2026-09-14T14:00:00-04:00", allDay: false, calendar: "Personal", location: "" },
    ]);
    expect(parseEventKit(json)).toEqual([
      { title: "Lunch w/ Marwan", start: "2026-09-14T13:00:00-04:00", end: "2026-09-14T14:00:00-04:00", allDay: false, calendar: "Personal", location: undefined },
    ]);
  });
});

describe("provider selection", () => {
  const unavailable: CalendarProvider = { name: "x", available: async () => false, eventsOn: async () => [] };
  const broken: CalendarProvider = {
    name: "broken",
    available: async () => true,
    eventsOn: async () => { throw new Error("boom"); },
  };

  it("picks the first available provider, or the pinned one", async () => {
    expect((await pickProvider(undefined, [unavailable, noneProvider])).name).toBe("none");
    expect((await pickProvider("none")).name).toBe("none");
    await expect(pickProvider("nope")).rejects.toThrow(/Unknown COS_CALENDAR/);
  });

  it("never throws from todayEvents; a broken provider yields no events plus an error", async () => {
    const r = await todayEvents("2026-09-14", broken);
    expect(r.events).toEqual([]);
    expect(r.error).toBe("boom");
  });

  it("sorts events by start and formats them", async () => {
    const p: CalendarProvider = {
      name: "p", available: async () => true,
      eventsOn: async () => [
        { title: "B", start: "2026-09-14T13:00:00", end: "2026-09-14T14:00:00", allDay: false },
        { title: "A", start: "2026-09-14T10:00:00", end: "2026-09-14T10:30:00", allDay: false },
      ],
    };
    const r = await todayEvents("2026-09-14", p);
    expect(r.events.map((e) => e.title)).toEqual(["A", "B"]);
    expect(formatEvent(r.events[0])).toBe("10:00–10:30  A");
  });
});
