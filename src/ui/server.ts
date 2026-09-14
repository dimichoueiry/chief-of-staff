/**
 * Local server for the pill + brief page. No framework: node:http, static files,
 * a few JSON endpoints that call the same functions the CLI does.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { runIntent } from "../brain/loop.js";
import type { Brief } from "../brain/schema.js";
import type { Config } from "../config.js";
import { buildContext } from "../core/context.js";
import { Journal } from "../core/journal.js";
import { Ledger, normalizeStatus } from "../core/ledger.js";
import { buildBrief } from "../logic/brief.js";
import { daysIdle } from "../logic/cadence.js";
import { decide, isChoice } from "../logic/decide.js";
import { scribe } from "../logic/scribe.js";
import { loadLastBrief, saveBrief } from "../output/notify.js";
import { renderBriefSpeech } from "../output/render.js";
import { applyActivity, scanActivity } from "../sensors/git.js";
import { todayISO } from "../util/dates.js";
import { speak } from "../voice/tts.js";

const here = dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = join(here, "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export interface UiOptions {
  config: Config;
  today?: string;
  hasApiKey: boolean;
  /** Set to false in tests so nothing is spoken. */
  allowSpeech?: boolean;
}

/** Sentences the offline Scribe can file without a model. */
const CAPTURE_SHAPE = /^(remind|starting|start|new project|park|kill|done with|finished|touched|worked on|today i|note:|.+\s+every\s+|.+\s+next\s*:)/i;

export function createUiServer(o: UiOptions): Server {
  const { config } = o;
  const today = () => o.today ?? todayISO();

  async function freshBrief(): Promise<{ brief: Brief; source: string }> {
    await applyActivity(new Ledger(config.selfhubDir), await scanActivity(config.projectRoots));
    if (o.hasApiKey) {
      const r = await runIntent({ config, intent: "brief", today: today() });
      return { brief: r.brief!, source: config.model };
    }
    const ctx = await buildContext({ config, intent: "brief", today: today() });
    return { brief: buildBrief(ctx), source: "rules" };
  }

  async function json(res: ServerResponse, status: number, body: unknown): Promise<void> {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/brief": {
        const refresh = url.searchParams.get("refresh") === "1";
        const cached = refresh ? null : await loadLastBrief();
        const stale = cached && cached.brief.date !== today();
        const r = cached && !stale ? { brief: cached.brief, source: cached.source } : await freshBrief();
        if (!cached || stale || refresh) await saveBrief(r.brief, r.source);
        return json(res, 200, { ...r, speech: renderBriefSpeech(r.brief), offline: !o.hasApiKey, today: today() });
      }
      case "GET /api/projects": {
        const projects = await new Ledger(config.selfhubDir).read();
        return json(
          res,
          200,
          projects
            .filter((p) => ["active", "parked"].includes(normalizeStatus(p.status)))
            .map((p) => ({ name: p.name, status: normalizeStatus(p.status), next: p.next ?? "", idle: daysIdle(p, today()), cadence: p.cadence ?? "" })),
        );
      }
      case "POST /api/decide": {
        const b = await body(req);
        const choice = String(b.choice ?? "");
        if (!isChoice(choice)) return json(res, 400, { error: "choice must be keep, park or kill" });
        const r = await decide(new Ledger(config.selfhubDir), String(b.project ?? ""), choice, today());
        return json(res, 200, r);
      }
      case "POST /api/pill": {
        const b = await body(req);
        const text = String(b.text ?? "").trim();
        if (!text) return json(res, 400, { error: "empty" });
        const mode = String(b.mode ?? "auto");
        const isCapture = mode === "capture" || (mode === "auto" && CAPTURE_SHAPE.test(text));
        if (isCapture && (!o.hasApiKey || mode === "capture" && !o.hasApiKey)) {
          const filed = await scribe(config.selfhubDir, text.replace(/^note:\s*/i, ""), today());
          return json(res, 200, { kind: "capture", text: filed.message + (filed.question ? `\n${filed.question}` : ""), where: filed.where });
        }
        if (!o.hasApiKey) {
          return json(res, 200, {
            kind: "answer",
            text: "Questions need the model. Set ANTHROPIC_API_KEY in .env and restart `cos ui`. The brief, decisions and capture work offline.",
          });
        }
        const r = await runIntent({ config, intent: isCapture ? "capture" : "ask", message: text, today: today() });
        return json(res, 200, { kind: isCapture ? "capture" : "answer", text: r.text, changes: r.toolCalls.filter((c) => !c.isError && !c.name.startsWith("get_")).length });
      }
      case "POST /api/wrap": {
        const b = await body(req);
        const text = String(b.text ?? "").trim();
        if (!text) return json(res, 400, { error: "empty" });
        await new Journal(config.selfhubDir).append(today(), text);
        return json(res, 200, { ok: true });
      }
      case "POST /api/speak": {
        const b = await body(req);
        const text = String(b.text ?? "").trim();
        if (!text) return json(res, 400, { error: "empty" });
        if (o.allowSpeech === false) return json(res, 200, { ok: true, muted: true });
        await speak(text);
        return json(res, 200, { ok: true });
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const rel = pathname === "/" ? "index.html" : normalize(pathname).replace(/^(\.\.[/\\])+/, "").slice(1);
    const file = join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else await serveStatic(res, url.pathname);
    } catch (err) {
      await json(res, 500, { error: (err as Error).message });
    }
  });
}
