/**
 * Changing Agent Grid tickets on the user's behalf: file, edit, move, assign, comment, delete.
 *
 * Two steps, on purpose. `planTicketChange` turns what the model asked for into a concrete change —
 * every reference resolved (a title to DC-12, "the MLG agent" to a session id), every value checked —
 * and says in words what will happen. `performTicketChange` carries that out. Between them sits the
 * user's OK when the access mode asks for one, and the plan is what they approve: what runs is exactly
 * what they read, not a fresh interpretation of the model's words after the fact.
 *
 * A delete always waits for the OK, whatever the mode. Agent Grid removes the file; there is no undo.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  findSession, type AgentGrid, type AgentSession, type Board, type Ticket, type TicketFields,
  type TicketPriority, type TicketStatus, type TicketType,
} from "./agentgrid.js";
import { STATUS_LABELS, findTicket, parsePriority, parseStatus, parseType } from "./gridboard.js";

export const TICKET_ACTIONS = ["create", "edit", "move", "assign", "comment", "delete"] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

/** A change with every reference already resolved. This is what gets approved and what gets run. */
export type TicketChange =
  | { action: "create"; fields: TicketFields & { title: string; status?: TicketStatus; assignee?: string }; handTo?: { sessionId: string; name: string } }
  | { action: "edit"; id: string; fields: TicketFields }
  | { action: "move"; id: string; status: TicketStatus; before?: string }
  | { action: "assign"; id: string; sessionId?: string; assignee?: string; name: string; start: boolean }
  | { action: "comment"; id: string; text: string }
  | { action: "delete"; id: string; title: string };

export interface TicketPlan {
  change: TicketChange;
  /** One line for the confirmation card. */
  label: string;
  /** What will happen, in full, for the card and the log. */
  detail: string;
  /** The button. */
  verb: string;
  /** Ask first even when the access mode says not to. */
  alwaysAsk: boolean;
}

/** The input the tool receives, loosely typed because it comes from a model. */
export type TicketInput = Record<string, unknown>;

const str = (input: TicketInput, key: string): string => {
  const v = input[key];
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
};

const has = (input: TicketInput, key: string): boolean => input[key] !== undefined && input[key] !== null && str(input, key) !== "" || Array.isArray(input[key]);

function labelsFrom(input: TicketInput): string[] | undefined {
  const raw = input.labels;
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
  return list.map((l) => l.trim()).filter(Boolean);
}

function dueFrom(input: TicketInput): string | undefined {
  if (!has(input, "due")) return undefined;
  const due = str(input, "due");
  if (/^(none|no|clear|-)$/i.test(due)) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due))) {
    throw new Error(`A due date is YYYY-MM-DD, not "${due}". Work out the date first.`);
  }
  return due;
}

function typeFrom(input: TicketInput): TicketType | undefined {
  if (!has(input, "type")) return undefined;
  const t = parseType(str(input, "type"));
  if (!t) throw new Error(`"${str(input, "type")}" isn't a ticket type. Use task, bug, story, spike or chore.`);
  return t;
}

function priorityFrom(input: TicketInput): TicketPriority | undefined {
  if (!has(input, "priority")) return undefined;
  const p = parsePriority(str(input, "priority"));
  if (!p) throw new Error(`"${str(input, "priority")}" isn't a priority. Use low, medium, high or urgent.`);
  return p;
}

function statusFrom(input: TicketInput, required: boolean): TicketStatus | undefined {
  if (!has(input, "status")) {
    if (required) throw new Error("Say which column: backlog, todo, in_progress, review or done.");
    return undefined;
  }
  const s = parseStatus(str(input, "status"));
  if (!s) throw new Error(`"${str(input, "status")}" isn't a column. Use backlog, todo, in_progress, review or done.`);
  return s;
}

/**
 * A project folder from what was said: a path, or the name of one Agent Grid already knows.
 * "" clears it. A name nobody knows is an error, not a guess.
 */
async function projectFrom(input: TicketInput, grid: AgentGrid): Promise<string | undefined> {
  if (!has(input, "project")) return undefined;
  const raw = str(input, "project");
  if (/^(none|no project|clear|-)$/i.test(raw)) return "";
  if (raw.startsWith("~") || raw.startsWith("/")) {
    const path = resolve(raw.replace(/^~(?=$|\/)/, homedir()));
    if (path !== homedir() && !path.startsWith(`${homedir()}/`)) throw new Error("A ticket's project has to be a folder inside the home folder.");
    return path;
  }
  const known = await grid.projects();
  const want = raw.toLowerCase();
  const exact = known.filter((p) => p.split("/").pop()!.toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  const partial = known.filter((p) => p.split("/").pop()!.toLowerCase().includes(want));
  if (partial.length === 1) return partial[0];
  const names = known.map((p) => p.split("/").pop()).slice(0, 12).join(", ");
  if (!partial.length && !exact.length) throw new Error(`Agent Grid doesn't know a project called "${raw}". Give its folder path, or one of: ${names || "none yet"}.`);
  throw new Error(`"${raw}" could be ${[...exact, ...partial].slice(0, 5).join(" or ")}. Give the folder path.`);
}

function ticketFrom(board: Board, input: TicketInput): Ticket {
  const ref = str(input, "ticket") || str(input, "id");
  const found = findTicket(board.tickets, ref);
  if ("error" in found) throw new Error(found.error);
  return found;
}

async function agentFrom(grid: AgentGrid, ref: string): Promise<AgentSession> {
  const found = findSession(await grid.sessions(), ref);
  if ("error" in found) throw new Error(found.error);
  return found;
}

const agentName = (a: AgentSession) => a.customName || a.title || a.sessionId.slice(0, 8);

function summarizeFields(f: TicketFields & { status?: TicketStatus; assignee?: string }): string {
  const bits: string[] = [];
  if (f.type) bits.push(f.type);
  if (f.priority) bits.push(`${f.priority} priority`);
  if (f.status) bits.push(STATUS_LABELS[f.status]);
  if (f.project !== undefined) bits.push(f.project ? `in ${f.project.split("/").pop()}` : "no project");
  if (f.labels) bits.push(f.labels.length ? `labels ${f.labels.join(", ")}` : "no labels");
  if (f.due !== undefined) bits.push(f.due ? `due ${f.due}` : "no due date");
  if (f.assignee) bits.push(`for ${f.assignee}`);
  return bits.join(", ");
}

/** Work out exactly what a request means, or say what's wrong with it. Reads the board; changes nothing. */
export async function planTicketChange(input: TicketInput, grid: AgentGrid): Promise<TicketPlan> {
  const action = str(input, "action").toLowerCase() as TicketAction;
  if (!(TICKET_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`action must be one of ${TICKET_ACTIONS.join(", ")}.`);
  }

  if (action === "create") {
    const title = str(input, "title");
    if (!title) throw new Error("A ticket needs a title: one line saying what the work is.");
    if (title.length > 160) throw new Error("That title is over 160 characters. Put the detail in the body.");
    const fields: TicketFields & { title: string; status?: TicketStatus; assignee?: string } = { title };
    const body = str(input, "body");
    if (body) fields.body = body;
    fields.type = typeFrom(input);
    fields.priority = priorityFrom(input);
    fields.status = statusFrom(input, false);
    fields.project = await projectFrom(input, grid);
    fields.labels = labelsFrom(input);
    fields.due = dueFrom(input);
    for (const k of Object.keys(fields) as (keyof typeof fields)[]) if (fields[k] === undefined) delete fields[k];
    let handTo: { sessionId: string; name: string } | undefined;
    const agentRef = str(input, "agent");
    if (agentRef) {
      const agent = await agentFrom(grid, agentRef);
      handTo = { sessionId: agent.sessionId, name: agentName(agent) };
    } else if (str(input, "assignee")) {
      fields.assignee = str(input, "assignee");
    }
    const extra = summarizeFields(fields);
    return {
      change: { action, fields, handTo },
      label: `new ticket: ${title}`,
      detail: `File a ticket: ${title}${extra ? `\n${extra}` : ""}${body ? `\n\n${body.slice(0, 600)}` : ""}${handTo ? `\nThen hand it to ${handTo.name} and tell it in its chat.` : ""}`,
      verb: "File ticket",
      alwaysAsk: false,
    };
  }

  const board = await grid.board();
  const ticket = ticketFrom(board, input);
  const name = `${ticket.id} "${ticket.title}"`;

  switch (action) {
    case "edit": {
      const fields: TicketFields = {};
      if (has(input, "title")) {
        const title = str(input, "title");
        if (!title) throw new Error("A ticket can't have an empty title.");
        fields.title = title;
      }
      if (input.body !== undefined) fields.body = str(input, "body");
      fields.type = typeFrom(input);
      fields.priority = priorityFrom(input);
      fields.project = await projectFrom(input, grid);
      fields.labels = labelsFrom(input);
      fields.due = dueFrom(input);
      for (const k of Object.keys(fields) as (keyof TicketFields)[]) if (fields[k] === undefined) delete fields[k];
      if (!Object.keys(fields).length) {
        throw new Error("Nothing to change. To move a ticket use action move; to give it to someone use assign.");
      }
      const what = [fields.title ? `title to "${fields.title}"` : "", fields.body !== undefined ? "its description" : "", summarizeFields(fields)].filter(Boolean).join(", ");
      return { change: { action, id: ticket.id, fields }, label: `edit ${ticket.id}`, detail: `Change ${name}: ${what}`, verb: "Save", alwaysAsk: false };
    }
    case "move": {
      const status = statusFrom(input, true)!;
      let before: string | undefined;
      if (has(input, "before")) {
        const target = findTicket(board.tickets, str(input, "before"));
        if ("error" in target) throw new Error(target.error);
        before = target.id;
      }
      if (status === ticket.status && !before) throw new Error(`${ticket.id} is already in ${STATUS_LABELS[status]}.`);
      return {
        change: { action, id: ticket.id, status, before },
        label: `move ${ticket.id} to ${STATUS_LABELS[status]}`,
        detail: `Move ${name} from ${STATUS_LABELS[ticket.status]} to ${STATUS_LABELS[status]}${before ? `, above ${before}` : ""}`,
        verb: "Move",
        alwaysAsk: false,
      };
    }
    case "assign": {
      const start = input.start === true;
      const agentRef = str(input, "agent");
      const assigneeRaw = str(input, "assignee");
      if (agentRef) {
        const agent = await agentFrom(grid, agentRef);
        const who = agentName(agent);
        return {
          change: { action, id: ticket.id, sessionId: agent.sessionId, name: who, start },
          label: `give ${ticket.id} to ${who}`,
          detail: `Give ${name} to ${who} (${agent.sessionId.slice(0, 8)}) and tell it in its chat${start ? ", and move it to In progress" : ""}.`,
          verb: "Assign",
          alwaysAsk: false,
        };
      }
      if (!assigneeRaw) throw new Error("Say who: agent (a running agent) or assignee (a name), or assignee \"none\" to unassign.");
      const clear = /^(none|nobody|no one|unassigned|-)$/i.test(assigneeRaw);
      return {
        change: { action, id: ticket.id, assignee: clear ? "" : assigneeRaw, name: clear ? "nobody" : assigneeRaw, start: clear ? false : start },
        label: clear ? `unassign ${ticket.id}` : `assign ${ticket.id} to ${assigneeRaw}`,
        detail: clear ? `Take ${name} off ${ticket.assignee || "whoever has it"}.` : `Assign ${name} to ${assigneeRaw} (a name only: no agent is told)${start ? ", and move it to In progress" : ""}.`,
        verb: clear ? "Unassign" : "Assign",
        alwaysAsk: false,
      };
    }
    case "comment": {
      const text = str(input, "text");
      if (!text) throw new Error("A comment needs text.");
      if (text.length > 8000) throw new Error("That comment is over 8,000 characters.");
      return { change: { action, id: ticket.id, text }, label: `comment on ${ticket.id}`, detail: `Comment on ${name}:\n${text}`, verb: "Comment", alwaysAsk: false };
    }
    case "delete":
      return {
        change: { action, id: ticket.id, title: ticket.title },
        label: `delete ${ticket.id}`,
        detail: `Delete ${name} for good (${STATUS_LABELS[ticket.status]}, ${ticket.activity.length} history entries). Agent Grid can't undo this.`,
        verb: "Delete ticket",
        alwaysAsk: true,
      };
  }
  throw new Error(`Unknown action ${action}.`);
}

/** Carry out a planned change and say what happened. */
export async function performTicketChange(change: TicketChange, grid: AgentGrid): Promise<string> {
  switch (change.action) {
    case "create": {
      const made = await grid.createTicket(change.fields);
      const id = made.ticket.id;
      if (!change.handTo) return `Filed ${id}: ${made.ticket.title}.`;
      try {
        const given = await grid.assignTicket(id, { sessionId: change.handTo.sessionId, notify: true });
        return `Filed ${id}: ${made.ticket.title}. ${given.message ?? `Handed to ${change.handTo.name}.`}`;
      } catch (err) {
        // The ticket exists either way; say plainly which half didn't happen.
        return `Filed ${id}: ${made.ticket.title}, but couldn't hand it to ${change.handTo.name}: ${(err as Error).message}`;
      }
    }
    case "edit": {
      const r = await grid.updateTicket(change.id, change.fields);
      return `Updated ${r.ticket.id}.`;
    }
    case "move": {
      const r = await grid.moveTicket(change.id, change.status, change.before);
      return `${r.ticket.id} is in ${STATUS_LABELS[r.ticket.status]} now.`;
    }
    case "assign": {
      const r = await grid.assignTicket(change.id, { sessionId: change.sessionId, assignee: change.assignee, start: change.start, notify: true });
      if (r.message) return r.message;
      return r.ticket.assignee ? `${r.ticket.id} assigned to ${r.ticket.assignee}.` : `${r.ticket.id} unassigned.`;
    }
    case "comment": {
      const r = await grid.commentTicket(change.id, change.text);
      return `Commented on ${r.ticket.id}.`;
    }
    case "delete":
      await grid.deleteTicket(change.id);
      return `Deleted ${change.id} ("${change.title}").`;
  }
}
