/** Pure cadence and silence rules. No I/O, fully tested. */
import { normalizeStatus, type Project } from "../core/ledger.js";
import { WEEKDAYS, daysBetween, weekdayName } from "../util/dates.js";

export type Cadence =
  | { kind: "none" }
  | { kind: "daily" }
  | { kind: "weekly" }
  | { kind: "weekdays"; days: string[] };

const DAY_ALIASES: Record<string, string> = Object.fromEntries(
  WEEKDAYS.flatMap((d) => [
    [d.toLowerCase(), d],
    [d.slice(0, 3).toLowerCase(), d],
    [`${d.toLowerCase()}s`, d],
  ]),
);

export function parseCadence(text: string | undefined): Cadence {
  const s = (text ?? "").trim().toLowerCase();
  if (!s || s === "none") return { kind: "none" };
  if (s === "daily" || s === "every day") return { kind: "daily" };
  if (s === "weekly" || s === "every week") return { kind: "weekly" };
  const days = s
    .replace(/^every\s+/, "")
    .split(/[,/&+]|\s+and\s+|\s+/)
    .map((t) => DAY_ALIASES[t.trim()])
    .filter((d): d is string => Boolean(d));
  return days.length ? { kind: "weekdays", days: [...new Set(days)] } : { kind: "none" };
}

export function daysIdle(project: Project, today: string): number | null {
  return project.lastTouched ? daysBetween(project.lastTouched, today) : null;
}

export function isActive(project: Project): boolean {
  return normalizeStatus(project.status) === "active";
}

/** True when the project's cadence says today is its day and it has not been skipped. */
export function cadenceDueToday(project: Project, today: string): boolean {
  if (!isActive(project)) return false;
  if (project.skipUntil && project.skipUntil > today) return false;
  const cadence = parseCadence(project.cadence);
  const idle = daysIdle(project, today);
  switch (cadence.kind) {
    case "none":
      return false;
    case "daily":
      return project.lastTouched !== today;
    case "weekly":
      return idle === null || idle >= 7;
    case "weekdays":
      return cadence.days.includes(weekdayName(today)) && project.lastTouched !== today;
  }
}

/** Active projects untouched for `silenceDays` or more (or never touched). */
export function isSilent(project: Project, today: string, silenceDays: number): boolean {
  if (!isActive(project)) return false;
  const idle = daysIdle(project, today);
  return idle === null || idle >= silenceDays;
}

/** Parked projects come back once a month to be re-asked. */
export function parkedDueForReview(project: Project, today: string): boolean {
  if (normalizeStatus(project.status) !== "parked") return false;
  const idle = daysIdle(project, today);
  return idle === null || idle >= 30;
}

export function describeCadence(project: Project): string {
  const c = parseCadence(project.cadence);
  switch (c.kind) {
    case "none":
      return "";
    case "daily":
      return "every day";
    case "weekly":
      return "weekly";
    case "weekdays":
      return c.days.length === 1 ? `${c.days[0]}s` : c.days.join(", ");
  }
}
