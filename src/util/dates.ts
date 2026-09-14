/** Date helpers. All dates in memory are local-time YYYY-MM-DD strings. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isISODate(s: string | undefined): s is string {
  return !!s && ISO_DATE.test(s) && !Number.isNaN(Date.parse(s));
}

/** Parse YYYY-MM-DD as a local-time Date at midnight. */
export function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso: string, n: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return todayISO(d);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  const ms = parseISO(b).getTime() - parseISO(a).getTime();
  return Math.round(ms / 86_400_000);
}

export const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

export function weekdayName(iso: string): (typeof WEEKDAYS)[number] {
  return WEEKDAYS[parseISO(iso).getDay()];
}

export function longDate(iso: string): string {
  return parseISO(iso).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}
