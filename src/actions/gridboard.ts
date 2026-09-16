/**
 * Agent Grid's work areas and tickets, as the assistant sees them.
 *
 * Agent Grid keeps three things apart that a person thinks of together: work areas (areas.json), the
 * agents running right now (sessions), and the ticket board. An area doesn't list its agents — a
 * separate `members` map says which session sits where — and a ticket names its agent by session id.
 * Everything here is the join, done once: area -> the agents in it -> the tickets each one holds.
 *
 * Nothing here talks to Agent Grid. It takes what the client fetched and returns plain data or text,
 * so it can be tested without a server.
 */
import {
  TICKET_PRIORITIES, TICKET_STATUSES, TICKET_TYPES, runsOn,
  type AgentSession, type AreasFile, type Ticket, type TicketPriority, type TicketStatus, type TicketType, type WorkArea,
} from "./agentgrid.js";

export const STATUS_LABELS: Record<TicketStatus, string> = {
  backlog: "Backlog", todo: "To do", in_progress: "In progress", review: "In review", done: "Done",
};

/** What people say for each status, mirrored from tickets.py so the assistant accepts the same words. */
const STATUS_ALIASES: Record<string, TicketStatus> = {
  progress: "in_progress", doing: "in_progress", start: "in_progress", started: "in_progress", wip: "in_progress",
  "in progress": "in_progress", "in-progress": "in_progress", working: "in_progress",
  in_review: "review", "in review": "review", reviewing: "review", pr: "review",
  closed: "done", complete: "done", completed: "done", finished: "done",
  open: "todo", queued: "todo", next: "todo", "to do": "todo", later: "backlog",
};

/** A status from whatever someone said, or null when it isn't one. */
export function parseStatus(input: string | undefined): TicketStatus | null {
  const s = String(input ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  if ((TICKET_STATUSES as readonly string[]).includes(s)) return s as TicketStatus;
  const underscored = s.replace(/[ -]/g, "_");
  if ((TICKET_STATUSES as readonly string[]).includes(underscored)) return underscored as TicketStatus;
  return STATUS_ALIASES[s] ?? STATUS_ALIASES[underscored] ?? null;
}

export function parseType(input: string | undefined): TicketType | null {
  const s = String(input ?? "").trim().toLowerCase();
  return (TICKET_TYPES as readonly string[]).includes(s) ? (s as TicketType) : null;
}

export function parsePriority(input: string | undefined): TicketPriority | null {
  const s = String(input ?? "").trim().toLowerCase();
  if (s === "critical" || s === "p0") return "urgent";
  if (s === "normal" || s === "p2") return "medium";
  return (TICKET_PRIORITIES as readonly string[]).includes(s) ? (s as TicketPriority) : null;
}

/**
 * "dc-12", "DC12", "#DC-12" -> "DC-12"; anything that isn't shaped like an id -> null.
 * A key may contain digits (A1-4), but only a hyphen can say where it ends: without one, "DC12" is
 * read as letters then a number, never as DC1-2.
 */
export function normalizeTicketId(input: string): string | null {
  const s = input.trim().replace(/^#\s*/, "");
  const m = /^([A-Za-z][A-Za-z0-9]{1,4})\s*-\s*(\d{1,6})$/.exec(s) ?? /^([A-Za-z]{2,5})(\d{1,6})$/.exec(s);
  return m ? `${m[1].toUpperCase()}-${Number(m[2])}` : null;
}

// ---------- the hierarchy ----------

export interface AreaNode {
  area: WorkArea;
  agents: AgentSession[];
}

export interface AreaTree {
  areas: AreaNode[];
  /** Running agents that aren't in any area. */
  unfiled: AgentSession[];
  /** Membership entries whose session has ended: counted, not shown. */
  ended: number;
}

/** Areas with the agents in each, in the order Agent Grid lists them. */
export function areaTree(file: AreasFile, sessions: AgentSession[]): AreaTree {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const known = new Set(file.areas.map((a) => a.id));
  const nodes = new Map(file.areas.map((a) => [a.id, { area: a, agents: [] as AgentSession[] }]));
  let ended = 0;
  const filed = new Set<string>();
  for (const [sessionId, areaId] of Object.entries(file.members)) {
    const session = byId.get(sessionId);
    if (!session) {
      if (known.has(areaId)) ended++;
      continue;
    }
    const node = nodes.get(areaId);
    if (!node) continue; // an area that was deleted: the agent counts as unfiled
    node.agents.push(session);
    filed.add(sessionId);
  }
  return {
    areas: [...nodes.values()],
    unfiled: sessions.filter((s) => !filed.has(s.sessionId)),
    ended,
  };
}

/** Which area an agent is in, if any. */
export function areaOf(tree: AreaTree, sessionId: string): WorkArea | null {
  return tree.areas.find((n) => n.agents.some((a) => a.sessionId === sessionId))?.area ?? null;
}

/** An area from a name someone said: exact, then a unique prefix or substring. */
export function findArea(areas: WorkArea[], ref: string): WorkArea | { error: string } {
  const want = ref.trim().toLowerCase();
  if (!want) return { error: "Say which work area." };
  const exact = areas.find((a) => a.name.toLowerCase() === want || a.id === ref.trim());
  if (exact) return exact;
  const partial = areas.filter((a) => a.name.toLowerCase().includes(want));
  if (partial.length === 1) return partial[0];
  const names = areas.map((a) => a.name).join(", ");
  if (!partial.length) return { error: `No work area called "${ref}". There are: ${names || "none"}.` };
  return { error: `"${ref}" could be ${partial.map((a) => a.name).join(" or ")}. Which one?` };
}

// ---------- finding and filtering tickets ----------

/** A ticket from an id or a few words of its title. */
export function findTicket(tickets: Ticket[], ref: string): Ticket | { error: string } {
  const raw = ref.trim();
  if (!raw) return { error: "Say which ticket: its id, like DC-12, or words from its title." };
  const id = normalizeTicketId(raw);
  if (id) {
    const hit = tickets.find((t) => t.id === id);
    return hit ?? { error: `There's no ticket ${id} on the board.` };
  }
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = tickets.filter((t) => words.every((w) => t.title.toLowerCase().includes(w)));
  if (matches.length === 1) return matches[0];
  if (!matches.length) return { error: `No ticket matches "${raw}".` };
  // An open ticket is almost always the one meant over a closed one with the same words.
  const open = matches.filter((t) => t.status !== "done");
  if (open.length === 1) return open[0];
  const listed = matches.slice(0, 6).map((t) => `${t.id} "${t.title}"`).join(", ");
  return { error: `"${raw}" matches ${matches.length} tickets: ${listed}. Which one?` };
}

export interface TicketFilter {
  status?: TicketStatus;
  /** A name, matched loosely; "none" means unassigned. */
  assignee?: string;
  /** A project folder or its name. */
  project?: string;
  /** Only tickets held by an agent in this area. */
  area?: AreaNode;
  /** Words that must all appear in the title or body. */
  query?: string;
  /** Done tickets are left out unless asked for, or unless the status asked for is done. */
  includeDone?: boolean;
}

export function filterTickets(tickets: Ticket[], f: TicketFilter): Ticket[] {
  const words = (f.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const who = (f.assignee ?? "").trim().toLowerCase();
  const project = (f.project ?? "").trim().toLowerCase();
  const inArea = f.area ? new Set(f.area.agents.map((a) => a.sessionId)) : null;
  const areaNames = f.area ? new Set(f.area.agents.map((a) => (a.customName || a.title).toLowerCase())) : null;
  return tickets.filter((t) => {
    if (f.status ? t.status !== f.status : !f.includeDone && t.status === "done") return false;
    if (who === "none" || who === "nobody" || who === "unassigned") {
      if (t.assignee) return false;
    } else if (who && !t.assignee.toLowerCase().includes(who)) return false;
    if (project && !t.project.toLowerCase().includes(project) && !t.projectName.toLowerCase().includes(project)) return false;
    if (inArea && !(t.sessionId && inArea.has(t.sessionId)) && !(t.assignee && areaNames?.has(t.assignee.toLowerCase()))) return false;
    if (words.length) {
      const hay = `${t.title}\n${t.body}\n${t.labels.join(" ")}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

// ---------- what the model reads ----------

/** The same words get_agents uses, so an agent reads the same everywhere. */
function statusMark(status: string): string {
  return status === "blocked" ? "needs you" : status;
}

const isLive = (a: AgentSession) => a.status !== "done" && a.status !== "stopped";

function agentLine(a: AgentSession, held: Ticket[]): string {
  const name = a.customName || a.title || a.sessionId.slice(0, 8);
  const tickets = held.length ? ` · holds ${held.map((t) => t.id).join(", ")}` : "";
  return `  - ${name} (${a.sessionId.slice(0, 8)}, ${runsOn(a)}) — ${statusMark(a.status)}${a.project ? `, in ${a.project}` : ""}${tickets}`;
}

/**
 * Areas, then their agents, then what each agent holds. Agents that are still running are listed;
 * finished ones are counted, because a work area that has run for a month would otherwise be a wall
 * of "done". Unfiled agents come last, the same way.
 */
export function formatAreaTree(tree: AreaTree, tickets: Ticket[] = [], maxUnfiled = 8): string {
  const heldBy = (sessionId: string) => tickets.filter((t) => t.sessionId === sessionId && t.status !== "done");
  const lines: string[] = [];
  if (!tree.areas.length) lines.push("No work areas yet.");
  for (const node of tree.areas) {
    const live = node.agents.filter(isLive);
    const finished = node.agents.length - live.length;
    const needing = live.filter((a) => a.status === "blocked").length;
    const bits = [
      live.length ? `${live.length} running` : "",
      needing ? `${needing} need${needing === 1 ? "s" : ""} you` : "",
      finished ? `${finished} finished` : "",
    ].filter(Boolean);
    lines.push(`${node.area.name} (${bits.join(", ") || "no agents"})`);
    for (const a of live) lines.push(agentLine(a, heldBy(a.sessionId)));
  }
  const liveUnfiled = tree.unfiled.filter(isLive);
  const doneUnfiled = tree.unfiled.length - liveUnfiled.length;
  if (tree.unfiled.length) {
    lines.push(`Not in any work area: ${liveUnfiled.length} running${doneUnfiled ? `, ${doneUnfiled} finished` : ""}`);
    for (const a of liveUnfiled.slice(0, maxUnfiled)) lines.push(agentLine(a, heldBy(a.sessionId)));
    if (liveUnfiled.length > maxUnfiled) lines.push(`  …and ${liveUnfiled.length - maxUnfiled} more (get_agents lists them all).`);
  }
  return lines.join("\n");
}

function ticketLine(t: Ticket): string {
  const parts = [STATUS_LABELS[t.status], t.priority !== "medium" ? t.priority : "", t.type !== "task" ? t.type : ""].filter(Boolean);
  const who = t.assignee ? ` → ${t.assignee}` : " · unassigned";
  const due = t.due ? ` · due ${t.due}` : "";
  const where = t.projectName ? ` · ${t.projectName}` : "";
  return `- ${t.id} ${t.title} [${parts.join(", ")}]${who}${where}${due}`;
}

/** A compact list, open work first by column, then what's done if it was asked for. */
export function formatTickets(tickets: Ticket[], limit = 25): string {
  if (!tickets.length) return "No tickets match.";
  const order = new Map(TICKET_STATUSES.map((s, i) => [s, i]));
  const sorted = [...tickets].sort((a, b) => (order.get(a.status)! - order.get(b.status)!) || a.rank - b.rank);
  const shown = sorted.slice(0, limit).map(ticketLine);
  if (sorted.length > limit) shown.push(`…and ${sorted.length - limit} more. Narrow it by status, assignee, project or words.`);
  return shown.join("\n");
}

/** Counts by column, and what's waiting on the user. */
export function formatBoardSummary(tickets: Ticket[]): string {
  if (!tickets.length) return "The ticket board is empty.";
  const counts = TICKET_STATUSES.map((s) => [s, tickets.filter((t) => t.status === s).length] as const).filter(([, n]) => n);
  const review = tickets.filter((t) => t.status === "review");
  const unassigned = tickets.filter((t) => !t.assignee && t.status !== "done").length;
  const lines = [counts.map(([s, n]) => `${STATUS_LABELS[s]}: ${n}`).join(" · ")];
  if (review.length) lines.push(`Waiting on your review: ${review.map((t) => `${t.id} ${t.title}`).join("; ")}`);
  if (unassigned) lines.push(`${unassigned} open ticket${unassigned === 1 ? " has" : "s have"} nobody on ${unassigned === 1 ? "it" : "them"}.`);
  return lines.join("\n");
}

function activityLine(a: { at: string; who: string; kind: string; text?: string; from?: string; to?: string }): string {
  const when = a.at.replace("T", " ").slice(0, 16);
  const change = a.from || a.to ? ` ${a.from ?? "—"} → ${a.to ?? "—"}` : "";
  return `  ${when} ${a.who} ${a.kind}${change}${a.text ? `: ${a.text.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
}

/** One ticket in full: fields, description, and the most recent history. */
export function formatTicket(t: Ticket, maxActivity = 12): string {
  const lines = [
    `${t.id} — ${t.title}`,
    `Status: ${STATUS_LABELS[t.status]} · ${t.type} · ${t.priority} priority`,
    `Assignee: ${t.assignee || "nobody"}${t.sessionId ? ` (live agent ${t.sessionId.slice(0, 8)})` : ""} · reported by ${t.reporter || "unknown"}`,
  ];
  if (t.projectName) lines.push(`Project: ${t.projectName}${t.project ? ` (${t.project})` : ""}`);
  if (t.labels.length) lines.push(`Labels: ${t.labels.join(", ")}`);
  if (t.due) lines.push(`Due: ${t.due}`);
  lines.push(`Created ${t.created.slice(0, 10)}, updated ${t.updated.replace("T", " ").slice(0, 16)}`);
  if (t.body) lines.push("", t.body.length > 4000 ? `${t.body.slice(0, 4000)}…` : t.body);
  if (t.activity.length) {
    lines.push("", `History (latest ${Math.min(maxActivity, t.activity.length)} of ${t.activity.length}):`);
    for (const a of t.activity.slice(-maxActivity)) lines.push(activityLine(a));
  }
  return lines.join("\n");
}
