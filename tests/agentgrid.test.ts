import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Access } from "../src/actions/access.js";
import { AgentGrid, findConnection, findSession, formatSessions, formatTranscript, type AgentSession } from "../src/actions/agentgrid.js";
import { take } from "../src/actions/pending.js";
import { performPending } from "../src/actions/perform.js";
import type { Shell } from "../src/actions/terminal.js";
import { ToolRuntime } from "../src/brain/tools.js";
import { loadConfig } from "../src/config.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

const SESSIONS: AgentSession[] = [
  { sessionId: "aaaa1111-done", title: "Refactor auth", status: "done", project: "drawcal", cwd: `${homedir()}/Desktop/drawcal`, engine: "claude", idleSeconds: 7200 },
  { sessionId: "bbbb2222-blocked", title: "Module 6 quiz", status: "blocked", project: "mlguerilla", cwd: `${homedir()}/Documents/GitHub/mlguerilla`, engine: "claude", idleSeconds: 300, prompt: "Write the module 6 quiz" },
  { sessionId: "cccc3333-working", title: "Fix export", status: "working", project: "drawcal", cwd: `${homedir()}/Desktop/drawcal`, engine: "codex", idleSeconds: 20 },
];

/** A stand-in for Agent Grid's HTTP API: token-gated, recording what it was asked. */
function fakeAgentGrid(token = "tok") {
  const calls: string[] = [];
  const projects = [`${homedir()}/Desktop/drawcal`];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers["x-agentgrid-token"] !== token) return send(403, { error: "Bad or missing token." });
    const url = new URL(req.url ?? "/", "http://x");
    calls.push(`${req.method} ${url.pathname}${url.search}${body ? ` ${JSON.stringify(body)}` : ""}`);
    if (url.pathname === "/api/sessions") return send(200, { sessions: SESSIONS });
    if (url.pathname === "/api/projects") return send(200, { projects: projects.map((path) => ({ path })) });
    if (url.pathname === "/api/projects/add") {
      projects.push(body.path);
      return send(200, { ok: true, path: body.path });
    }
    if (url.pathname === "/api/spawn") {
      if (!body.noProject && !projects.includes(body.cwd)) return send(400, { error: "That directory is not one of the known projects." });
      return send(200, { ok: true, message: `Started ${body.engine} in ${String(body.cwd ?? "Desktop").split("/").pop()}.` });
    }
    if (url.pathname === "/api/transcript") {
      return send(200, {
        blocks: [
          { kind: "user", text: "Write the module 6 quiz" },
          { kind: "thinking" },
          { kind: "tool", name: "Write", gist: "content/module-6/quiz.md" },
          { kind: "result", text: "File written" },
          { kind: "assistant", text: "Drafted 10 questions. Should answers be multiple choice or open?" },
        ],
      });
    }
    if (url.pathname === "/api/chat") return send(200, { ok: true });
    return send(404, { error: "No such route." });
  });
  return { server, calls };
}

describe("Agent Grid client", () => {
  let fake: ReturnType<typeof fakeAgentGrid>;
  let base: string;
  let dir: string;
  beforeEach(async () => {
    fake = fakeAgentGrid();
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), "cos-ag-"));
  });
  afterEach(async () => {
    await new Promise((r) => fake.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("finds Agent Grid from its connection file or AGENTGRID_URL, and explains when it can't", async () => {
    const file = join(dir, "web.json");
    expect(() => findConnection({}, file)).toThrow(/hasn't shared its connection yet/);
    await writeFile(file, JSON.stringify({ url: base, token: "tok", pid: process.pid }));
    expect(findConnection({}, file)).toEqual({ base, token: "tok" });
    await writeFile(file, JSON.stringify({ url: base, token: "tok", pid: 999_999_999 }));
    expect(() => findConnection({}, file)).toThrow(/isn't running/);
    await writeFile(file, JSON.stringify({ url: "http://evil.example:8787", token: "tok" }));
    expect(() => findConnection({}, file)).toThrow(/non-local/);
    expect(findConnection({ AGENTGRID_URL: `${base}/?t=abc` }, file)).toEqual({ base, token: "abc" });

    await expect(new AgentGrid(() => ({ base, token: "wrong" })).sessions()).rejects.toThrow(/rejected the key/);
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const gone = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise((r) => closed.close(r));
    await expect(new AgentGrid(() => ({ base: gone, token: "tok" })).sessions()).rejects.toThrow(/isn't running/);
  });

  it("lists who needs you first, finds sessions by name, and reads a transcript's end", async () => {
    const grid = new AgentGrid(() => ({ base, token: "tok" }));
    const sessions = await grid.sessions();
    const text = formatSessions(sessions);
    expect(text.split("\n")[0]).toBe("3 sessions: 1 need you, 1 working.");
    expect(text.split("\n")[1]).toBe("- Module 6 quiz [needs you] claude in ~/Documents/GitHub/mlguerilla, last active 5 min ago (id bbbb2222)");
    expect(text).toContain("  the user's last message to it: Write the module 6 quiz");
    expect(text.indexOf("Fix export")).toBeLessThan(text.indexOf("Refactor auth"));

    expect(findSession(sessions, "quiz")).toMatchObject({ sessionId: "bbbb2222-blocked" });
    expect(findSession(sessions, "drawcal")).toMatchObject({ sessionId: "cccc3333-working" }); // two match; one is live
    expect(findSession(sessions, "kubernetes")).toEqual({ error: 'No Agent Grid session matches "kubernetes".' });

    const quiz = findSession(sessions, "bbbb2222") as AgentSession;
    const t = formatTranscript(quiz, await grid.transcript(quiz.sessionId));
    expect(t).toBe(
      "Module 6 quiz [needs you] in ~/Documents/GitHub/mlguerilla\n4 entries.\nAsked: Write the module 6 quiz\n[Write] content/module-6/quiz.md\n→ File written\nAgent: Drafted 10 questions. Should answers be multiple choice or open?",
    );
    expect(formatTranscript(quiz, await grid.transcript(quiz.sessionId), 80)).toContain("Showing the last 1 of 4 entries.");
  });

  it("starts agents in known folders, adds new ones first, or runs with no project", async () => {
    const grid = new AgentGrid(() => ({ base, token: "tok" }));
    expect(await grid.start({ task: "fix the export bug", folder: "~/Desktop/drawcal" })).toBe("Started claude in drawcal.");
    expect(await grid.start({ task: "build a csv tool", folder: "~/cos-tools", engine: "codex", name: "csv tool" })).toBe("Started codex in cos-tools.");
    expect(fake.calls.filter((c) => !c.startsWith("GET"))).toEqual([
      `POST /api/spawn {"prompt":"fix the export bug","engine":"claude","name":"","interactive":false,"cwd":"${homedir()}/Desktop/drawcal"}`,
      `POST /api/projects/add {"path":"${homedir()}/cos-tools","create":true}`,
      `POST /api/spawn {"prompt":"build a csv tool","engine":"codex","name":"csv tool","interactive":false,"cwd":"${homedir()}/cos-tools"}`,
    ]);
    expect(await grid.start({ task: "summarise my week" })).toBe("Started claude in Desktop.");
    expect(fake.calls.at(-1)).toContain('"noProject":true');
  });

  describe("as tools, with access modes", () => {
    let selfhub: string;
    let cleanup: () => Promise<void>;
    beforeEach(async () => ({ dir: selfhub, cleanup } = await makeTmpSelfhub()));
    afterEach(() => cleanup());

    const runtime = (access: Access, shell?: Shell) =>
      new ToolRuntime(loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }), "2026-09-15", undefined, {
        agentGrid: new AgentGrid(() => ({ base, token: "tok" })),
        access: () => access,
        shell,
      });

    it("reads agents freely; starting and messaging wait for an OK in ask mode and run in auto; off refuses", async () => {
      const ask = runtime({ terminal: "ask", agents: "ask" });
      expect((await ask.execute("get_agents", {})).result).toMatch(/^3 sessions: 1 need you/);
      expect((await ask.execute("get_agent_output", { session: "quiz" })).result).toContain("Should answers be multiple choice");

      const queued = await ask.execute("start_agent", { task: "write the module 6 lesson outline", folder: "~/Documents/GitHub/mlguerilla", name: "m6 outline" });
      expect(queued.result).toMatch(/^Not started yet/);
      expect(ask.pending.map((p) => [p.kind, p.verb, p.label])).toEqual([["agent-start", "Start agent", "claude agent: m6 outline"]]);
      expect(ask.pending[0].detail).toBe("claude in ~/Documents/GitHub/mlguerilla\nTask: write the module 6 lesson outline");
      expect(fake.calls.some((c) => c.includes("/api/spawn"))).toBe(false);

      const msg = await ask.execute("message_agent", { session: "quiz", message: "multiple choice" });
      expect(msg.result).toMatch(/^Not sent yet/);
      const p = take(ask.pending[1].id)!;
      expect(await performPending(p, { agentGrid: new AgentGrid(() => ({ base, token: "tok" })) })).toBe("Sent to Module 6 quiz.");
      expect(fake.calls.at(-1)).toBe('POST /api/chat {"sessionId":"bbbb2222-blocked","message":"multiple choice"}');

      const auto = runtime({ terminal: "ask", agents: "auto" });
      expect((await auto.execute("start_agent", { task: "fix it", folder: "~/Desktop/drawcal" })).result).toBe("Started claude in drawcal.");
      expect((await auto.execute("start_agent", { task: "x", folder: "/etc" })).isError).toBe(true);

      const off = runtime({ terminal: "off", agents: "off" });
      expect((await off.execute("get_agents", {})).result).toMatch(/Agent Grid access is off/);
      expect((await off.execute("run_command", { command: "ls" })).result).toMatch(/Terminal access is off/);
    });

    it("runs safe commands, queues changes (or runs them in auto), always queues risky ones, refuses blocked", async () => {
      const ran: string[] = [];
      const shell: Shell = async (command) => {
        ran.push(command);
        return { exitCode: 0, timedOut: false, output: `ran ${command}` };
      };
      const ask = runtime({ terminal: "ask", agents: "ask" }, shell);
      expect((await ask.execute("run_command", { command: "ls ~" })).result).toMatch(/^\$ ls ~\n\(in ~; exit 0;/);
      expect((await ask.execute("run_command", { command: "mkdir -p ~/cos-tools" })).result).toMatch(/^Not run yet \(mkdir can change things\)/);
      expect(ask.pending[0]).toMatchObject({ kind: "command", verb: "Run", detail: "$ mkdir -p ~/cos-tools\nin ~" });
      expect((await ask.execute("run_command", { command: "sudo ls" })).result).toMatch(/^Error: Refused: never runs: it needs an administrator password/);
      expect((await ask.execute("run_command", { command: "ls", cwd: "~/definitely-not-here-xyz" })).isError).toBe(true);
      expect(ran).toEqual(["ls ~"]);

      const auto = runtime({ terminal: "auto", agents: "ask" }, shell);
      await auto.execute("run_command", { command: "mkdir -p ~/cos-tools" });
      expect(ran.at(-1)).toBe("mkdir -p ~/cos-tools");
      expect((await auto.execute("run_command", { command: "rm -rf ~/cos-tools/tmp" })).result).toMatch(/^Not run yet \(it deletes files\)/);

      const p = take(ask.pending[0].id)!;
      expect(await performPending(p, { shell })).toMatch(/^\$ mkdir -p ~\/cos-tools\n\(in ~; exit 0;/);
      expect(take(p.id)).toBeNull();
    });
  });
});
