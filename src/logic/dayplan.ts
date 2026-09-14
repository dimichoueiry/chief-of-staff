/** Build the plan; borrow the grid. Free blocks come from the read-only calendar. */
import type { FocusItem, ScheduleItem } from "../brain/schema.js";
import { hhmm, type CalendarEvent } from "../sensors/calendar.js";

export interface Block {
  start: string; // HH:MM
  end: string; // HH:MM
}

export interface DayPlanOptions {
  dayStart: string;
  dayEnd: string;
  minMinutes: number;
}

export const DEFAULT_DAY: DayPlanOptions = { dayStart: "09:00", dayEnd: "18:00", minMinutes: 30 };

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function fromMinutes(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/** Gaps between timed events inside the working day, at least `minMinutes` long. */
export function freeBlocks(events: CalendarEvent[], opts: DayPlanOptions = DEFAULT_DAY): Block[] {
  const busy = events
    .filter((e) => !e.allDay)
    .map((e) => ({ start: toMinutes(hhmm(e.start)), end: toMinutes(hhmm(e.end)) }))
    .sort((a, b) => a.start - b.start);
  const blocks: Block[] = [];
  let cursor = toMinutes(opts.dayStart);
  const dayEnd = toMinutes(opts.dayEnd);
  for (const b of busy) {
    if (b.start > cursor && b.start - cursor >= opts.minMinutes) {
      blocks.push({ start: fromMinutes(cursor), end: fromMinutes(Math.min(b.start, dayEnd)) });
    }
    cursor = Math.max(cursor, b.end);
    if (cursor >= dayEnd) break;
  }
  if (dayEnd - cursor >= opts.minMinutes) blocks.push({ start: fromMinutes(cursor), end: fromMinutes(dayEnd) });
  return blocks;
}

/** Rough minutes for a size label. Unknown labels count as an hour. */
export function sizeMinutes(size: string): number {
  const s = size.toLowerCase();
  if (/multi|day\b|days/.test(s) && !/half/.test(s)) return 240;
  if (/half/.test(s)) return 180;
  const h = /(\d+(?:\.\d+)?)\s*h/.exec(s);
  if (h) return Math.round(Number(h[1]) * 60);
  const m = /(\d+)\s*m/.exec(s);
  if (m) return Number(m[1]);
  return 60;
}

export interface Placement {
  item: FocusItem;
  block: Block;
}

/**
 * Put focus items into free blocks. Items in priority order; each takes the
 * first block that fits, and only the slice it needs: the remainder of the
 * block stays free for the next item. Multi-day work gets at most four hours.
 */
export function planDay(focus: FocusItem[], free: Block[], minMinutes = DEFAULT_DAY.minMinutes): Placement[] {
  const remaining: Block[] = free.map((b) => ({ ...b }));
  const out: Placement[] = [];
  for (const item of focus) {
    const need = sizeMinutes(item.size);
    let idx = remaining.findIndex((b) => toMinutes(b.end) - toMinutes(b.start) >= need);
    if (idx === -1) {
      // Nothing fits whole: take the largest block if it is at least an hour.
      let best = -1;
      let bestLen = 59;
      remaining.forEach((b, i) => {
        const len = toMinutes(b.end) - toMinutes(b.start);
        if (len > bestLen) (best = i), (bestLen = len);
      });
      idx = best;
    }
    if (idx === -1) continue;
    const block = remaining[idx];
    const start = toMinutes(block.start);
    const end = Math.min(toMinutes(block.end), start + need);
    out.push({ item, block: { start: fromMinutes(start), end: fromMinutes(end) } });
    const leftover = toMinutes(block.end) - end;
    if (leftover >= minMinutes) remaining[idx] = { start: fromMinutes(end), end: block.end };
    else remaining.splice(idx, 1);
  }
  return out;
}

/** Events, planned slices and leftover free gaps, in time order. */
export function buildSchedule(events: CalendarEvent[], placements: Placement[], opts: DayPlanOptions = DEFAULT_DAY): ScheduleItem[] {
  const items: ScheduleItem[] = events.map((e) => ({
    start: e.allDay ? "00:00" : hhmm(e.start),
    end: e.allDay ? "23:59" : hhmm(e.end),
    title: e.allDay ? `${e.title} (all day)` : e.title,
    free: false,
    plan: "",
  }));
  for (const b of freeBlocks(events, opts)) {
    // Walk the block, emitting planned slices and the gaps between them.
    let cursor = toMinutes(b.start);
    const inside = placements
      .filter((p) => toMinutes(p.block.start) >= toMinutes(b.start) && toMinutes(p.block.end) <= toMinutes(b.end))
      .sort((x, y) => x.block.start.localeCompare(y.block.start));
    for (const p of inside) {
      const ps = toMinutes(p.block.start);
      if (ps - cursor >= opts.minMinutes) items.push({ start: fromMinutes(cursor), end: p.block.start, title: "Free block", free: true, plan: "" });
      items.push({ start: p.block.start, end: p.block.end, title: "Free block", free: true, plan: p.item.title });
      cursor = toMinutes(p.block.end);
    }
    if (toMinutes(b.end) - cursor >= opts.minMinutes) items.push({ start: fromMinutes(cursor), end: b.end, title: "Free block", free: true, plan: "" });
  }
  return items.sort((a, b) => a.start.localeCompare(b.start));
}
