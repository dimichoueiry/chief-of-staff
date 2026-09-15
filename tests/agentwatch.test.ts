import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGrid, type AgentSession } from "../src/actions/agentgrid.js";
import { AgentWatch, describeFinish, lastSaid, loadWatchState, saveWatchState, watchAgents, type AgentFinished } from "../src/actions/agentwatch.js";

const home = homedir();
const session = (over: Partial<AgentSession>): AgentSession => ({
  sessionId: "aaaa1111-2222-3333", title: "Refactor auth", status: "working", project: "drawcal", cwd: `${home}/Desktop/drawcal`, engine: "claude", idleSeconds: 5, ...over,
});

describe("AgentWatch", () => {
  it("announces a session once when it stops working, whatever it settles into", () => {
    const w = new AgentWatch();
    expect(w.observe([session({})])).toEqual([]); // the first look only records
    expect(w.observe([session({})])).toEqual([]);
    expect(w.observe([session({ status: "done" })]).map((s) => s.status)).toEqual(["done"]);
    expect(w.observe([session({ status: "done" })])).toEqual([]); // seen again: nothing new
    expect(w.observe([session({ status: "done", idleSeconds: 900 })])).toEqual([]);
    // Back to work and finished again is a second finish.
    expect(w.observe([session({ status: "working" })])).toEqual([]);
    expect(w.observe([session({ status: "blocked" })]).map((s) => s.status)).toEqual(["blocked"]);
    expect(w.observe([session({ status: "working" })])).toEqual([]);
    expect(w.observe([session({ status: "failed" })]).map((s) => s.status)).toEqual(["failed"]);
  });

  it("does not announce sessions that were never seen working, unknown statuses, or stale finishes", () => {
    const w = new AgentWatch();
    w.observe([session({ sessionId: "a", status: "working" }), session({ sessionId: "b", status: "idle" })]);
    expect(w.observe([session({ sessionId: "a", status: "unknown" }), session({ sessionId: "b", status: "done" })])).toEqual([]);
    expect(w.observe([session({ sessionId: "a", status: "done" })])).toEqual([]); // unknown → done: it wasn't seen working

    const stale = new AgentWatch({ a: "working" });
    expect(stale.observe([session({ sessionId: "a", status: "done", idleSeconds: 3 * 3600 })])).toEqual([]);
    const restored = new AgentWatch({ a: "working" });
    expect(restored.observe([session({ sessionId: "a", status: "done", idleSeconds: 60 })]).map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("forgets sessions that are gone, and its state round-trips through a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cos-watch-"));
    try {
      const w = new AgentWatch();
      w.observe([session({ sessionId: "a" }), session({ sessionId: "b", status: "done" })]);
      w.observe([session({ sessionId: "a" })]);
      expect(w.state).toEqual({ a: "working" });
      const file = join(dir, "agent-watch.json");
      saveWatchState(w.state, file);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ a: "working" });
      expect(loadWatchState(file)).toEqual({ a: "working" });
      expect(loadWatchState(join(dir, "missing.json"))).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("describing a finish", () => {
  it("names the agent, where it ran, how it ended and its last words, cut to fit", () => {
    const f: AgentFinished = { session: session({ status: "done" }), word: "done", lastSaid: "Moved the auth code into auth/ and all 42 tests pass." };
    expect(describeFinish(f)).toEqual({
      title: "Refactor auth: done",
      body: "claude in ~/Desktop/drawcal. Moved the auth code into auth/ and all 42 tests pass.",
      line: 'Agent "Refactor auth" (claude in ~/Desktop/drawcal, id aaaa1111) finished: done. It last said: Moved the auth code into auth/ and all 42 tests pass.',
    });
    const long = describeFinish({ session: session({ status: "blocked", engine: "codex", cwd: undefined, project: "mlg" }), word: "needs you", lastSaid: "x".repeat(400) });
    expect(long.title).toBe("Refactor auth: needs you");
    expect(long.body).toBe(`codex in mlg. ${"x".repeat(139)}…`);
    expect(long.line.endsWith(`It last said: ${"x".repeat(299)}…`)).toBe(true);
    expect(describeFinish({ session: session({ status: "stopped", title: "", customName: "csv tool", cwd: undefined, project: undefined }), word: "stopped" })).toEqual({
      title: "csv tool: stopped", body: "claude.", line: 'Agent "csv tool" (claude, id aaaa1111) finished: stopped.',
    });
  });

  it("takes the agent's last words from the end of its transcript, or the error it hit", () => {
    expect(lastSaid([{ kind: "user", text: "do it" }, { kind: "assistant", text: "  Done.\n\nTwo files  changed. " }, { kind: "thinking" }])).toBe("Done. Two files changed.");
    expect(lastSaid([{ kind: "assistant", text: "Starting." }, { kind: "tool", text: "npm test" }, { kind: "result", text: "exit 1", error: true }])).toBe("error: exit 1");
    expect(lastSaid([{ kind: "user", text: "do it" }, { kind: "result", text: "ok" }])).toBeUndefined();
  });
});

describe("watching Agent Grid", () => {
  let dir: string;
  let sessions: AgentSession[];
  let reachable: boolean;
  let transcripts: number;
  const grid = () =>
    new AgentGrid(
      () => ({ base: "http://127.0.0.1:1", token: "t" }),
      async (url) => {
        if (!reachable) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        const path = new URL(String(url)).pathname;
        if (path === "/api/sessions") return Response.json({ sessions });
        if (path === "/api/transcript") {
          transcripts++;
          return Response.json({ blocks: [{ kind: "user", text: "refactor" }, { kind: "assistant", text: "All done, tests pass." }] });
        }
        return Response.json({ error: "no" }, { status: 404 });
      },
    );
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-watch-"));
    sessions = [session({ sessionId: "a", status: "working" }), session({ sessionId: "b", title: "Quiz", status: "idle" })];
    reachable = true;
    transcripts = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("tells about each finish once, with the agent's last words, and remembers across restarts", async () => {
    const told: string[] = [];
    const file = join(dir, "agent-watch.json");
    const w = watchAgents({ grid: grid(), everyMs: 60_000, stateFile: file, onFinished: (_f, said) => void told.push(said.line) });
    await w.tick();
    await w.tick();
    expect(told).toEqual([]);
    sessions[0] = session({ sessionId: "a", status: "done" });
    await w.tick();
    await w.tick();
    expect(told).toEqual(['Agent "Refactor auth" (claude in ~/Desktop/drawcal, id a) finished: done. It last said: All done, tests pass.']);
    expect(transcripts).toBe(1);
    w.stop();

    // The app restarts while an agent works, and it finishes before the next look: still told, once.
    sessions[1] = session({ sessionId: "b", title: "Quiz", status: "working" });
    await w.tick();
    expect(loadWatchState(file)).toEqual({ a: "done", b: "working" });
    const again = watchAgents({ grid: grid(), everyMs: 60_000, stateFile: file, onFinished: (_f, said) => void told.push(said.title) });
    sessions[1] = session({ sessionId: "b", title: "Quiz", status: "blocked" });
    await again.tick();
    await again.tick();
    expect(told.slice(1)).toEqual(["Quiz: needs you"]);
    again.stop();
  });

  it("waits quietly while Agent Grid is down or agents access is off, and never overlaps looks", async () => {
    const told: string[] = [];
    const logged: string[] = [];
    let allowed = true;
    const w = watchAgents({ grid: grid(), everyMs: 60_000, stateFile: null, allowed: () => allowed, log: (l) => logged.push(l), onFinished: (_f, said) => void told.push(said.title) });
    await w.tick();
    reachable = false;
    await w.tick();
    await w.tick();
    expect(logged).toEqual(["agent watch paused: Agent Grid isn't running. Start it with `python3 -m agentgrid --web` from ~/AgentGrid."]);
    reachable = true;
    sessions[0] = session({ sessionId: "a", status: "done" });
    allowed = false;
    await w.tick();
    expect(told).toEqual([]);
    allowed = true;
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    expect(logged.at(-1)).toBe("agent watch: Agent Grid is back");
    expect(told).toEqual(["Refactor auth: done"]);
    w.stop();
  });
});
