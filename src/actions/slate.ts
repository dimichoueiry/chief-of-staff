/**
 * Slate: open the app or a board by name.
 *
 * Board names live in the browser, so names are resolved through Slate's local
 * bridge (the same one its MCP server uses, ws://127.0.0.1:8642), attaching as a
 * peer with the pairing token Slate saved in ~/.slate-mcp/config.json. Only the
 * read-only list_boards call is used. The last list is cached so names still
 * resolve when no Slate tab is open.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cosHome } from "../util/home.js";

export interface SlateBoard {
  id: string;
  name: string;
  projectName: string | null;
  updatedAt: number;
}

export const DEFAULT_SLATE_URL = "https://slate-iota-lac.vercel.app";

export function slateBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.COS_SLATE_URL || DEFAULT_SLATE_URL).replace(/\/+$/, "");
}

export function slateHomeUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${slateBaseUrl(env)}/app`;
}

export function slateBoardUrl(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${slateBaseUrl(env)}/board/${encodeURIComponent(id)}`;
}

function slateToken(file = join(homedir(), ".slate-mcp", "config.json")): string | null {
  try {
    const token = (JSON.parse(readFileSync(file, "utf8")) as { token?: string }).token;
    return token || null;
  } catch {
    return null;
  }
}

function cacheFile(): string {
  return join(cosHome(), "slate-boards.json");
}

export function cachedBoards(): SlateBoard[] {
  try {
    return JSON.parse(readFileSync(cacheFile(), "utf8")) as SlateBoard[];
  } catch {
    return [];
  }
}

function saveCache(boards: SlateBoard[]): void {
  mkdirSync(dirname(cacheFile()), { recursive: true });
  writeFileSync(cacheFile(), JSON.stringify(boards), "utf8");
}

export interface BridgeOptions {
  port?: number;
  token?: string | null;
  timeoutMs?: number;
}

/** Ask the running Slate bridge for the board list. Throws with a plain reason when it can't. */
export async function fetchBoards(o: BridgeOptions = {}): Promise<SlateBoard[]> {
  const token = o.token === undefined ? slateToken() : o.token;
  if (!token) throw new Error("Slate isn't paired on this Mac yet (no ~/.slate-mcp token)");
  const port = o.port ?? (Number(process.env.SLATE_MCP_PORT) || 8642);
  const timeoutMs = o.timeoutMs ?? 4000;

  return new Promise<SlateBoard[]>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const finish = (err: Error | null, boards?: SlateBoard[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(boards!);
    };
    const timer = setTimeout(() => finish(new Error("Slate's bridge didn't answer (is a Slate tab open?)")), timeoutMs);
    const send = (msg: object) => ws.send(JSON.stringify({ slateBridge: 1, ...msg }));

    ws.addEventListener("open", () => send({ method: "peer.hello", params: { token } }));
    ws.addEventListener("error", () => finish(new Error("Slate's bridge isn't running (start a session that uses Slate, or open Slate)")));
    ws.addEventListener("message", (event) => {
      let msg: { method?: string; id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.method === "peer.ok") send({ id: 1, method: "bridge.call", params: { name: "list_boards", args: {}, timeoutMs: timeoutMs - 500 } });
      else if (msg.method === "peer.fail") finish(new Error("Slate's bridge refused the pairing token"));
      else if (msg.method === "busy") finish(new Error("Slate's bridge is busy"));
      else if (msg.id === 1) {
        if (msg.error) finish(new Error(msg.error.message ?? "Slate returned an error"));
        else finish(null, (msg.result as SlateBoard[]) ?? []);
      }
    });
  });
}

/** Live list when the bridge answers (and refresh the cache); otherwise the cached list. */
export async function slateBoards(o: BridgeOptions = {}): Promise<{ boards: SlateBoard[]; live: boolean; reason?: string }> {
  try {
    const boards = await fetchBoards(o);
    saveCache(boards);
    return { boards, live: true };
  } catch (err) {
    return { boards: cachedBoards(), live: false, reason: (err as Error).message };
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Best board for a spoken or typed name. Exact name beats prefix beats all words
 * present; conflict copies lose to originals; ties go to the most recently edited.
 */
export function findBoards(boards: SlateBoard[], query: string): SlateBoard[] {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(" ");
  const scored = boards
    .map((b) => {
      const name = norm(b.name);
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.includes(q)) score = 60;
      else if (words.every((w) => name.includes(w))) score = 40 + Math.min(10, words.length * 2);
      else return null;
      if (/\(conflict/i.test(b.name)) score -= 15;
      if (/^untitled/i.test(b.name)) score -= 5;
      return { b, score };
    })
    .filter((x): x is { b: SlateBoard; score: number } => x !== null)
    .sort((x, y) => y.score - x.score || y.b.updatedAt - x.b.updatedAt);
  return scored.map((x) => x.b);
}
