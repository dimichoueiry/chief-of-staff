/**
 * Rule-based brief. Works with no model at all, and gives the model path a
 * deterministic baseline for ranking, nudges and decisions.
 */
import type { Brief, Decision, FocusItem } from "../brain/schema.js";
import type { ContextBundle } from "../core/context.js";
import { normalizeStatus, type Project } from "../core/ledger.js";
import { daysBetween, longDate } from "../util/dates.js";
import { daysIdle, describeCadence } from "./cadence.js";
import { buildSchedule, freeBlocks, planDay } from "./dayplan.js";

export function greetingFor(name: string, now: Date = new Date()): string {
  const h = now.getHours();
  const word = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${word}, ${name}` : word;
}

interface Scored {
  project: Project;
  score: number;
  reasons: string[];
  size: string;
}

function scoreProject(p: Project, ctx: ContextBundle): Scored | null {
  if (normalizeStatus(p.status) !== "active" || !p.next) return null;
  let score = 0;
  const reasons: string[] = [];
  let size = "1 hour";
  const idle = daysIdle(p, ctx.today);

  if (ctx.flags.cadenceDue.includes(p.name)) {
    score += 100;
    reasons.push(`you said ${describeCadence(p)}`);
    size = "half day";
  }
  if (p.deadline && p.deadline !== "none" && /^\d{4}-\d{2}-\d{2}$/.test(p.deadline)) {
    const left = daysBetween(ctx.today, p.deadline);
    if (left < 0) {
      score += 90;
      reasons.push(`deadline passed ${-left} day${left === -1 ? "" : "s"} ago`);
    } else if (left <= 3) {
      score += 80;
      reasons.push(left === 0 ? "due today" : left === 1 ? "due tomorrow" : `due in ${left} days`);
    } else if (left <= 7) {
      score += 50;
      reasons.push(`due ${p.deadline}`);
    } else if (left <= 21) {
      score += 15;
      reasons.push(`ships ${p.deadline}`);
    }
  }
  if (ctx.flags.silent.includes(p.name)) {
    score += 20;
    reasons.push(idle === null ? "never touched" : `idle ${idle} days`);
  } else if (idle !== null && idle <= 2) {
    score += 10;
    reasons.push("momentum");
  }
  if (!reasons.length && p.why) reasons.push(p.why);
  return { project: p, score, reasons, size };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function rankFocus(ctx: ContextBundle, limit = 3): FocusItem[] {
  return ctx.projects
    .map((p) => scoreProject(p, ctx))
    .filter((s): s is Scored => s !== null)
    .sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name))
    .slice(0, limit)
    .map((s) => ({
      title: capitalize(s.project.next!),
      project: s.project.name,
      why: s.reasons.join(" · "),
      size: s.size,
      when: "",
    }));
}

export function buildDecisions(ctx: ContextBundle): Decision[] {
  const out: Decision[] = [];
  for (const name of ctx.flags.silent) {
    // A project whose cadence nudge fires today is already in front of them; don't also ask keep/park/kill.
    if (ctx.flags.cadenceDue.includes(name)) continue;
    const p = ctx.projects.find((x) => x.name === name)!;
    const idle = daysIdle(p, ctx.today);
    out.push({
      project: p.name,
      question: `${p.name} ${idle === null ? "has never been touched" : `untouched ${idle} days`} — keep, park, or kill?`,
      options: ["keep", "park", "kill"],
      reason: p.why ?? "",
    });
  }
  for (const name of ctx.flags.parkedReview) {
    const p = ctx.projects.find((x) => x.name === name)!;
    out.push({
      project: p.name,
      question: `${p.name} has been parked a month — revive it or kill it?`,
      options: ["keep", "kill"],
      reason: p.why ?? "",
    });
  }
  return out;
}

export function buildNudges(ctx: ContextBundle): string[] {
  return ctx.flags.cadenceDue.map((name) => {
    const p = ctx.projects.find((x) => x.name === name)!;
    const idle = daysIdle(p, ctx.today);
    const parts = [`It's ${ctx.weekday}. You said ${describeCadence(p)} are for ${p.name}.`];
    if (idle !== null) parts.push(`Idle ${idle} day${idle === 1 ? "" : "s"}.`);
    if (p.next) parts.push(`Next: ${capitalize(p.next)}.`);
    return parts.join(" ");
  });
}

export function buildBrief(ctx: ContextBundle, now: Date = new Date()): Brief {
  const focus = rankFocus(ctx);
  const placements = planDay(focus, freeBlocks(ctx.calendar));
  for (const pl of placements) pl.item.when = `${pl.block.start}–${pl.block.end}`;
  const schedule = buildSchedule(ctx.calendar, placements);
  const decisions = buildDecisions(ctx);
  const reminders = [
    ...ctx.remindersDue.map((r) => ({ date: r.date, text: r.text, overdue: true })),
    ...ctx.remindersUpcoming.map((r) => ({ date: r.date, text: r.text, overdue: false })),
  ];
  const events = ctx.calendar.length;
  const headline = [
    `${focus.length} thing${focus.length === 1 ? "" : "s"} today`,
    events ? `${events} event${events === 1 ? "" : "s"}` : "calendar clear",
    decisions.length ? `${decisions.length} decision${decisions.length === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    greeting: greetingFor(ctx.name, now),
    date: ctx.today,
    headline: `${longDate(ctx.today)} · ${headline}`,
    focus,
    schedule,
    decisions,
    reminders,
    nudges: buildNudges(ctx),
  };
}
