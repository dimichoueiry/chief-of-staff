/** One brief, rendered for whatever surface is asking. Mirrors the UI design: greeting, focus, schedule, decisions, reminders, nudges. */
import type { Brief } from "../brain/schema.js";
import { longDate, parseISO } from "../util/dates.js";

/** "Thu Sep 17" */
function shortDay(dateISO: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateISO)
    ? parseISO(dateISO).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : dateISO;
}

/** "Thursday" */
function weekday(dateISO: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? parseISO(dateISO).toLocaleDateString("en-US", { weekday: "long" }) : dateISO;
}

export type Target = "terminal" | "markdown" | "speech" | "notification";

// ---------- terminal ----------

const ESC = String.fromCharCode(27);
const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const style = (code: string) => (s: string) => (useColor() ? `${ESC}[${code}m${s}${ESC}[0m` : s);
export const bold = style("1");
export const dim = style("2");
export const amber = style("38;5;215");
export const coral = style("38;5;209");
export const green = style("38;5;114");
export const rose = style("38;5;211");
const DOTS = [coral("●"), amber("●"), green("●")];

export function renderBriefTerminal(b: Brief): string {
  const out: string[] = [];
  out.push(bold(b.greeting));
  out.push(dim(b.headline));
  out.push("");
  out.push(amber("TODAY'S FOCUS"));
  if (!b.focus.length) out.push(dim("  Nothing ranked. Add a next action to a project."));
  b.focus.forEach((f, i) => {
    out.push(`  ${DOTS[i] ?? DOTS[2]} ${bold(f.title)}  ${dim(`~ ${f.size}`)}`);
    const meta = [f.project, f.why, f.when].filter(Boolean).join(" · ");
    if (meta) out.push(`    ${dim(meta)}`);
  });
  out.push("");
  out.push(amber("SCHEDULE"));
  if (!b.schedule.length) out.push(dim("  Nothing on the calendar. The day is free."));
  for (const s of b.schedule) {
    if (s.free) out.push(`  ${amber("▌")}${s.start}–${s.end}  ${amber("Free block")}${s.plan ? dim(`  → ${s.plan}`) : ""}`);
    else out.push(`  ${dim("│")}${s.start}–${s.end}  ${s.title}`);
  }
  if (b.upcoming.length) {
    out.push("");
    out.push(amber("COMING UP"));
    for (const u of b.upcoming) out.push(`  ${dim(shortDay(u.date).padEnd(12))}${u.time.padEnd(9)}${u.title}`);
  }
  if (b.decisions.length) {
    out.push("");
    out.push(coral("NEEDS A DECISION"));
    for (const d of b.decisions) {
      out.push(`  ${bold(d.question)}`);
      if (d.reason) out.push(`    ${dim(d.reason)}`);
      out.push(`    ${dim(`cos decide "${d.project}" ${d.options.join("|")}`)}`);
    }
  }
  if (b.reminders.length) {
    out.push("");
    out.push(rose("REMINDERS"));
    for (const r of b.reminders) out.push(`  ${r.overdue ? coral("!") : dim("·")} ${r.date}  ${r.text}`);
  }
  if (b.nudges.length) {
    out.push("");
    out.push(amber("NUDGES"));
    for (const n of b.nudges) out.push(`  ${n}`);
  }
  return out.join("\n") + "\n";
}

// ---------- markdown ----------

export function renderBriefMarkdown(b: Brief): string {
  const out: string[] = [`## ${b.greeting}`, `_${b.headline}_`, "", "### Today's focus"];
  if (!b.focus.length) out.push("_Nothing ranked yet._");
  b.focus.forEach((f, i) => {
    out.push(`${i + 1}. **${f.title}** — ${[f.project, f.why].filter(Boolean).join(" · ")} _(${f.size}${f.when ? `, ${f.when}` : ""})_`);
  });
  out.push("", "### Schedule");
  if (!b.schedule.length) out.push("_Nothing on the calendar._");
  for (const s of b.schedule) out.push(s.free ? `- **${s.start}–${s.end} Free block**${s.plan ? ` → ${s.plan}` : ""}` : `- ${s.start}–${s.end} ${s.title}`);
  if (b.upcoming.length) {
    out.push("", "### Coming up");
    for (const u of b.upcoming) out.push(`- ${shortDay(u.date)} · ${u.time} · ${u.title}`);
  }
  if (b.decisions.length) {
    out.push("", "### Needs a decision");
    for (const d of b.decisions) out.push(`- **${d.question}**${d.reason ? ` — ${d.reason}` : ""} (${d.options.join(" / ")})`);
  }
  if (b.reminders.length) {
    out.push("", "### Reminders");
    for (const r of b.reminders) out.push(`- ${r.overdue ? "**overdue** " : ""}${r.date} · ${r.text}`);
  }
  if (b.nudges.length) {
    out.push("", "### Nudges");
    for (const n of b.nudges) out.push(`- ${n}`);
  }
  return out.join("\n") + "\n";
}

// ---------- speech ----------

const ORDINALS = ["First", "Second", "Third"];
const COUNTS = ["", "One", "Two", "Three"];

function spokenTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "a.m." : "p.m.";
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

/** End a spoken sentence exactly once, even when it already ends in "a.m." */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function renderBriefSpeech(b: Brief): string {
  const spokenWhy = (why: string) => why.replace(/\s*·\s*/g, ", ");
  const s: string[] = [sentence(b.greeting), `It's ${longDate(b.date)}.`];
  // The nudge already names the cadence project; skip it if it is also the first focus item.
  s.push(...b.nudges.map(sentence));
  if (b.focus.length) {
    s.push(b.focus.length === 1 ? "One thing today." : `${COUNTS[b.focus.length] ?? b.focus.length} things today.`);
    b.focus.forEach((f, i) => {
      let line = `${ORDINALS[i] ?? "Next"}, ${f.title.replace(/\.$/, "")}`;
      if (f.why) line += `, because ${spokenWhy(f.why)}`;
      s.push(sentence(line));
      if (f.when) {
        const [from, to] = f.when.split("–");
        s.push(sentence(`I'd do it ${spokenTime(from)} to ${spokenTime(to ?? from)}`));
      }
    });
  } else s.push("Nothing is ranked yet. Give a project a next action and I'll plan around it.");
  const events = b.schedule.filter((x) => !x.free);
  if (events.length) s.push(sentence(`On the calendar: ${events.map((e) => `${e.title} at ${spokenTime(e.start)}`).join(", ")}`));
  else s.push("Your calendar is clear.");
  if (b.upcoming.length) {
    const said = b.upcoming.slice(0, 3).map((u) => `${u.title} ${weekday(u.date)}${u.time && u.time !== "all day" ? ` at ${spokenTime(u.time)}` : ""}`);
    s.push(sentence(`Coming up: ${said.join(", ")}`));
  }
  if (b.decisions.length) {
    s.push(b.decisions.length === 1 ? "One decision." : `${COUNTS[b.decisions.length] ?? b.decisions.length} decisions.`);
    s.push(...b.decisions.map((d) => sentence(d.question)));
  }
  for (const r of b.reminders) s.push(`${r.overdue ? "Overdue reminder" : "Reminder"}: ${r.text}, ${r.date}.`);
  return s.join(" ");
}

/** A model's markdown as something a voice can read: no asterisks, hashes, bullets or raw links. */
export function markdownToSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\((?:https?:[^)]*)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+(.*?)[ \t]*$/gm, (_m, item: string) => sentence(item))
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// ---------- notification ----------

export function renderBriefNotification(b: Brief): { title: string; body: string } {
  const first = b.focus[0];
  const body = first
    ? `${first.title}${first.when ? ` · ${first.when}` : ""}${b.focus.length > 1 ? ` (+${b.focus.length - 1} more)` : ""}`
    : "Nothing ranked yet.";
  return { title: b.greeting, body };
}

export function renderBrief(b: Brief, target: Target): string {
  switch (target) {
    case "terminal":
      return renderBriefTerminal(b);
    case "markdown":
      return renderBriefMarkdown(b);
    case "speech":
      return renderBriefSpeech(b);
    case "notification": {
      const n = renderBriefNotification(b);
      return `${n.title}\n${n.body}`;
    }
  }
}
