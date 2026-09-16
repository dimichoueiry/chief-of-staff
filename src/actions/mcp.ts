/**
 * Talking to a connection's MCP server: connect, ask what it can do, hang up.
 *
 * Everything here is on a clock. A connection is somebody else's program or somebody else's
 * website, and neither is allowed to make the app wait: every call has a timeout, a failure comes
 * back as words rather than an exception escaping into a conversation, and a server that dies is
 * simply a connection that isn't working right now.
 */
import { setTimeout as delay } from "node:timers/promises";
import { homeEnvFile, parseEnv } from "../util/env.js";
import { readFileSync } from "node:fs";
import type { Connection } from "./connections.js";

/** One tool a server offers. */
export interface RemoteTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as the server gave it. */
  parameters: Record<string, unknown>;
  /** The server said this one only reads. Absent means it didn't say. */
  readOnly?: boolean;
}

export interface Probe {
  ok: boolean;
  /** What the server called itself. */
  server?: string;
  tools: RemoteTool[];
  /** Why it didn't work, in words someone can act on. */
  error?: string;
  ms: number;
}

export const CONNECT_TIMEOUT_MS = 20_000;

/** The values from ~/.cos/.env a connection is allowed to see: only the ones it named. */
export function envFor(connection: Connection, file: string = homeEnvFile()): Record<string, string> {
  const wanted = connection.env ?? [];
  if (!wanted.length) return {};
  let values = new Map<string, string>();
  try {
    values = parseEnv(readFileSync(file, "utf8"));
  } catch {
    /* no file yet */
  }
  const out: Record<string, string> = {};
  for (const name of wanted) {
    const value = values.get(name) ?? process.env[name];
    if (value) out[name] = value;
  }
  return out;
}

/** A description trimmed to something a model can read without the tool list ballooning. */
export function trimDescription(text: string, max = 300): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** `notion__search`: namespaced so two servers can both have a "search". */
export function toolName(connectionId: string, tool: string): string {
  return `${connectionId}__${tool}`;
}

/** Split a namespaced name back into its parts, or null when it isn't one. */
export function splitToolName(name: string): { connectionId: string; tool: string } | null {
  const at = name.indexOf("__");
  if (at <= 0) return null;
  return { connectionId: name.slice(0, at), tool: name.slice(at + 2) };
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  const bell = new AbortController();
  try {
    return await Promise.race([
      work,
      delay(ms, undefined, { signal: bell.signal }).then(() => {
        throw new Error(`${what} took longer than ${Math.round(ms / 1000)} s`);
      }),
    ]);
  } finally {
    bell.abort();
  }
}

/** A connected client plus how to let go of it. */
export interface Session {
  server?: string;
  tools: RemoteTool[];
  call(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}

/**
 * Open a session with one connection. The caller decides what to do with a failure; nothing here
 * throws into a conversation by itself.
 */
export async function connect(connection: Connection, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Session> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "chief-of-staff", version: "1" });

  let transport;
  if (connection.transport === "http") {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    if (!connection.url) throw new Error("This connection has no address.");
    transport = new StreamableHTTPClientTransport(new URL(connection.url));
  } else {
    const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    if (!connection.command) throw new Error("This connection has no program to run.");
    transport = new StdioClientTransport({
      command: connection.command,
      args: connection.args ?? [],
      env: { ...getDefaultEnvironment(), ...envFor(connection) },
      stderr: "ignore",
    });
  }

  await withTimeout(client.connect(transport), timeoutMs, "connecting");
  const listed = await withTimeout(client.listTools(), timeoutMs, "asking what it can do");
  const tools: RemoteTool[] = (listed.tools ?? []).map((t) => ({
    name: t.name,
    description: trimDescription(t.description ?? ""),
    parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    ...(typeof t.annotations?.readOnlyHint === "boolean" ? { readOnly: t.annotations.readOnlyHint } : {}),
  }));

  return {
    server: client.getServerVersion()?.name,
    tools,
    async call(tool, args, ms = timeoutMs) {
      const res = await withTimeout(client.callTool({ name: tool, arguments: args }), ms, tool);
      const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
      return text || JSON.stringify(res.structuredContent ?? res) || "(nothing came back)";
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}

/**
 * Connect, note what it offers, hang up: what the settings window shows after Save, and what
 * "Check" does later. Never throws; a failure is part of the answer.
 */
export async function probe(connection: Connection, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Probe> {
  const started = Date.now();
  let session: Session | null = null;
  try {
    session = await connect(connection, timeoutMs);
    return { ok: true, server: session.server, tools: session.tools, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, tools: [], error: explain(err, connection), ms: Date.now() - started };
  } finally {
    await session?.close();
  }
}

/** Everything an error knows, including what fetch hides in its cause. */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let at: unknown = err;
  for (let depth = 0; at && depth < 5; depth++) {
    const e = at as { message?: string; code?: string; cause?: unknown };
    if (e.message) parts.push(String(e.message).split("\n")[0]);
    if (e.code) parts.push(String(e.code));
    at = e.cause;
  }
  return parts.join(" ");
}

/** Turn whatever went wrong into the next thing to try. */
export function explain(err: unknown, connection: Connection): string {
  // "fetch failed" on its own tells nobody anything; the reason is one level down, in the cause.
  const raw = errorText(err) || String(err);
  if (/ENOENT|command not found|no such file/i.test(raw) && connection.transport === "stdio") {
    return `Couldn't run "${connection.command}". It isn't installed on this Mac, or it isn't on the PATH.`;
  }
  if (/401|403|unauthorized|forbidden/i.test(raw)) {
    const named = (connection.env ?? []).join(", ");
    return `The server refused the credentials${named ? ` (${named})` : ""}. Check the token and try again.`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return "That address doesn't resolve. Check it for typos, or check your connection.";
  if (/ECONNREFUSED/i.test(raw)) return "Nothing answered at that address.";
  if (/took longer than/i.test(raw)) return `${raw}. It may be starting slowly, or it may be the wrong address.`;
  if (/404/.test(raw)) return "That address answered, but not with an MCP server. Many of them end in /mcp.";
  // It spoke, but not this protocol: usually the wrong program or the wrong address entirely.
  if (/-32601|Method not found/i.test(raw)) return "That answered, but it isn't an MCP server.";
  if (/certificate|self.signed|SSL|TLS/i.test(raw)) return "That address has a certificate this Mac doesn't trust.";
  if (/fetch failed|ECONNRESET|socket hang up/i.test(raw)) {
    return `Couldn't reach ${connection.url ?? "that address"}. Check it for typos, and that it is reachable from this Mac.`;
  }
  return raw.split(" ")[0] === raw ? raw : raw.split(/\s{2,}/)[0];
}
