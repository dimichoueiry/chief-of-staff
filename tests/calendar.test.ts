import { describe, expect, it } from "vitest";
import {
  eventDays, eventsInRange, formatAgenda, formatEvent, noneProvider, parseEventKit, parseIcalBuddy, pickProvider, todayEvents,
  type CalendarEvent, type CalendarProvider,
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
  const unavailable: CalendarProvider = { name: "x", available: async () => false, eventsBetween: async () => [] };
  const broken: CalendarProvider = {
    name: "broken",
    available: async () => true,
    eventsBetween: async () => { throw new Error("boom"); },
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
      eventsBetween: async () => [
        { title: "B", start: "2026-09-14T13:00:00", end: "2026-09-14T14:00:00", allDay: false },
        { title: "A", start: "2026-09-14T10:00:00", end: "2026-09-14T10:30:00", allDay: false },
      ],
    };
    const r = await todayEvents("2026-09-14", p);
    expect(r.events.map((e) => e.title)).toEqual(["A", "B"]);
    expect(formatEvent(r.events[0])).toBe("10:00–10:30  A");
  });
});

describe("date ranges", () => {
  const ev = (title: string, start: string, end: string, allDay = false): CalendarEvent => ({ title, start, end, allDay });

  it("keeps icalBuddy lines inside the range", () => {
    const out = ["2026-09-14 at 10:00 - 10:30 · Mon thing", "2026-09-17 · Thu holiday", "2026-09-22 at 09:00 - 09:30 · Too late"].join("\n");
    expect(parseIcalBuddy(out, "2026-09-14", "2026-09-20").map((e) => e.title)).toEqual(["Mon thing", "Thu holiday"]);
  });

  it("passes the range to the provider and validates it", async () => {
    const seen: string[] = [];
    const p: CalendarProvider = { name: "p", available: async () => true, eventsBetween: async (f, t) => (seen.push(`${f}..${t}`), []) };
    await eventsInRange("2026-09-14", "2026-09-20", p);
    expect(seen).toEqual(["2026-09-14..2026-09-20"]);
    expect((await eventsInRange("2026-09-20", "2026-09-14", p)).error).toMatch(/before/);
    expect((await eventsInRange("2026-01-01", "2027-06-01", p)).error).toMatch(/366/);
    expect((await eventsInRange("next week", "2026-09-14", p)).error).toMatch(/YYYY-MM-DD/);
    await todayEvents("2026-09-14", p);
    expect(seen.at(-1)).toBe("2026-09-14..2026-09-14");
  });

  it("puts multi-day and all-day events on every day they touch, clipped to the range", () => {
    const trip = ev("Trip", "2026-09-16T00:00:00", "2026-09-19T00:00:00", true);
    // Ends are exclusive: an all-day event that ends at midnight on the 19th covers the 16th to the 18th.
    expect(eventDays(trip, "2026-09-17", "2026-09-30")).toEqual(["2026-09-17", "2026-09-18"]);
    expect(eventDays(trip, "2026-09-10", "2026-09-16")).toEqual(["2026-09-16"]);
    expect(eventDays(trip, "2026-09-19", "2026-09-30")).toEqual([]);
    const call = ev("Call", "2026-09-17T15:00:00-04:00", "2026-09-17T15:30:00-04:00");
    expect(eventDays(call, "2026-09-14", "2026-09-20")).toEqual(["2026-09-17"]);
    expect(eventDays(call, "2026-09-18", "2026-09-20")).toEqual([]);
  });

  it("formats an agenda grouped by day", () => {
    const text = formatAgenda(
      [ev("Dentist", "2026-09-18T10:00:00", "2026-09-18T11:00:00"), ev("Standup", "2026-09-17T09:00:00", "2026-09-17T09:15:00")].sort((a, b) => a.start.localeCompare(b.start)),
      "2026-09-17",
      "2026-09-20",
    );
    expect(text).toBe("Thu, Sep 17 (2026-09-17)\n- 09:00–09:15  Standup\nFri, Sep 18 (2026-09-18)\n- 10:00–11:00  Dentist");
    expect(formatAgenda([], "2026-09-17", "2026-09-20")).toBe("No events.");
  });
});
