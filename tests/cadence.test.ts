import { describe, expect, it } from "vitest";
import type { Project } from "../src/core/ledger.js";
import {
  cadenceDueToday, describeCadence, isSilent, parkedDueForReview, parseCadence,
} from "../src/logic/cadence.js";

const p = (o: Partial<Project>): Project => ({ name: "X", status: "active", extra: [], ...o });
const THU = "2026-09-17";
const FRI = "2026-09-18";

describe("parseCadence", () => {
  it("understands weekday names, plurals, lists, daily, weekly, none", () => {
    expect(parseCadence("Thursday")).toEqual({ kind: "weekdays", days: ["Thursday"] });
    expect(parseCadence("thursdays")).toEqual({ kind: "weekdays", days: ["Thursday"] });
    expect(parseCadence("Mon, Wed and fri")).toEqual({ kind: "weekdays", days: ["Monday", "Wednesday", "Friday"] });
    expect(parseCadence("every tuesday")).toEqual({ kind: "weekdays", days: ["Tuesday"] });
    expect(parseCadence("daily")).toEqual({ kind: "daily" });
    expect(parseCadence("weekly")).toEqual({ kind: "weekly" });
    expect(parseCadence(undefined)).toEqual({ kind: "none" });
    expect(parseCadence("whenever")).toEqual({ kind: "none" });
  });
});

describe("cadenceDueToday", () => {
  it("fires on the named weekday only, and not if already touched today", () => {
    expect(cadenceDueToday(p({ cadence: "Thursday", lastTouched: "2026-09-02" }), THU)).toBe(true);
    expect(cadenceDueToday(p({ cadence: "Thursday", lastTouched: "2026-09-02" }), FRI)).toBe(false);
    expect(cadenceDueToday(p({ cadence: "Thursday", lastTouched: THU }), THU)).toBe(false);
  });
  it("honours skipUntil and ignores non-active projects", () => {
    expect(cadenceDueToday(p({ cadence: "Thursday", skipUntil: "2026-09-20" }), THU)).toBe(false);
    expect(cadenceDueToday(p({ cadence: "Thursday", skipUntil: "2026-09-17" }), THU)).toBe(true);
    expect(cadenceDueToday(p({ cadence: "Thursday", status: "parked" }), THU)).toBe(false);
  });
  it("weekly means seven days since last touch; daily means not today", () => {
    expect(cadenceDueToday(p({ cadence: "weekly", lastTouched: "2026-09-11" }), THU)).toBe(false);
    expect(cadenceDueToday(p({ cadence: "weekly", lastTouched: "2026-09-10" }), THU)).toBe(true);
    expect(cadenceDueToday(p({ cadence: "weekly" }), THU)).toBe(true);
    expect(cadenceDueToday(p({ cadence: "daily", lastTouched: THU }), THU)).toBe(false);
    expect(cadenceDueToday(p({ cadence: "daily", lastTouched: "2026-09-16" }), THU)).toBe(true);
  });
});

describe("silence and parked review", () => {
  it("flags active projects idle for the threshold or never touched", () => {
    expect(isSilent(p({ lastTouched: "2026-09-02" }), "2026-09-16", 14)).toBe(true);
    expect(isSilent(p({ lastTouched: "2026-09-03" }), "2026-09-16", 14)).toBe(false);
    expect(isSilent(p({}), "2026-09-16", 14)).toBe(true);
    expect(isSilent(p({ status: "done" }), "2026-09-16", 14)).toBe(false);
  });
  it("parked projects come back after thirty days", () => {
    expect(parkedDueForReview(p({ status: "parked", lastTouched: "2026-08-01" }), "2026-09-16")).toBe(true);
    expect(parkedDueForReview(p({ status: "parked", lastTouched: "2026-09-01" }), "2026-09-16")).toBe(false);
    expect(parkedDueForReview(p({ status: "active", lastTouched: "2026-08-01" }), "2026-09-16")).toBe(false);
  });
  it("describes cadence for humans", () => {
    expect(describeCadence(p({ cadence: "thursday" }))).toBe("Thursdays");
    expect(describeCadence(p({ cadence: "mon, wed" }))).toBe("Monday, Wednesday");
    expect(describeCadence(p({}))).toBe("");
  });
});
