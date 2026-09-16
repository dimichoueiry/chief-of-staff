import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Access } from "../src/actions/access.js";
import {
  AgentGrid, findConnection, findSession, formatModels, formatSessions, formatTranscript, resolveModel, runsOn, type AgentSession, type ModelCatalog,
} from "../src/actions/agentgrid.js";
import { confirmView, take } from "../src/actions/pending.js";
import { performPending } from "../src/actions/perform.js";
import type { Shell } from "../src/actions/terminal.js";
import { ToolRuntime } from "../src/brain/tools.js";
import { loadConfig } from "../src/config.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

const SESSIONS: AgentSession[] = [
  { sessionId: "aaaa1111-done", title: "Refactor auth", status: "done", project: "drawcal", cwd: `${homedir()}/Desktop/drawcal`, engine: "claude", model: "claude-opus-5", idleSeconds: 7200 },
  { sessionId: "bbbb2222-blocked", title: "Module 6 quiz", status: "blocked", project: "mlguerilla", cwd: `${homedir()}/Documents/GitHub/mlguerilla`, engine: "claude", idleSeconds: 300, prompt: "Write the module 6 quiz" },
  { sessionId: "cccc3333-working", title: "Fix export", status: "working", project: "drawcal", cwd: `${homedir()}/Desktop/drawcal`, engine: "codex", idleSeconds: 20 },
];

/** GET /api/models as Agent Grid answers it on a Mac that has used these. */
const MODELS: ModelCatalog = {
  claude: [
    ["", "Default"], ["fable", "Fable (alias)"], ["opus", "Opus (alias)"], ["sonnet", "Sonnet (alias)"], ["haiku", "Haiku (alias)"],
    ["claude-fable-5-1", "Claude Fable 5.1"], ["claude-fable-5-1[1m]", "Claude Fable 5.1 (1M context)"], ["claude-opus-5", "Claude Opus 5"],
    ["claude-opus-4-8", "Claude Opus 4.8"], ["claude-opus-4-7", "Claude Opus 4.7"], ["claude-haiku-4-5-20251001", "Claude Haiku 4.5 (2025-10-01)"],
  ],
  codex: [["", "Default"], ["gpt-6-astra", "GPT-6-Astra"], ["gpt-5.6-sol", "GPT-5.6-Sol"], ["gpt-5.6-terra", "GPT-5.6-Terra"], ["gpt-5.5", "GPT-5.5"]],
};

/** A stand-in for Agent Grid's HTTP API: token-gated, recording what it was asked. */
function fakeAgentGrid(token = "tok", o: { models?: boolean } = {}) {
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
      return send(200, { ok: true, message: `Started ${body.engine} in ${String(body.cwd ?? "Desktop").split("/").pop()}${body.model ? ` on ${body.model}` : ""}.` });
    }
    if (url.pathname === "/api/models" && o.models !== false) return send(200, { models: MODELS });
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

  it("passes a chosen model to the launch, and none when there isn't one", async () => {
    const grid = new AgentGrid(() => ({ base, token: "tok" }));
    expect(await grid.start({ task: "fix it", folder: "~/Desktop/drawcal", model: "claude-opus-5" })).toBe("Started claude in drawcal on claude-opus-5.");
    expect(fake.calls.at(-1)).toBe(
      `POST /api/spawn {"prompt":"fix it","engine":"claude","name":"","interactive":false,"model":"claude-opus-5","cwd":"${homedir()}/Desktop/drawcal"}`,
    );
    await grid.start({ task: "fix it", folder: "~/Desktop/drawcal", model: "" });
    expect(fake.calls.at(-1)).not.toContain("model");
  });

  it("reads the model list, and says nothing when Agent Grid is too old to have one", async () => {
    expect(await new AgentGrid(() => ({ base, token: "tok" })).models()).toEqual(MODELS);
    const old = fakeAgentGrid("tok", { models: false });
    await new Promise<void>((r) => old.server.listen(0, "127.0.0.1", r));
    try {
      const oldBase = `http://127.0.0.1:${(old.server.address() as AddressInfo).port}`;
      expect(await new AgentGrid(() => ({ base: oldBase, token: "tok" })).models()).toBeNull();
      await expect(new AgentGrid(() => ({ base: oldBase, token: "wrong" })).models()).rejects.toThrow(/rejected the key/);
    } finally {
      await new Promise((r) => old.server.close(r));
    }
  });

  it("shows which model a session runs on once its replies say", () => {
    expect(runsOn({ engine: "claude", model: "claude-opus-5" })).toBe("claude on claude-opus-5");
    expect(runsOn({ engine: "codex", model: "codex" })).toBe("codex");
    expect(runsOn({ engine: "claude", model: "<synthetic>" })).toBe("claude");
    expect(runsOn({})).toBe("claude");
    expect(formatSessions(SESSIONS)).toContain("- Refactor auth [done] claude on claude-opus-5 in ~/Desktop/drawcal");
  });

  describe("choosing a model", () => {
    const ok = (said: string, engine?: "claude" | "codex") => {
      const r = resolveModel(MODELS, said, engine);
      if ("error" in r) throw new Error(r.error);
      return [r.engine, r.model, r.note ?? ""];
    };
    const refused = (said: string, engine?: "claude" | "codex", catalog: ModelCatalog | null = MODELS) => {
      const r = resolveModel(catalog, said, engine);
      return "error" in r ? r.error : `resolved to ${r.model}`;
    };

    it("takes a model as it was said", () => {
      expect(ok("Claude Opus 5")).toEqual(["claude", "claude-opus-5", ""]);
      expect(ok("opus 5")).toEqual(["claude", "claude-opus-5", ""]);
      expect(ok("claude-opus-5")).toEqual(["claude", "claude-opus-5", ""]);
      expect(ok("CLAUDE-OPUS-5")).toEqual(["claude", "claude-opus-5", ""]);
      expect(ok("Opus 4.8")).toEqual(["claude", "claude-opus-4-8", ""]);
      expect(ok("fable 5.1")).toEqual(["claude", "claude-fable-5-1", ""]);
      expect(ok("Fable 5.1 1M context")).toEqual(["claude", "claude-fable-5-1[1m]", ""]);
      expect(ok("haiku 4.5")).toEqual(["claude", "claude-haiku-4-5-20251001", ""]);
      expect(ok("the latest opus")).toEqual(["claude", "opus", ""]);
      expect(ok("Sonnet")).toEqual(["claude", "sonnet", ""]);
      expect(ok("default")).toEqual(["claude", undefined, ""]);
      expect(ok("", "codex")).toEqual(["codex", undefined, ""]);
    });

    it("works out the engine from the model", () => {
      expect(ok("gpt 5.5")).toEqual(["codex", "gpt-5.5", ""]);
      expect(ok("GPT-5.6-Sol")).toEqual(["codex", "gpt-5.6-sol", ""]);
      expect(ok("sol")).toEqual(["codex", "gpt-5.6-sol", ""]);
      expect(ok("astra", "codex")).toEqual(["codex", "gpt-6-astra", ""]);
    });

    it("refuses a model of the other engine, and asks when a name fits several", () => {
      expect(refused("Opus 5", "codex")).toBe("claude-opus-5 (Claude Opus 5) is a Claude model; start a claude agent for it, or pick a Codex model.");
      expect(refused("gpt-5.5", "claude")).toMatch(/^gpt-5.5 is a Codex model/);
      expect(refused("claude-opus-9", "codex")).toMatch(/^claude-opus-9 looks like a Claude model/);
      expect(refused("opus 4")).toBe('"opus 4" could be claude-opus-4-8 (Claude Opus 4.8), claude-opus-4-7 (Claude Opus 4.7). Say which.');
      expect(refused("gpt 5.6")).toBe('"gpt 5.6" could be gpt-5.6-sol, gpt-5.6-terra. Say which.');
    });

    it("passes an ID it hasn't seen through, saying so, but not a name it can't place", () => {
      expect(ok("claude-sonnet-5")).toEqual(["claude", "claude-sonnet-5", "claude-sonnet-5 isn't one this Mac has used yet; if the CLI doesn't know it, Agent Grid says so when the agent starts."]);
      expect(ok("Sonnet 5")[1]).toBe("claude-sonnet-5");
      expect(ok("gpt-7")[0]).toBe("codex");
      expect(ok("my-proxy-model", "codex")[0]).toBe("codex");
      expect(ok("claude-opus-5", undefined)[2]).toBe("");
      expect(resolveModel(null, "Claude Opus 5")).toEqual({
        engine: "claude",
        model: "claude-opus-5",
        note: "This Agent Grid can't list its models, so claude-opus-5 goes to the CLI as given.",
      });
      expect(refused("something smart", "codex")).toBe(
        'No Codex model called "something smart". There\'s gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.5.',
      );
      expect(refused("--dangerously-skip-permissions")).toMatch(/^No model called/);
    });

    it("lists the models by engine, IDs first", () => {
      const text = formatModels(MODELS);
      expect(text.split("\n")[0]).toBe(
        "Claude: fable (Fable, alias), opus (Opus, alias), sonnet (Sonnet, alias), haiku (Haiku, alias), claude-fable-5-1 (Claude Fable 5.1), " +
          "claude-fable-5-1[1m] (Claude Fable 5.1, 1M context), claude-opus-5 (Claude Opus 5), claude-opus-4-8 (Claude Opus 4.8), " +
          "claude-opus-4-7 (Claude Opus 4.7), claude-haiku-4-5-20251001 (Claude Haiku 4.5, 2025-10-01).",
      );
      expect(text.split("\n")[1]).toBe("Codex: gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.5.");
      expect(formatModels(MODELS, "codex")).not.toContain("Claude:");
      expect(formatModels({ claude: [["", "Default"]], codex: [] }, "codex")).toMatch(/^Codex: no models listed\./);
    });
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
      const ask = runtime({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser: "ask" });
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

      const auto = runtime({ terminal: "ask", agents: "auto", links: "auto", screen: "auto", browser: "ask" });
      expect((await auto.execute("start_agent", { task: "fix it", folder: "~/Desktop/drawcal" })).result).toBe("Started claude in drawcal.");
      expect((await auto.execute("start_agent", { task: "x", folder: "/etc" })).isError).toBe(true);

      const off = runtime({ terminal: "off", agents: "off", links: "auto", screen: "auto", browser: "ask" });
      expect((await off.execute("get_agents", {})).result).toMatch(/Agent Grid access is off/);
      expect((await off.execute("run_command", { command: "ls" })).result).toMatch(/Terminal access is off/);
    });

    it("starts an agent on the model the user named, and says which before the OK", async () => {
      const ask = runtime({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser: "ask" });
      const queued = await ask.execute("start_agent", { task: "review the export code", folder: "~/Desktop/drawcal", model: "Claude Opus 5" });
      expect(queued.result).toBe(
        "Not started yet. Ask them in one short sentence whether to start it, saying what the agent will do and that it runs on Claude Opus 5. They can just say yes.",
      );
      expect(ask.pending[0].detail).toBe("claude on claude-opus-5 in ~/Desktop/drawcal\nTask: review the export code");
      expect(fake.calls.some((c) => c.includes("/api/spawn"))).toBe(false);
      const p = take(ask.pending[0].id)!;
      expect(await performPending(p, { agentGrid: new AgentGrid(() => ({ base, token: "tok" })) })).toBe("Started claude in drawcal on claude-opus-5.");
      expect(fake.calls.at(-1)).toContain('"engine":"claude","name":"","interactive":false,"model":"claude-opus-5"');

      const auto = runtime({ terminal: "ask", agents: "auto", links: "auto", screen: "auto", browser: "ask" });
      expect((await auto.execute("start_agent", { task: "fix it", folder: "~/Desktop/drawcal", model: "gpt 5.5" })).result).toBe("Started codex in drawcal on gpt-5.5.");
      // Agent Grid checked the unlisted model when it started it, so there is nothing left to warn about.
      expect((await auto.execute("start_agent", { task: "fix it 2", folder: "~/Desktop/drawcal", model: "claude-sonnet-5" })).result).toBe(
        "Started claude in drawcal on claude-sonnet-5.",
      );
      expect((await ask.execute("start_agent", { task: "fix it 2", folder: "~/Desktop/drawcal", model: "claude-sonnet-5" })).result).toMatch(
        /They can just say yes\. claude-sonnet-5 isn't one this Mac has used yet; if the CLI doesn't know it, Agent Grid says so when the agent starts\.$/,
      );
      const wrong = await auto.execute("start_agent", { task: "fix it 3", engine: "codex", model: "opus 5" });
      expect(wrong.isError).toBe(true);
      expect(wrong.result).toMatch(/is a Claude model/);
      expect((await auto.execute("start_agent", { task: "fix it 4", model: "opus 4" })).result).toMatch(/could be/);
      expect(fake.calls.filter((c) => c.startsWith("POST /api/spawn"))).toHaveLength(3);
    });

    it("with an Agent Grid too old to list models, passes the model on and says it wasn't checked", async () => {
      const old = fakeAgentGrid("tok", { models: false });
      await new Promise<void>((r) => old.server.listen(0, "127.0.0.1", r));
      try {
        const oldBase = `http://127.0.0.1:${(old.server.address() as AddressInfo).port}`;
        const rt = new ToolRuntime(loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }), "2026-09-15", undefined, {
          agentGrid: new AgentGrid(() => ({ base: oldBase, token: "tok" })),
          access: () => ({ terminal: "ask", agents: "auto", links: "auto", screen: "auto", browser: "ask" }),
        });
        expect((await rt.execute("start_agent", { task: "fix it", folder: "~/Desktop/drawcal", model: "Claude Opus 5" })).result).toBe(
          "Started claude in drawcal on claude-opus-5. This Agent Grid can't list its models, so claude-opus-5 goes to the CLI as given.",
        );
        expect((await rt.execute("get_agent_models", {})).result).toMatch(/^This Agent Grid can't list its models/);
      } finally {
        await new Promise((r) => old.server.close(r));
      }
    });

    it("lists the models agents can use", async () => {
      const ask = runtime({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser: "ask" });
      expect((await ask.execute("get_agent_models", {})).result).toBe(formatModels(MODELS));
      expect((await ask.execute("get_agent_models", { engine: "codex" })).result).toBe(formatModels(MODELS, "codex"));
      const off = runtime({ terminal: "off", agents: "off", links: "auto", screen: "auto", browser: "ask" });
      expect((await off.execute("get_agent_models", {})).result).toMatch(/Agent Grid access is off/);
    });

    it("never queues the same thing twice, and lets the model carry out what's waiting only as its first step", async () => {
      const ask = runtime({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser: "ask" });
      await ask.execute("message_agent", { session: "quiz", message: "multiple choice" });
      const waiting = ask.pending.map(confirmView);

      // The next message: the same request again is recognised, not queued a second time.
      const next = new ToolRuntime(loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }), "2026-09-15", undefined, {
        agentGrid: new AgentGrid(() => ({ base, token: "tok" })), access: () => ({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser: "ask" }), awaiting: waiting,
      });
      expect((await next.execute("message_agent", { session: "quiz", message: "multiple choice" })).result).toMatch(/already waiting for their OK/);
      expect(next.pending).toHaveLength(0);

      // confirm_pending after reading anything else is refused, and nothing is sent.
      expect((await next.execute("confirm_pending", { decision: "yes" })).isError).toBe(true);
      expect(fake.calls.some((c) => c.startsWith("POST /api/chat"))).toBe(false);

      const fresh = new ToolRuntime(loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }), "2026-09-15", undefined, {
        agentGrid: new AgentGrid(() => ({ base, token: "tok" })), access: () => ({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser: "ask" }), awaiting: waiting,
      });
      const r = await fresh.execute("confirm_pending", { decision: "yes" });
      expect(r.result).toBe("Done, as they said (already done: do not do it again): message to Module 6 quiz. Result: Sent to Module 6 quiz.");
      expect(fake.calls.filter((c) => c.startsWith("POST /api/chat"))).toHaveLength(1);
      expect(fresh.done).toEqual([{ kind: "agent-message", detail: waiting[0].detail }]);
      expect((await fresh.execute("confirm_pending", { decision: "yes" })).result).toMatch(/^Nothing is waiting/);
      expect((await fresh.execute("message_agent", { session: "quiz", message: "multiple choice" })).result).toMatch(/already done a moment ago/);
    });

    it("runs safe commands, queues changes (or runs them in auto), always queues risky ones, refuses blocked", async () => {
      const ran: string[] = [];
      const shell: Shell = async (command) => {
        ran.push(command);
        return { exitCode: 0, timedOut: false, output: `ran ${command}` };
      };
      const ask = runtime({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser: "ask" }, shell);
      expect((await ask.execute("run_command", { command: "ls ~" })).result).toMatch(/^\$ ls ~\n\(in ~; exit 0;/);
      expect((await ask.execute("run_command", { command: "mkdir -p ~/cos-tools" })).result).toMatch(/^Not run yet \(mkdir can change things\)\. Ask them/);
      expect(ask.pending[0]).toMatchObject({ kind: "command", verb: "Run", detail: "$ mkdir -p ~/cos-tools\nin ~" });
      expect((await ask.execute("run_command", { command: "sudo ls" })).result).toMatch(/^Error: Refused: never runs: it needs an administrator password/);
      expect((await ask.execute("run_command", { command: "ls", cwd: "~/definitely-not-here-xyz" })).isError).toBe(true);
      expect(ran).toEqual(["ls ~"]);

      const auto = runtime({ terminal: "auto", agents: "ask", links: "auto", screen: "auto", browser: "ask" }, shell);
      await auto.execute("run_command", { command: "mkdir -p ~/cos-tools" });
      expect(ran.at(-1)).toBe("mkdir -p ~/cos-tools");
      expect((await auto.execute("run_command", { command: "rm -rf ~/cos-tools/tmp" })).result).toMatch(/^Not run yet \(it deletes files\)/);

      const p = take(ask.pending[0].id)!;
      expect(await performPending(p, { shell })).toMatch(/^\$ mkdir -p ~\/cos-tools\n\(in ~; exit 0;/);
      expect(take(p.id)).toBeNull();
    });
  });
});
