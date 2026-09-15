import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGrid, SseParser, type AgentEvent } from "../src/actions/agentgrid.js";
import { describeFinish, lastSaid, watchAgents, type AgentFinished } from "../src/actions/agentwatch.js";
import { loadConfig } from "../src/config.js";
import { createUiServer } from "../src/ui/server.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

const home = homedir();
const event = (over: Partial<AgentEvent>): AgentEvent => ({
  id: "run1-1", type: "status", sessionId: "aaaa1111-2222-3333", title: "Refactor auth", engine: "claude", cwd: `${home}/Desktop/drawcal`, project: "drawcal",
  from: "working", to: "done", finished: true, at: "2026-09-15T18:40:12", ...over,
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 3_000): Promise<void> {
  for (let i = 0; i < ms / 10 && !ok(); i++) await tick();
  expect(ok()).toBe(true);
}

/** A stand-in for Agent Grid with an event stream: token-gated, replaying by Last-Event-ID, dropped on demand. */
function fakeAgentGrid(token = "tok") {
  const log: AgentEvent[] = [];
  const open = new Set<ServerResponse>();
  const lastIds: string[] = [];
  let transcripts = 0;
  let streamRoute = true;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers["x-agentgrid-token"] !== token) return send(403, { error: "Bad or missing token." });
    if (url.pathname === "/api/events" && streamRoute) {
      lastIds.push(String(req.headers["last-event-id"] ?? ""));
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      res.write("retry: 3000\n: connected run1\n\n");
      const after = String(req.headers["last-event-id"] ?? "");
      const n = after.startsWith("run1-") ? Number(after.slice(5)) : 0;
      for (const e of log) if (Number(e.id.slice(5)) > n) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
      open.add(res);
      res.on("close", () => open.delete(res));
      return;
    }
    if (url.pathname === "/api/transcript") {
      transcripts++;
      return send(200, { blocks: [{ kind: "user", text: "refactor" }, { kind: "assistant", text: "All done, tests pass." }] });
    }
    if (url.pathname === "/api/sessions") return send(200, { sessions: [] });
    return send(404, { error: "No such route." });
  });
  return {
    server,
    lastIds,
    get transcripts() {
      return transcripts;
    },
    get connections() {
      return open.size;
    },
    /** Something happened: streamed to every listener and kept for replay. */
    emit(e: AgentEvent) {
      log.push(e);
      for (const res of open) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    },
    ping() {
      for (const res of open) res.write(": ping\n\n");
    },
    /** Agent Grid stopped: every stream ends. */
    drop() {
      for (const res of open) res.end();
      open.clear();
    },
    /** An older Agent Grid without the route. */
    withoutStream() {
      streamRoute = false;
    },
  };
}

describe("SseParser", () => {
  it("reassembles messages from chunks cut anywhere, skips comments, keeps the last id", () => {
    const p = new SseParser();
    expect(p.push("retry: 3000\n: connected\n\nid: r-1\nda")).toEqual([]);
    expect(p.push('ta: {"a":1}\n\r\n')).toEqual([{ id: "r-1", event: undefined, data: '{"a":1}' }]);
    expect(p.push("data: x\ndata: y\n\nevent: note\ndata:z\n\n")).toEqual([
      { id: "r-1", event: undefined, data: "x\ny" },
      { id: "r-1", event: "note", data: "z" },
    ]);
    expect(p.push(": ping\n\n\n")).toEqual([]);
  });
});

describe("describing a finish", () => {
  it("names the agent, where it ran, how it ended and its last words, cut to fit", () => {
    const f: AgentFinished = { event: event({}), word: "done", lastSaid: "Moved the auth code into auth/ and all 42 tests pass." };
    expect(describeFinish(f)).toEqual({
      title: "Refactor auth: done",
      body: "claude in ~/Desktop/drawcal. Moved the auth code into auth/ and all 42 tests pass.",
      speech: "Refactor auth is done.",
      line: 'Agent "Refactor auth" (claude in ~/Desktop/drawcal, id aaaa1111) finished: done. It last said: Moved the auth code into auth/ and all 42 tests pass.',
    });
    const long = describeFinish({ event: event({ to: "blocked", engine: "codex", cwd: "", project: "mlg" }), word: "needs you", lastSaid: "x".repeat(400) });
    expect(long.title).toBe("Refactor auth: needs you");
    expect(long.speech).toBe("Refactor auth needs you.");
    expect(long.body).toBe(`codex in mlg. ${"x".repeat(139)}…`);
    expect(long.line.endsWith(`It last said: ${"x".repeat(299)}…`)).toBe(true);
    expect(describeFinish({ event: event({ to: "stopped", title: "csv tool", cwd: "", project: "" }), word: "stopped" })).toEqual({
      title: "csv tool: stopped", body: "claude.", speech: "csv tool stopped.", line: 'Agent "csv tool" (claude, id aaaa1111) finished: stopped.',
    });
  });

  it("takes the agent's last words from the end of its transcript, or the error it hit", () => {
    expect(lastSaid([{ kind: "user", text: "do it" }, { kind: "assistant", text: "  Done.\n\nTwo files  changed. " }, { kind: "thinking" }])).toBe("Done. Two files changed.");
    expect(lastSaid([{ kind: "assistant", text: "Starting." }, { kind: "tool", text: "npm test" }, { kind: "result", text: "exit 1", error: true }])).toBe("error: exit 1");
    expect(lastSaid([{ kind: "user", text: "do it" }, { kind: "result", text: "ok" }])).toBeUndefined();
  });
});

describe("Agent Grid's event stream", () => {
  let fake: ReturnType<typeof fakeAgentGrid>;
  let base: string;
  const grid = (token = "tok") => new AgentGrid(() => ({ base, token }));
  beforeEach(async () => {
    fake = fakeAgentGrid();
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    fake.drop();
    fake.server.closeAllConnections(); // undici keeps idle sockets; closing would otherwise wait on them
    await new Promise((r) => fake.server.close(r));
  });

  it("yields events as they come, ends when Agent Grid closes, and explains refusals", async () => {
    const got: string[] = [];
    let opened = false;
    const reading = (async () => {
      for await (const e of grid().events({ onOpen: () => (opened = true) })) got.push(`${e.id} ${e.title} ${e.from}→${e.to}`);
    })();
    await until(() => opened);
    fake.emit(event({ id: "run1-1" }));
    fake.ping();
    fake.emit(event({ id: "run1-2", from: "done", to: "working", finished: false }));
    await until(() => got.length === 2);
    fake.drop();
    await reading; // ended quietly
    expect(got).toEqual(["run1-1 Refactor auth working→done", "run1-2 Refactor auth done→working"]);

    // Reconnecting with the last id seen replays only what came after it.
    const later: string[] = [];
    fake.emit(event({ id: "run1-3", from: "working", to: "failed" }));
    const again = (async () => {
      for await (const e of grid().events({ lastEventId: "run1-1" })) later.push(e.id);
    })();
    await until(() => later.length === 2);
    fake.drop();
    await again;
    expect(later).toEqual(["run1-2", "run1-3"]);
    expect(fake.lastIds).toEqual(["", "run1-1"]);

    await expect(grid("wrong").events().next()).rejects.toThrow(/rejected the key/);
    fake.withoutStream();
    await expect(grid().events().next()).rejects.toThrow(/has no event stream/);
  });

  it("treats silence beyond the heartbeat as a drop, and stops at once when asked", async () => {
    await expect(
      (async () => {
        for await (const _ of grid().events({ idleMs: 60 })) void _;
      })(),
    ).rejects.toThrow(/went quiet/);

    const control = new AbortController();
    let opened = false;
    const reading = (async () => {
      for await (const _ of grid().events({ signal: control.signal, onOpen: () => (opened = true) })) void _;
    })();
    await until(() => opened);
    control.abort();
    await reading; // no throw
    await until(() => fake.connections === 0);
  });

  describe("watching for finishes", () => {
    it("announces each finish once with the agent's last words, ignores the rest, and never repeats a replayed one", async () => {
      const told: string[] = [];
      const w = watchAgents({ grid: grid(), retryMs: 20, onFinished: (_f, said) => void told.push(said.line) });
      await until(() => fake.connections === 1);
      fake.emit(event({ id: "run1-1", from: "idle", to: "working", finished: false }));
      fake.emit(event({ id: "run1-2" }));
      fake.emit(event({ id: "run1-3", from: "working", to: "unknown", finished: false }));
      await until(() => told.length === 1);
      expect(told).toEqual(['Agent "Refactor auth" (claude in ~/Desktop/drawcal, id aaaa1111) finished: done. It last said: All done, tests pass.']);
      expect(fake.transcripts).toBe(1);

      // Agent Grid restarts: the stream drops, it reconnects from the last id, and a finish that landed meanwhile is told once.
      fake.drop();
      fake.emit(event({ id: "run1-4", title: "Quiz", to: "blocked" }));
      await until(() => told.length === 2);
      expect(told[1]).toMatch(/^Agent "Quiz" .* finished: needs you\./);
      expect(fake.lastIds).toEqual(["", "run1-3"]);
      await tick(50);
      expect(told).toHaveLength(2);
      w.stop();
      await w.done;
      await until(() => fake.connections === 0);
    });

    it("waits while Agent Grid is down, saying so once, and hangs up when agents access is off", async () => {
      const logged: string[] = [];
      let allowed = true;
      const told: string[] = [];
      const closed = createServer();
      await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
      const gone = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
      await new Promise((r) => closed.close(r));
      let where = gone;
      const w = watchAgents({ grid: new AgentGrid(() => ({ base: where, token: "tok" })), retryMs: 20, allowed: () => allowed, log: (l) => logged.push(l), onFinished: (_f, said) => void told.push(said.title) });
      await until(() => logged.length === 1);
      await tick(60); // several more tries: no more lines
      expect(logged).toEqual(["agent watch paused: Agent Grid isn't running. Start it with `python3 -m agentgrid --web` from ~/AgentGrid."]);
      where = base; // it's back (the connection is read again on every try)
      await until(() => fake.connections === 1);
      expect(logged.at(-1)).toBe("agent watch: listening to Agent Grid again");

      allowed = false;
      fake.emit(event({ id: "run1-1" })); // arrives while off: not announced
      await tick(30);
      expect(told).toEqual([]);
      w.stop();
      await w.done;
      await until(() => fake.connections === 0);
      expect(fake.lastIds).toEqual([""]);
    });

    it("from the UI server: a notification and a line in the conversation, once, while it listens", async () => {
      const { dir: selfhub, cleanup } = await makeTmpSelfhub();
      const home = await mkdtemp(join(tmpdir(), "cos-home-"));
      process.env.COS_HOME = home;
      const told: string[] = [];
      const spoken: string[] = [];
      const server = createUiServer({
        config: loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }),
        today: "2026-09-15", offline: true, allowSpeech: false, backgroundSummaries: false,
        speaker: async (text, o) => {
          spoken.push(`${text} (cues: ${Object.entries(o.cues ?? {}).filter(([, on]) => on).map(([c]) => c).join(",") || "none"})`);
          return { engine: "say", pieces: 1, stopped: false, cued: [] };
        },
        agentGrid: grid(),
        agentWatch: {
          retryMs: 20,
          notifier: async (title, body) => {
            told.push(`${title} — ${body}`);
            return true;
          },
        },
      });
      try {
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const port = (server.address() as AddressInfo).port;
        await until(() => fake.connections === 1);
        fake.emit(event({ id: "run1-1" }));
        await until(() => told.length === 1);
        fake.emit(event({ id: "run1-1" })); // the same event again: nothing
        await tick(50);
        expect(told).toEqual(["Refactor auth: done — claude in ~/Desktop/drawcal. All done, tests pass."]);
        expect(spoken).toEqual(["Refactor auth is done. (cues: none)"]);
        const c = (await (await fetch(`http://127.0.0.1:${port}/api/conversation`)).json()) as { turns: { role: string; text: string }[] };
        expect(c.turns.map((t) => [t.role, t.text])).toEqual([
          ["event", 'Agent "Refactor auth" (claude in ~/Desktop/drawcal, id aaaa1111) finished: done. It last said: All done, tests pass.'],
        ]);
        server.closeIdleConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await until(() => fake.connections === 0);
        fake.emit(event({ id: "run1-2", title: "Quiz" }));
        await tick(50);
        expect(told).toHaveLength(1); // closed: it stopped listening
      } finally {
        server.close();
        delete process.env.COS_HOME;
        await rm(home, { recursive: true, force: true });
        await cleanup();
      }
    });
  });
});
