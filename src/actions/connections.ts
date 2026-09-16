/**
 * Connections: other people's tools, added from the app instead of written into it.
 *
 * A connection is an MCP server — a local command, or a URL someone hosts — plus whether it is
 * on and which secrets it needs. The app already talks MCP (see browser.ts, which drives
 * Playwright that way), so this is that made general and given a settings window.
 *
 * Kept in ~/.cos/connections.json. Secrets are never in that file: a connection names the
 * variables it wants (`env: ["NOTION_TOKEN"]`) and the values live in ~/.cos/.env, owner-only,
 * written by the same code that writes the API keys (util/keys.ts).
 *
 * The catalogue below is deliberately *hints*, not hardcoded package names. Which package or URL
 * a service publishes changes faster than this app ships, and a wrong prefilled command is worse
 * than an empty one. Each entry says which shape it usually takes and points at the official
 * registry, where the real address lives.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cosHome } from "../util/home.js";

export const REGISTRY_URL = "https://modelcontextprotocol.io/registry";

export type Transport = "stdio" | "http";

export interface Connection {
  /** Stable, lowercase, used in tool names: notion, my-thing. */
  id: string;
  label: string;
  transport: Transport;
  /** stdio: the program to run, e.g. "npx". */
  command?: string;
  args?: string[];
  /** http: a Streamable HTTP endpoint, e.g. https://mcp.example.com/mcp */
  url?: string;
  /** Names of variables in ~/.cos/.env this server needs. Never values. */
  env?: string[];
  enabled: boolean;
  /** What it is for, in the user's words. */
  note?: string;
}

export interface CatalogueEntry {
  id: string;
  label: string;
  /** The shape this service usually comes in. */
  transport: Transport;
  /** What to paste, in words. */
  hint: string;
  /** The variable its token normally goes in, when it needs one. */
  env?: string[];
}

/**
 * The services worth naming in the window, so adding one starts from something rather than a
 * blank box. No commands or URLs here on purpose: see the note at the top of this file.
 */
export const CATALOGUE: CatalogueEntry[] = [
  { id: "gmail", label: "Gmail", transport: "http", hint: "Google's hosted address, or a local server you run", env: ["GMAIL_TOKEN"] },
  { id: "google-drive", label: "Google Drive", transport: "http", hint: "a hosted address, or a local server you run", env: ["GOOGLE_DRIVE_TOKEN"] },
  { id: "google-docs", label: "Google Docs", transport: "http", hint: "a hosted address, or a local server you run", env: ["GOOGLE_DOCS_TOKEN"] },
  { id: "notion", label: "Notion", transport: "stdio", hint: "usually a command you run locally, with an integration token", env: ["NOTION_TOKEN"] },
  { id: "github", label: "GitHub", transport: "http", hint: "GitHub's hosted address, with a personal access token", env: ["GITHUB_TOKEN"] },
  { id: "airtable", label: "Airtable", transport: "stdio", hint: "usually a command you run locally, with a personal access token", env: ["AIRTABLE_API_KEY"] },
  { id: "stripe", label: "Stripe", transport: "http", hint: "Stripe's hosted address, with a restricted key", env: ["STRIPE_API_KEY"] },
  { id: "zapier", label: "Zapier", transport: "http", hint: "the address Zapier gives you, which already carries your key" },
  { id: "canva", label: "Canva", transport: "http", hint: "a hosted address, or a local server you run", env: ["CANVA_TOKEN"] },
  { id: "huggingface", label: "Hugging Face", transport: "http", hint: "Hugging Face's hosted address, with an access token", env: ["HF_TOKEN"] },
];

export function connectionsFile(): string {
  return join(cosHome(), "connections.json");
}

interface Stored {
  connections: Connection[];
}

/** An id that is safe in a tool name and in a file. */
export function normalizeId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** A variable name the env file can hold. */
export function normalizeEnvName(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+/, "").slice(0, 64);
}

/**
 * Check a connection before it is saved, so a broken one is caught here and not mid-conversation.
 * Returns the cleaned connection, or what is wrong with it in words.
 */
export function validate(input: Partial<Connection>): { connection: Connection } | { error: string } {
  const label = (input.label ?? "").trim();
  if (!label) return { error: "Give it a name, so you can tell it apart later." };
  const id = normalizeId(input.id || label);
  if (!id) return { error: "That name has no letters or numbers in it." };
  const transport: Transport = input.transport === "http" ? "http" : "stdio";

  if (transport === "http") {
    const raw = (input.url ?? "").trim();
    if (!raw) return { error: "Paste the address of the server." };
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { error: `"${raw}" isn't a web address. It should start with https://` };
    }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return { error: "Only https addresses, or something on this machine (localhost)." };
    }
    return {
      connection: {
        id, label, transport, url: url.toString(),
        env: (input.env ?? []).map(normalizeEnvName).filter(Boolean),
        enabled: input.enabled ?? true,
        ...(input.note ? { note: input.note.trim() } : {}),
      },
    };
  }

  const command = (input.command ?? "").trim();
  if (!command) return { error: "Say which program to run, for example npx." };
  if (/[;&|`$><]/.test(command)) return { error: "The program is a name, not a shell line. Put anything extra in the arguments." };
  return {
    connection: {
      id, label, transport, command,
      args: (input.args ?? []).map((a) => String(a).trim()).filter(Boolean),
      env: (input.env ?? []).map(normalizeEnvName).filter(Boolean),
      enabled: input.enabled ?? true,
      ...(input.note ? { note: input.note.trim() } : {}),
    },
  };
}

export function readConnections(file: string = connectionsFile()): Connection[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Stored;
    if (!parsed || !Array.isArray(parsed.connections)) return [];
    return parsed.connections.filter((c) => c && typeof c.id === "string");
  } catch {
    return [];
  }
}

export function writeConnections(connections: Connection[], file: string = connectionsFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ connections }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** Add one, or replace the one with the same id. */
export function saveConnection(connection: Connection, file: string = connectionsFile()): Connection[] {
  const rest = readConnections(file).filter((c) => c.id !== connection.id);
  const next = [...rest, connection].sort((a, b) => a.label.localeCompare(b.label));
  writeConnections(next, file);
  return next;
}

export function removeConnection(id: string, file: string = connectionsFile()): Connection[] {
  const next = readConnections(file).filter((c) => c.id !== id);
  writeConnections(next, file);
  return next;
}

export function setEnabled(id: string, enabled: boolean, file: string = connectionsFile()): Connection[] {
  const next = readConnections(file).map((c) => (c.id === id ? { ...c, enabled } : c));
  writeConnections(next, file);
  return next;
}

/** How a connection is described in one line, for a menu or a log. */
export function describe(c: Connection): string {
  return c.transport === "http" ? (c.url ?? "") : [c.command, ...(c.args ?? [])].join(" ");
}

/** Which of a connection's variables have no value yet. */
export function missingEnv(c: Connection, env: NodeJS.ProcessEnv = process.env): string[] {
  return (c.env ?? []).filter((name) => !env[name]);
}

/** The file exists, so something has been added at some point. */
export function everConfigured(file: string = connectionsFile()): boolean {
  return existsSync(file);
}
