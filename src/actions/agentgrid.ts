/**
 * Agent Grid, for the assistant: see your Claude and Codex sessions, start new
 * ones on a task, read what they did, and message them.
 *
 * Agent Grid mints a new token each run. It writes {url, token, pid} to
 * ~/.agentgrid/web.json (owner-only) when it starts; AGENTGRID_URL
 * (http://127.0.0.1:8787/?t=…) overrides that. Every call is loopback only.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Connection {
  base: string;
  token: string;
}

export interface AgentSession {
  sessionId: string;
  title: string;
  status: string;
  project?: string;
  cwd?: string;
  engine?: string;
  idleSeconds?: number;
  prompt?: string;
  customName?: string;
}

export class AgentGridError extends Error {}

export function connectionFile(): string {
  return join(homedir(), ".agentgrid", "web.json");
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || pid <= 0) return true; // no pid recorded: let the request decide
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Where Agent Grid is and its key, or a plain reason it can't be reached. */
export function findConnection(env: NodeJS.ProcessEnv = process.env, file: string = connectionFile()): Connection {
  if (env.AGENTGRID_URL) {
    const u = new URL(env.AGENTGRID_URL);
    const token = u.searchParams.get("t") ?? env.AGENTGRID_TOKEN ?? "";
    if (!token) throw new AgentGridError("AGENTGRID_URL has no ?t= token.");
    return { base: `${u.protocol}//${u.host}`, token };
  }
  let saved: { url?: string; port?: number; token?: string; pid?: number };
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new AgentGridError(
      "Agent Grid hasn't shared its connection yet. Start (or restart) it with `python3 -m agentgrid --web` from ~/AgentGrid; it writes ~/.agentgrid/web.json when it starts.",
    );
  }
  if (!saved.token) throw new AgentGridError(`${file} has no token. Restart Agent Grid.`);
  if (!alive(saved.pid)) throw new AgentGridError("Agent Grid isn't running. Start it with `python3 -m agentgrid --web` from ~/AgentGrid.");
  const base = saved.url ? new URL(saved.url).origin : `http://127.0.0.1:${saved.port ?? 8787}`;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new AgentGridError(`Refusing to talk to a non-local Agent Grid at ${base}.`);
  return { base, token: saved.token };
}

export type Fetcher = typeof fetch;

export class AgentGrid {
  constructor(
    private readonly connect: () => Connection = () => findConnection(),
    private readonly fetcher: Fetcher = fetch,
  ) {}

  private async call<T>(path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const { base, token } = this.connect();
    let res: Response;
    try {
      res = await this.fetcher(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "X-Agentgrid-Token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const why = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name;
      throw new AgentGridError(
        why === "ECONNREFUSED"
          ? "Agent Grid isn't running. Start it with `python3 -m agentgrid --web` from ~/AgentGrid."
          : `Couldn't reach Agent Grid (${why}).`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (res.status === 403) throw new AgentGridError("Agent Grid rejected the key: it was probably restarted. Restart it once more so it shares the new one, or check ~/.agentgrid/web.json.");
    if (!res.ok) throw new AgentGridError(data.error ?? `Agent Grid answered ${res.status}.`);
    return data;
  }

  async sessions(): Promise<AgentSession[]> {
    const r = await this.call<{ sessions?: AgentSession[]; error?: string | null }>("/api/sessions");
    return r.sessions ?? [];
  }

  async projects(): Promise<string[]> {
    const r = await this.call<{ projects?: { path: string }[] }>("/api/projects");
    return (r.projects ?? []).map((p) => p.path);
  }

  /** Start an agent in a folder (added to Agent Grid's projects, and created, if new), or on the Desktop with no folder. */
  async start(o: { task: string; folder?: string; engine?: "claude" | "codex"; name?: string; visible?: boolean }): Promise<string> {
    const engine = o.engine === "codex" ? "codex" : "claude";
    const spawn: Record<string, unknown> = { prompt: o.task, engine, name: o.name ?? "", interactive: Boolean(o.visible) };
    if (o.folder) {
      const cwd = resolve(o.folder.replace(/^~(?=$|\/)/, homedir()));
      const known = await this.projects();
      let path = cwd;
      if (!known.includes(cwd)) {
        const added = await this.call<{ path?: string }>("/api/projects/add", { path: cwd, create: true });
        path = added.path ?? cwd;
      }
      spawn.cwd = path;
    } else {
      spawn.noProject = true;
    }
    const r = await this.call<{ message?: string }>("/api/spawn", spawn, 90_000);
    return r.message ?? `Started ${engine}.`;
  }

  async transcript(sessionId: string): Promise<Array<{ kind: string; text?: string; name?: string; gist?: string; error?: boolean }>> {
    const r = await this.call<{ blocks?: Array<{ kind: string; text?: string; name?: string; gist?: string; error?: boolean }> }>(
      `/api/transcript?id=${encodeURIComponent(sessionId)}`,
    );
    return r.blocks ?? [];
  }

  async message(sessionId: string, message: string): Promise<void> {
    await this.call("/api/chat", { sessionId, message });
  }
}

// ---------- finding and describing sessions ----------

const STATUS_WORDS: Record<string, string> = { blocked: "needs you", working: "working", idle: "idle", done: "done", stopped: "stopped" };

function idle(seconds?: number): string {
  if (seconds === undefined) return "";
  if (seconds < 90) return "just now";
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} days ago`;
}

export function findSession(sessions: AgentSession[], ref: string): AgentSession | { error: string } {
  const want = ref.trim().toLowerCase();
  const exact = sessions.find((s) => s.sessionId === ref.trim() || s.sessionId.startsWith(ref.trim()));
  if (exact && ref.trim().length >= 6) return exact;
  const named = sessions.filter((s) => [s.title, s.customName, s.project].some((v) => v && v.toLowerCase().includes(want)));
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    const live = named.filter((s) => s.status === "working" || s.status === "blocked");
    if (live.length === 1) return live[0];
    return { error: `"${ref}" matches ${named.length} sessions: ${named.slice(0, 6).map((s) => `${s.title} (${s.sessionId.slice(0, 8)})`).join(", ")}. Use the id.` };
  }
  return { error: `No Agent Grid session matches "${ref}".` };
}

export function tilde(p?: string): string {
  if (!p) return "";
  const home = homedir();
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Sessions for the model: the ones that need you first, then working, then the most recent others. "needs you" means the agent is waiting on the user; read its output to see why. */
export function formatSessions(sessions: AgentSession[], limit = 15): string {
  if (!sessions.length) return "No Agent Grid sessions.";
  const rank = (s: AgentSession) => (s.status === "blocked" ? 0 : s.status === "working" ? 1 : 2);
  const sorted = [...sessions].sort((a, b) => rank(a) - rank(b) || (a.idleSeconds ?? 0) - (b.idleSeconds ?? 0));
  const count = (st: string) => sessions.filter((s) => s.status === st).length;
  const shown = sorted.slice(0, limit);
  return [
    `${sessions.length} session${sessions.length === 1 ? "" : "s"}: ${count("blocked")} need you, ${count("working")} working.${sessions.length > shown.length ? ` Showing ${shown.length}: all that need you or are working come first.` : ""}`,
    ...shown.map((s) =>
      `- ${s.title || s.customName || "untitled"} [${STATUS_WORDS[s.status] ?? s.status}] ${s.engine ?? "claude"} in ${tilde(s.cwd) || s.project || "?"}, last active ${idle(s.idleSeconds)} (id ${s.sessionId.slice(0, 8)})${s.prompt ? `\n  the user's last message to it: ${s.prompt.replace(/\s+/g, " ").slice(0, 140)}` : ""}`,
    ),
  ].join("\n");
}

/** The end of a session's transcript as text, with how much was left out stated. */
export function formatTranscript(session: AgentSession, blocks: Awaited<ReturnType<AgentGrid["transcript"]>>, maxChars = 10_000): string {
  const lines = blocks
    .filter((b) => b.kind !== "thinking")
    .map((b) => {
      if (b.kind === "tool") return `[${b.name}] ${b.gist ?? ""}`.trim();
      if (b.kind === "result") return `${b.error ? "[error] " : "→ "}${(b.text ?? "").slice(0, 600)}`;
      return `${b.kind === "user" ? "Asked" : b.kind === "assistant" ? "Agent" : b.kind}: ${b.text ?? ""}`;
    });
  const kept: string[] = [];
  let size = 0;
  for (const line of [...lines].reverse()) {
    if (kept.length && size + line.length > maxChars) break;
    kept.unshift(line);
    size += line.length;
  }
  const head = `${session.title || "Session"} [${STATUS_WORDS[session.status] ?? session.status}] in ${tilde(session.cwd)}`;
  const note = kept.length < lines.length ? `Showing the last ${kept.length} of ${lines.length} entries.` : `${lines.length} entries.`;
  return [head, note, ...kept].join("\n");
}
