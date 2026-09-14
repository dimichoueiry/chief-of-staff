import { describe, expect, it } from "vitest";
import type { FocusItem } from "../src/brain/schema.js";
import { buildSchedule, freeBlocks, planDay, sizeMinutes } from "../src/logic/dayplan.js";
import type { CalendarEvent } from "../src/sensors/calendar.js";

const ev = (title: string, start: string, end: string, allDay = false): CalendarEvent => ({
  title,
  start: `2026-09-17T${start}:00`,
  end: `2026-09-17T${end}:00`,
  allDay,
});
const item = (title: string, size: string): FocusItem => ({ title, project: "", why: "", size, when: "" });

describe("freeBlocks", () => {
  it("finds gaps inside the working day, ignores all-day events and short gaps", () => {
    const events = [
      ev("Standup", "10:00", "10:30"),
      ev("Lunch", "13:00", "14:00"),
      ev("Holiday", "00:00", "23:59", true),
      ev("Quick", "14:00", "14:15"),
    ];
    expect(freeBlocks(events)).toEqual([
      { start: "09:00", end: "10:00" },
      { start: "10:30", end: "13:00" },
      { start: "14:15", end: "18:00" },
    ]);
  });
  it("is the whole day when there are no events", () => {
    expect(freeBlocks([])).toEqual([{ start: "09:00", end: "18:00" }]);
  });
  it("handles events that run past the day end", () => {
    expect(freeBlocks([ev("Late", "17:00", "20:00")])).toEqual([{ start: "09:00", end: "17:00" }]);
  });
});

describe("sizeMinutes", () => {
  it("maps labels to minutes", () => {
    expect(sizeMinutes("30 min")).toBe(30);
    expect(sizeMinutes("1 hour")).toBe(60);
    expect(sizeMinutes("2h")).toBe(120);
    expect(sizeMinutes("half day")).toBe(180);
    expect(sizeMinutes("multi-day")).toBe(240);
    expect(sizeMinutes("whatever")).toBe(60);
  });
});

describe("planDay", () => {
  it("slices a long free block by item size and keeps the remainder for the next item", () => {
    const placements = planDay(
      [item("A", "half day"), item("B", "1 hour"), item("C", "30 min")],
      [{ start: "09:00", end: "18:00" }],
    );
    expect(placements.map((p) => [p.item.title, p.block.start, p.block.end])).toEqual([
      ["A", "09:00", "12:00"],
      ["B", "12:00", "13:00"],
      ["C", "13:00", "13:30"],
    ]);
  });
  it("uses the first block that fits, then falls back to the largest block of at least an hour", () => {
    const free = [
      { start: "09:00", end: "09:45" },
      { start: "14:00", end: "16:00" },
    ];
    const placements = planDay([item("Big", "multi-day"), item("Small", "30 min")], free);
    expect(placements.map((p) => [p.item.title, p.block.start, p.block.end])).toEqual([
      ["Big", "14:00", "16:00"],
      ["Small", "09:00", "09:30"],
    ]);
  });
  it("skips items when nothing usable is free", () => {
    expect(planDay([item("A", "1 hour")], [{ start: "09:00", end: "09:30" }])).toEqual([]);
  });
});

describe("buildSchedule", () => {
  it("interleaves events, planned slices and leftover gaps in time order", () => {
    const events = [ev("Standup", "10:00", "10:30"), ev("Lunch", "13:00", "14:00")];
    const placements = planDay([item("Write", "1 hour")], freeBlocks(events));
    const schedule = buildSchedule(events, placements);
    expect(
      schedule.map((s) => `${s.start}-${s.end} ${s.free ? "free" : s.title}${s.plan ? " → " + s.plan : ""}`),
    ).toEqual([
      "09:00-10:00 free → Write",
      "10:00-10:30 Standup",
      "10:30-13:00 free",
      "13:00-14:00 Lunch",
      "14:00-18:00 free",
    ]);
  });
});
