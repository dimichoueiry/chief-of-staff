import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Access } from "../src/actions/access.js";
import { AgentGrid, type AgentSession, type AreasFile, type Ticket } from "../src/actions/agentgrid.js";
import {
  areaTree, filterTickets, findArea, findTicket, formatAreaTree, formatBoardSummary, formatTicket, formatTickets,
  normalizeTicketId, parsePriority, parseStatus, parseType,
} from "../src/actions/gridboard.js";
import { take } from "../src/actions/pending.js";
import { performPending } from "../src/actions/perform.js";
import { ToolRuntime } from "../src/brain/tools.js";
import { loadConfig } from "../src/config.js";
import { createUiServer } from "../src/ui/server.js";

// ---------- fixtures ----------

const SESSIONS: AgentSession[] = [
  { sessionId: "eng11111-working", title: "Refactor auth", status: "working", project: "drawcal", engine: "claude" },
  { sessionId: "eng22222-blocked", title: "Export bug", customName: "exporter", status: "blocked", project: "drawcal", engine: "codex" },
  { sessionId: "eng33333-done", title: "Old spike", status: "done", project: "drawcal", engine: "claude" },
  { sessionId: "mlg44444-working", title: "Module 6 quiz", status: "working", project: "mlguerilla", engine: "claude" },
  { sessionId: "free5555-working", title: "Loose research", status: "working", engine: "claude" },
  { sessionId: "free6666-done", title: "Finished thing", status: "done", engine: "claude" },
];

const AREAS: AreasFile = {
  areas: [
    { id: "engineering", name: "Engineering", prompt: "" },
    { id: "marketing", name: "Marketing", prompt: "" },
    { id: "3e13a2642214", name: "MLG", prompt: "Teach clearly." },
  ],
  members: {
    "eng11111-working": "engineering",
    "eng22222-blocked": "engineering",
    "eng33333-done": "engineering",
    "mlg44444-working": "3e13a2642214",
    "gone9999-ended": "engineering", // a session that has since ended
    "free5555-working": "deleted-area", // an area that was removed
  },
};

const DRAWCAL = `${homedir()}/Desktop/drawcal`;
const MLG = `${homedir()}/Documents/GitHub/mlguerilla`;

function ticket(id: string, over: Partial<Ticket> = {}): Ticket {
  const [key, n] = id.split("-");
  return {
    id, key, number: Number(n), title: "Untitled", body: "", type: "task", status: "todo", priority: "medium",
    project: "", projectName: "", assignee: "", sessionId: "", reporter: "you", labels: [], due: "",
    rank: Number(n), created: "2026-09-10T09:00:00", updated: "2026-09-10T09:00:00", closed: "", activity: [], ...over,
  };
}

const TICKETS: Ticket[] = [
  ticket("DC-1", { title: "Fix the export button", status: "in_progress", type: "bug", priority: "high", project: DRAWCAL, projectName: "drawcal", assignee: "exporter", sessionId: "eng22222-blocked", labels: ["safari"] }),
  ticket("DC-2", { title: "Review auth refactor", status: "review", project: DRAWCAL, projectName: "drawcal", assignee: "Refactor auth", sessionId: "eng11111-working" }),
  ticket("DC-3", { title: "Export to PDF", status: "done", project: DRAWCAL, projectName: "drawcal", closed: "2026-09-12T10:00:00" }),
  ticket("MLG-1", { title: "Write module 6 quiz", status: "todo", project: MLG, projectName: "mlguerilla", body: "Ten questions, multiple choice.", due: "2026-09-20" }),
  ticket("GEN-1", {
    title: "Export the newsletter list", status: "backlog",
    activity: [
      { at: "2026-09-10T09:00:00", who: "you", kind: "created" },
      { at: "2026-09-11T10:30:00", who: "you", kind: "moved", from: "todo", to: "backlog" },
      { at: "2026-09-11T10:31:00", who: "you", kind: "commented", text: "Later, after launch." },
    ],
  }),
];

// ---------- a stand-in Agent Grid that behaves like web.py and tickets.py ----------

function fakeGrid(token = "tok", start: Ticket[] = TICKETS) {
  const calls: string[] = [];
  let tickets = start.map((t) => ({ ...t, labels: [...t.labels], activity: [...t.activity] }));
  const projects = [DRAWCAL, MLG];
  const next: Record<string, number> = { DC: 3, MLG: 1, GEN: 1 };
  const STATUSES = ["backlog", "todo", "in_progress", "review", "done"];
  const board = () => ({
    tickets,
    statuses: STATUSES.map((key) => ({ key, label: key, count: tickets.filter((t) => t.status === key).length })),
    unassigned: tickets.filter((t) => !t.assignee && t.status !== "done").length,
  });
  const keyFor = (project: string) => (project === DRAWCAL ? "DC" : project === MLG ? "MLG" : "GEN");

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers["x-agentgrid-token"] !== token) return send(403, { error: "Bad or missing token." });
    const path = new URL(req.url ?? "/", "http://x").pathname;
    calls.push(`${req.method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
    const find = (id: string) => tickets.find((t) => t.id === id);
    const reply = (t: Ticket, message?: string, extra: object = {}) => send(200, { ok: true, ticket: t, board: board(), ...(message ? { message } : {}), ...extra });

    if (path === "/api/sessions") return send(200, { sessions: SESSIONS });
    if (path === "/api/areas") return send(200, AREAS);
    if (path === "/api/projects") return send(200, { projects: projects.map((p) => ({ path: p })) });
    if (path === "/api/tickets") return send(200, board());
    if (path === "/api/tickets/create") {
      if (!String(body.title ?? "").trim()) return send(400, { error: "A ticket needs a title." });
      const key = keyFor(body.project ?? "");
      next[key] = (next[key] ?? 0) + 1;
      const t = ticket(`${key}-${next[key]}`, {
        title: body.title, body: body.body ?? "", type: body.type ?? "task", status: body.status ?? "todo",
        priority: body.priority ?? "medium", project: body.project ?? "", assignee: body.assignee ?? "",
        labels: body.labels ?? [], due: body.due ?? "", activity: [{ at: "2026-09-16T09:00:00", who: "you", kind: "created" }],
      });
      tickets.push(t);
      return reply(t, `Filed ${t.id}.`);
    }
    const t = find(String(body?.id ?? ""));
    if (path === "/api/tickets/delete") {
      if (!t) return send(404, { error: `No such ticket: ${body?.id}` });
      tickets = tickets.filter((x) => x !== t);
      return send(200, { ok: true, board: board() });
    }
    if (path.startsWith("/api/tickets/") && !t) return send(400, { error: `No such ticket: ${body?.id}` });
    if (path === "/api/tickets/update") {
      const editable = ["title", "body", "type", "priority", "labels", "project", "due"];
      const fields = Object.keys(body).filter((k) => editable.includes(k));
      if (!fields.length) return send(400, { error: "Nothing to change." });
      for (const k of fields) (t as unknown as Record<string, unknown>)[k] = body[k];
      return reply(t!);
    }
    if (path === "/api/tickets/move") {
      if (!STATUSES.includes(body.status)) return send(400, { error: "Unknown status." });
      t!.activity.push({ at: "2026-09-16T09:00:00", who: "you", kind: "moved", from: t!.status, to: body.status });
      t!.status = body.status;
      return reply(t!);
    }
    if (path === "/api/tickets/assign") {
      const session = SESSIONS.find((s) => s.sessionId === body.sessionId);
      if (body.sessionId && !session) return send(404, { error: "That session is no longer on the board." });
      t!.assignee = session ? (session.customName || session.title) : body.assignee;
      t!.sessionId = body.sessionId ?? "";
      if (body.start) t!.status = "in_progress";
      if (session && body.notify !== false) return reply(t!, `${t!.id} handed to ${t!.assignee}.`, { told: true });
      return reply(t!, t!.assignee ? `${t!.id} assigned to ${t!.assignee}.` : `${t!.id} unassigned.`, { told: false });
    }
    if (path === "/api/tickets/comment") {
      if (!String(body.text ?? "").trim()) return send(400, { error: "A comment needs text." });
      t!.activity.push({ at: "2026-09-16T09:00:00", who: "you", kind: "commented", text: body.text });
      return reply(t!);
    }
    if (path === "/api/spawn") return send(200, { ok: true, message: `Started ${body.engine}.` });
    return send(404, { error: "No such route." });
  });
  return { server, calls, tickets: () => tickets };
}

// ---------- pure logic ----------

describe("reading what someone says about the board", () => {
  it("takes statuses the way people say them", () => {
    expect(parseStatus("in review")).toBe("review");
    expect(parseStatus("In Progress")).toBe("in_progress");
    expect(parseStatus("doing")).toBe("in_progress");
    expect(parseStatus("to do")).toBe("todo");
    expect(parseStatus("finished")).toBe("done");
    expect(parseStatus("later")).toBe("backlog");
    expect(parseStatus("backlog")).toBe("backlog");
    expect(parseStatus("sometime")).toBeNull();
    expect(parseStatus("")).toBeNull();
  });

  it("takes types, priorities and ids loosely, and nothing else", () => {
    expect(parseType("Bug")).toBe("bug");
    expect(parseType("feature")).toBeNull();
    expect(parsePriority("critical")).toBe("urgent");
    expect(parsePriority("HIGH")).toBe("high");
    expect(parsePriority("whenever")).toBeNull();
    expect(normalizeTicketId("dc-12")).toBe("DC-12");
    expect(normalizeTicketId("#MLG-03")).toBe("MLG-3");
    expect(normalizeTicketId("DC12")).toBe("DC-12");
    expect(normalizeTicketId("A1-4")).toBe("A1-4"); // a key with a digit needs its hyphen
    expect(normalizeTicketId("dc - 7")).toBe("DC-7");
    expect(normalizeTicketId("fix the export")).toBeNull();
  });
});

describe("the work area hierarchy", () => {
  const tree = areaTree(AREAS, SESSIONS);

  it("puts each agent under its area, and the rest under none", () => {
    const eng = tree.areas.find((n) => n.area.id === "engineering")!;
    expect(eng.agents.map((a) => a.sessionId)).toEqual(["eng11111-working", "eng22222-blocked", "eng33333-done"]);
    expect(tree.areas.find((n) => n.area.name === "MLG")!.agents.map((a) => a.title)).toEqual(["Module 6 quiz"]);
    expect(tree.areas.find((n) => n.area.name === "Marketing")!.agents).toEqual([]);
    // Filed under an area that was deleted: that agent is unfiled now, not lost.
    expect(tree.unfiled.map((a) => a.sessionId)).toEqual(["free5555-working", "free6666-done"]);
    // A member whose session has ended is counted, not invented.
    expect(tree.ended).toBe(1);
  });

  it("finds an area by name, loosely, and says when it can't", () => {
    expect(findArea(AREAS.areas, "engineering")).toMatchObject({ id: "engineering" });
    expect(findArea(AREAS.areas, "mark")).toMatchObject({ id: "marketing" });
    expect(findArea(AREAS.areas, "3e13a2642214")).toMatchObject({ name: "MLG" });
    expect(findArea(AREAS.areas, "Sales")).toMatchObject({ error: expect.stringContaining("Engineering, Marketing, MLG") });
    expect(findArea([...AREAS.areas, { id: "m2", name: "Media", prompt: "" }], "m")).toMatchObject({ error: expect.stringContaining("could be") });
  });

  it("lists what is running, counts what is finished, and shows who needs the user", () => {
    const text = formatAreaTree(tree, TICKETS);
    expect(text).toContain("Engineering (2 running, 1 needs you, 1 finished)");
    expect(text).toContain("exporter (eng22222, codex) — needs you, in drawcal · holds DC-1");
    expect(text).toContain("Refactor auth (eng11111, claude) — working, in drawcal · holds DC-2");
    expect(text).not.toContain("Old spike"); // finished: counted, not listed
    expect(text).toContain("Marketing (no agents)");
    expect(text).toContain("MLG (1 running)");
    expect(text).toContain("Not in any work area: 1 running, 1 finished");
    expect(text).toContain("Loose research");
    expect(text).not.toContain("Finished thing");
  });
});

describe("finding and listing tickets", () => {
  it("finds a ticket by id in any spelling, or by title words", () => {
    expect(findTicket(TICKETS, "dc-1")).toMatchObject({ id: "DC-1" });
    expect(findTicket(TICKETS, "quiz")).toMatchObject({ id: "MLG-1" });
    expect(findTicket(TICKETS, "DC-99")).toMatchObject({ error: "There's no ticket DC-99 on the board." });
    expect(findTicket(TICKETS, "nothing like this")).toMatchObject({ error: expect.stringContaining("No ticket matches") });
    // Three titles say export; two are open. Still ambiguous, and it says which.
    expect(findTicket(TICKETS, "export")).toMatchObject({ error: expect.stringMatching(/matches 3 tickets: DC-1 .*Which one\?/) });
    // Only one open ticket says "export pdf"… it's done, so the done one is found as the only match.
    expect(findTicket(TICKETS, "export pdf")).toMatchObject({ id: "DC-3" });
  });

  it("prefers the open ticket when the same words also match a closed one", () => {
    const withDone = [...TICKETS, ticket("DC-9", { title: "Fix the export button", status: "done" })];
    expect(findTicket(withDone, "fix export button")).toMatchObject({ id: "DC-1" });
  });

  it("filters by status, person, project, area and words, and leaves done out unless asked", () => {
    const ids = (f: Parameters<typeof filterTickets>[1]) => filterTickets(TICKETS, f).map((t) => t.id);
    expect(ids({})).toEqual(["DC-1", "DC-2", "MLG-1", "GEN-1"]);
    expect(ids({ includeDone: true })).toHaveLength(5);
    expect(ids({ status: "done" })).toEqual(["DC-3"]);
    expect(ids({ status: "review" })).toEqual(["DC-2"]);
    expect(ids({ assignee: "none" })).toEqual(["MLG-1", "GEN-1"]);
    expect(ids({ assignee: "export" })).toEqual(["DC-1"]);
    expect(ids({ project: "mlguerilla" })).toEqual(["MLG-1"]);
    expect(ids({ query: "safari" })).toEqual(["DC-1"]);
    expect(ids({ query: "multiple choice" })).toEqual(["MLG-1"]);
    const eng = areaTree(AREAS, SESSIONS).areas.find((n) => n.area.id === "engineering");
    expect(ids({ area: eng })).toEqual(["DC-1", "DC-2"]);
  });

  it("lists by column and says what is waiting on the user", () => {
    const list = formatTickets(TICKETS);
    expect(list.split("\n").map((l) => l.split(" ")[1])).toEqual(["GEN-1", "MLG-1", "DC-1", "DC-2", "DC-3"]);
    expect(list).toContain("- DC-1 Fix the export button [In progress, high, bug] → exporter · drawcal");
    expect(list).toContain("- MLG-1 Write module 6 quiz [To do] · unassigned · mlguerilla · due 2026-09-20");
    expect(formatTickets(TICKETS, 2)).toContain("…and 3 more");
    expect(formatTickets([])).toBe("No tickets match.");

    const summary = formatBoardSummary(TICKETS);
    expect(summary).toContain("Backlog: 1 · To do: 1 · In progress: 1 · In review: 1 · Done: 1");
    expect(summary).toContain("Waiting on your review: DC-2 Review auth refactor");
    expect(summary).toContain("2 open tickets have nobody on them.");
    expect(formatBoardSummary([])).toBe("The ticket board is empty.");
  });

  it("shows one ticket in full, with its history", () => {
    const text = formatTicket(TICKETS[4]);
    expect(text).toContain("GEN-1 — Export the newsletter list");
    expect(text).toContain("Status: Backlog · task · medium priority");
    expect(text).toContain("Assignee: nobody");
    expect(text).toContain("2026-09-11 10:30 you moved todo → backlog");
    expect(text).toContain("you commented: Later, after launch.");
    expect(formatTicket(TICKETS[0])).toContain("(live agent eng22222)");
  });
});

// ---------- the client, the tools and the server, against the stand-in ----------

describe("Agent Grid work areas and tickets, end to end", () => {
  let fake: ReturnType<typeof fakeGrid>;
  let base: string;
  const grid = () => new AgentGrid(() => ({ base, token: "tok" }));
  const cfg = () => loadConfig({ COS_SELFHUB: "/tmp/cos-grid-unused", COS_PROJECT_ROOTS: "/nonexistent" });
  const runtime = (agents: Access["agents"], awaiting?: ToolRuntime["pending"]) =>
    new ToolRuntime(cfg(), "2026-09-16", undefined, {
      agentGrid: grid(),
      access: () => ({ terminal: "ask", agents, links: "auto", screen: "auto", browser: "ask" }),
      ...(awaiting ? { awaiting } : {}),
    });
  const writes = () => fake.calls.filter((c) => c.startsWith("POST /api/tickets/") || c.startsWith("POST /api/spawn"));

  beforeEach(async () => {
    fake = fakeGrid();
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => fake.server.close(r));
  });

  it("sends each call to the right route, with the token", async () => {
    const g = grid();
    expect((await g.areas()).areas.map((a) => a.name)).toEqual(["Engineering", "Marketing", "MLG"]);
    expect((await g.board()).tickets).toHaveLength(5);
    await g.createTicket({ title: "New one", priority: "high" });
    await g.updateTicket("DC-1", { priority: "urgent" });
    await g.moveTicket("DC-1", "review", "DC-2");
    await g.assignTicket("DC-1", { sessionId: "mlg44444-working", start: true });
    await g.commentTicket("DC-1", "Looks good");
    await g.deleteTicket("GEN-1");
    await g.start({ task: "Do DC-1", areaId: "engineering", ticketId: "DC-1" });
    expect(writes()).toEqual([
      'POST /api/tickets/create {"title":"New one","priority":"high"}',
      'POST /api/tickets/update {"id":"DC-1","priority":"urgent"}',
      'POST /api/tickets/move {"id":"DC-1","status":"review","before":"DC-2"}',
      'POST /api/tickets/assign {"id":"DC-1","sessionId":"mlg44444-working","assignee":"","start":true,"notify":true}',
      'POST /api/tickets/comment {"id":"DC-1","text":"Looks good"}',
      'POST /api/tickets/delete {"id":"GEN-1"}',
      'POST /api/spawn {"prompt":"Do DC-1","engine":"claude","name":"","interactive":false,"areaId":"engineering","ticketKey":"DC-1","noProject":true}',
    ]);
    expect(g.pageUrl()).toBe(`${base}/?t=tok`);
    await expect(new AgentGrid(() => ({ base, token: "wrong" })).board()).rejects.toThrow(/token|rejected/i);
  });

  it("shows the hierarchy and the board through the assistant's tools", async () => {
    const rt = runtime("ask");
    const areas = (await rt.execute("get_work_areas", {})).result;
    expect(areas).toContain("Engineering (2 running, 1 needs you, 1 finished)");
    expect(areas).toContain("holds DC-1");
    expect(areas).toContain("Tickets — Backlog: 1 · To do: 1");
    const one = (await rt.execute("get_work_areas", { area: "mlg" })).result;
    expect(one).toContain("MLG (1 running)");
    expect(one).not.toContain("Engineering");
    expect((await rt.execute("get_work_areas", { area: "Sales" })).result).toMatch(/No work area called "Sales"/);

    expect((await rt.execute("get_tickets", {})).result).toMatch(/^4 of 5 tickets:/);
    expect((await rt.execute("get_tickets", { status: "in review" })).result).toContain("DC-2 Review auth refactor");
    expect((await rt.execute("get_tickets", { area: "engineering" })).result).toMatch(/^2 of 5 tickets:/);
    expect((await rt.execute("get_tickets", { ticket: "quiz" })).result).toContain("Ten questions, multiple choice.");
    expect((await rt.execute("get_tickets", { status: "someday" })).result).toMatch(/isn't a column/);
    // Reading changes nothing.
    expect(writes()).toEqual([]);
  });

  it("waits for an OK in ask mode, and then does exactly what was approved", async () => {
    const rt = runtime("ask");
    const r = await rt.execute("change_ticket", { action: "create", title: "Fix Safari export", type: "bug", priority: "urgent", project: "drawcal", labels: ["safari"], due: "2026-09-30" });
    expect(r.result).toMatch(/^Not done yet\. Ask them .*new ticket: Fix Safari export/);
    expect(writes()).toEqual([]); // nothing filed yet
    expect(rt.pending).toHaveLength(1);
    expect(rt.pending[0]).toMatchObject({ kind: "ticket", verb: "File ticket" });
    expect(rt.pending[0].detail).toContain("bug, urgent priority, in drawcal, labels safari, due 2026-09-30");

    // The OK arrives: what runs is the resolved plan, project path and all.
    const approved = take(rt.pending[0].id)!;
    expect(await performPending(approved, { agentGrid: grid() })).toBe("Filed DC-4: Fix Safari export.");
    expect(writes()).toEqual([
      `POST /api/tickets/create {"title":"Fix Safari export","type":"bug","priority":"urgent","project":"${DRAWCAL}","labels":["safari"],"due":"2026-09-30"}`,
    ]);
  });

  it("goes ahead in auto mode: move, edit, comment, and hand to a running agent", async () => {
    const rt = runtime("auto");
    expect((await rt.execute("change_ticket", { action: "move", ticket: "dc-1", status: "review" })).result).toBe("DC-1 is in In review now.");
    expect((await rt.execute("change_ticket", { action: "edit", ticket: "DC-1", priority: "urgent", due: "none" })).result).toBe("Updated DC-1.");
    expect((await rt.execute("change_ticket", { action: "comment", ticket: "quiz", text: "Use the new rubric." })).result).toBe("Commented on MLG-1.");
    expect((await rt.execute("change_ticket", { action: "assign", ticket: "MLG-1", agent: "module 6", start: true })).result).toBe("MLG-1 handed to Module 6 quiz.");
    expect(fake.tickets().find((t) => t.id === "MLG-1")).toMatchObject({ assignee: "Module 6 quiz", sessionId: "mlg44444-working", status: "in_progress" });
    expect((await rt.execute("change_ticket", { action: "assign", ticket: "MLG-1", assignee: "none" })).result).toBe("MLG-1 unassigned.");
    expect(rt.pending).toHaveLength(0);
    expect(rt.done.map((d) => d.kind)).toEqual(["ticket", "ticket", "ticket", "ticket", "ticket"]);
  });

  it("files a ticket and hands it to an agent in one go", async () => {
    const rt = runtime("auto");
    const r = await rt.execute("change_ticket", { action: "create", title: "Profile the export", agent: "exporter" });
    expect(r.result).toBe("Filed GEN-2: Profile the export. GEN-2 handed to exporter.");
    expect(writes().map((c) => c.split(" {")[0])).toEqual(["POST /api/tickets/create", "POST /api/tickets/assign"]);
  });

  it("always asks before deleting, even in auto", async () => {
    const rt = runtime("auto");
    const r = await rt.execute("change_ticket", { action: "delete", ticket: "GEN-1" });
    expect(r.result).toMatch(/Ask them .*delete GEN-1 — say it can't be undone/);
    expect(writes()).toEqual([]);
    expect(rt.pending[0]).toMatchObject({ verb: "Delete ticket" });
    expect(rt.pending[0].detail).toContain("for good (Backlog, 3 history entries)");
    expect(await performPending(take(rt.pending[0].id)!, { agentGrid: grid() })).toBe('Deleted GEN-1 ("Export the newsletter list").');
    expect(fake.tickets().map((t) => t.id)).not.toContain("GEN-1");
  });

  it("refuses when agents are off, and says what's wrong with a bad request before anything happens", async () => {
    expect((await runtime("off").execute("get_tickets", {})).result).toMatch(/off/i);
    expect((await runtime("off").execute("change_ticket", { action: "create", title: "x" })).result).toMatch(/off/i);

    const rt = runtime("auto");
    const said = async (input: Record<string, unknown>) => (await rt.execute("change_ticket", input)).result;
    expect(await said({ action: "archive", ticket: "DC-1" })).toMatch(/action must be one of create, edit, move, assign, comment, delete/);
    expect(await said({ action: "create", title: "" })).toMatch(/needs a title/);
    expect(await said({ action: "create", title: "x", due: "next friday" })).toMatch(/YYYY-MM-DD/);
    expect(await said({ action: "create", title: "x", type: "feature" })).toMatch(/isn't a ticket type/);
    expect(await said({ action: "create", title: "x", project: "nonesuch" })).toMatch(/doesn't know a project called "nonesuch"/);
    expect(await said({ action: "create", title: "x", project: "/etc" })).toMatch(/inside the home folder/);
    expect(await said({ action: "move", ticket: "DC-1" })).toMatch(/Say which column/);
    expect(await said({ action: "move", ticket: "DC-1", status: "in progress" })).toMatch(/already in In progress/);
    expect(await said({ action: "edit", ticket: "DC-1" })).toMatch(/Nothing to change/);
    expect(await said({ action: "assign", ticket: "DC-1" })).toMatch(/Say who/);
    expect(await said({ action: "assign", ticket: "DC-1", agent: "nobody-like-this" })).toMatch(/No session|no session|matches/i);
    expect(await said({ action: "comment", ticket: "DC-1", text: "" })).toMatch(/needs text/);
    expect(await said({ action: "edit", ticket: "DC-77", priority: "low" })).toMatch(/no ticket DC-77/);
    expect(writes()).toEqual([]);
  });

  it("starts an agent in a work area, on a ticket, and the OK covers both", async () => {
    const rt = runtime("ask");
    const r = await rt.execute("start_agent", { task: "Fix the Safari export", area: "engineering", ticket: "DC-1" });
    expect(r.result).toMatch(/^Not started yet/);
    expect(rt.pending[0].detail).toContain("in Engineering, on DC-1");
    await performPending(take(rt.pending[0].id)!, { agentGrid: grid() });
    expect(writes()).toEqual([
      'POST /api/spawn {"prompt":"Fix the Safari export","engine":"claude","name":"","interactive":false,"areaId":"engineering","ticketKey":"DC-1","noProject":true}',
    ]);
    expect((await runtime("auto").execute("start_agent", { task: "x", area: "Sales" })).result).toMatch(/No work area called/);
  });

  it("gives the menu the hierarchy and the board, and files a ticket from it", async () => {
    const server = createUiServer({ config: cfg(), today: "2026-09-16", offline: true, allowSpeech: false, agentGrid: grid() });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const view = await (await fetch(`${url}/api/grid`)).json();
      expect(view.connected).toBe(true);
      expect(view.areas.find((a: { name: string }) => a.name === "Engineering")).toMatchObject({ running: 2, needYou: 1, finished: 1 });
      expect(view.areas[0].agents.map((a: { name: string }) => a.name)).toEqual(["Refactor auth", "exporter"]);
      expect(view.areas[0].agents[1]).toMatchObject({ needsYou: true, tickets: ["DC-1"] });
      expect(view.unfiled).toMatchObject({ running: 1, finished: 1 });
      expect(view.tickets).toMatchObject({ open: 4, unassigned: 2, review: [{ id: "DC-2", title: "Review auth refactor" }] });
      expect(view.actions.map((a: { title: string }) => a.title)).toEqual(["New ticket…", "Open Agent Grid"]);
      expect(view.actions[1].url).toBe(`${base}/?t=tok`);

      const filed = await (await fetch(`${url}/api/grid/tickets/new`, { method: "POST", body: JSON.stringify({ value: "Rename the export menu" }) })).json();
      expect(filed).toMatchObject({ ok: true, message: "Filed GEN-2", ticket: "GEN-2" });
      expect((await fetch(`${url}/api/grid/tickets/new`, { method: "POST", body: JSON.stringify({ value: "  " }) })).status).toBe(400);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("tells the menu plainly when Agent Grid isn't there", async () => {
    const gone = new AgentGrid(() => {
      throw new Error("Agent Grid isn't running. Start it with `python3 -m agentgrid --web` from ~/AgentGrid.");
    });
    const server = createUiServer({ config: cfg(), today: "2026-09-16", offline: true, allowSpeech: false, agentGrid: gone });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const view = await (await fetch(`${url}/api/grid`)).json();
      expect(view).toMatchObject({ connected: false, error: expect.stringContaining("isn't running"), actions: [] });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
