import { describe, expect, it } from "vitest";
import { addDays, daysBetween, isISODate, todayISO, weekdayName } from "../src/util/dates.js";

describe("dates", () => {
  it("formats local dates and does arithmetic across month ends", () => {
    expect(todayISO(new Date(2026, 8, 14))).toBe("2026-09-14");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-09-02", "2026-09-14")).toBe(12);
    expect(weekdayName("2026-09-17")).toBe("Thursday");
    expect(isISODate("2026-09-14")).toBe(true);
    expect(isISODate("14/09/2026")).toBe(false);
  });
});
