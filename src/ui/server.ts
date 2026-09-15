/**
 * Local server for the pill + brief page. No framework: node:http, static files,
 * a few JSON endpoints that call the same functions the CLI does.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_INTENTS, PROVIDERS, PROVIDER_ORDER, formatSpec, parseModelSpec, presets, providerConfigured,
  readModelSettings, resolveModel, setModel, type ModelIntent,
} from "../brain/llm/registry.js";
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
import { reloadHomeEnv } from "../util/env.js";
import { speak, stopSpeaking } from "../voice/tts.js";

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
  /** provider:model forced for every request from this server. */
  modelFlag?: string;
  /** Never call a model, whatever keys exist (tests, or a deliberate offline mode). */
  offline?: boolean;
  /** Set to false in tests so nothing is spoken. */
  allowSpeech?: boolean;
}

/** Sentences the offline Scribe can file without a model. */
const CAPTURE_SHAPE = /^(remind|starting|start|new project|park|kill|done with|finished|touched|worked on|today i|note:|.+\s+every\s+|.+\s+next\s*:)/i;

const NO_MODEL = "That needs a model. Add a key (Anthropic, OpenAI or OpenRouter) to ~/.cos/.env or the project's .env, and pick one with `cos models use …` or the Model menu. The brief, decisions and capture work without one.";

export function createUiServer(o: UiOptions): Server {
  const { config } = o;
  const today = () => o.today ?? todayISO();

  /** Settings are re-read on every request, so a switch in the menubar applies immediately. */
  function ready(intent: ModelIntent): boolean {
    if (o.offline) return false;
    try {
      return Boolean(resolveModel(intent, { flag: o.modelFlag })?.ready);
    } catch {
      return false;
    }
  }

  async function freshBrief(): Promise<{ brief: Brief; source: string }> {
    await applyActivity(new Ledger(config.selfhubDir), await scanActivity(config.projectRoots));
    const rules = async (why: string) => {
      const ctx = await buildContext({ config, intent: "brief", today: today() });
      return { brief: buildBrief(ctx), source: why ? `rules (${why})` : "rules" };
    };
    if (!ready("brief")) return rules(o.offline ? "" : "no model key");
    try {
      const r = await runIntent({ config, intent: "brief", today: today(), modelFlag: o.modelFlag });
      return { brief: r.brief!, source: r.model };
    } catch (err) {
      return rules(`model failed: ${String((err as Error).message).split("\n")[0]}`);
    }
  }

  function modelsState() {
    const settings = readModelSettings();
    const intents: Record<string, unknown> = {};
    for (const intent of MODEL_INTENTS) {
      try {
        const r = resolveModel(intent, { flag: o.modelFlag, settings });
        intents[intent] = r ? { spec: formatSpec(r.spec), source: r.source, ready: r.ready } : null;
      } catch (err) {
        intents[intent] = { error: (err as Error).message };
      }
    }
    return {
      default: settings.default ?? null,
      intents,
      presets: presets(settings).map((spec) => {
        const provider = parseModelSpec(spec).provider;
        return { spec, provider, ready: providerConfigured(provider) };
      }),
      providers: PROVIDER_ORDER.map((id) => ({ id, label: PROVIDERS[id].label, ready: providerConfigured(id), key: PROVIDERS[id].keyEnv[0] })),
    };
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

  const changes = (calls: { name: string; isError: boolean }[]) => calls.filter((c) => !c.isError && !c.name.startsWith("get_")).length;

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/brief": {
        const refresh = url.searchParams.get("refresh") === "1";
        const cached = refresh ? null : await loadLastBrief();
        const stale = cached && cached.brief.date !== today();
        const r = cached && !stale ? { brief: cached.brief, source: cached.source } : await freshBrief();
        if (!cached || stale || refresh) await saveBrief(r.brief, r.source);
        return json(res, 200, { ...r, speech: renderBriefSpeech(r.brief), offline: !ready("ask"), today: today() });
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
      case "GET /api/models":
        return json(res, 200, modelsState());
      case "POST /api/models": {
        const b = await body(req);
        const spec = b.spec === null ? null : String(b.spec ?? "").trim();
        const intent = b.intent ? String(b.intent) : undefined;
        if (intent && !(MODEL_INTENTS as readonly string[]).includes(intent)) return json(res, 400, { error: `intent must be one of ${MODEL_INTENTS.join(", ")}` });
        if (spec === "") return json(res, 400, { error: "spec is required (provider:model), or null to clear" });
        try {
          setModel(spec, intent as ModelIntent | undefined);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        return json(res, 200, modelsState());
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

        if (mode === "focus") {
          const p = await new Ledger(config.selfhubDir).find(text);
          if (!p) return json(res, 404, { error: `No project matches "${text}".` });
          if (!ready("focus")) {
            return json(res, 200, {
              kind: "focus",
              project: p.name,
              text: `Recorded next action: ${p.next ?? "none yet"}.\n${p.why ? `Why it matters: ${p.why}.\n` : ""}\nThe top-3 analysis needs a model. ${NO_MODEL.split(". ").slice(1).join(". ")}`,
            });
          }
          const r = await runIntent({ config, intent: "focus", project: p.name, today: today(), modelFlag: o.modelFlag });
          return json(res, 200, { kind: "focus", project: p.name, text: r.text, model: r.model, changes: changes(r.toolCalls) });
        }

        const isCapture = mode === "capture" || (mode === "auto" && CAPTURE_SHAPE.test(text));
        const intent: ModelIntent = isCapture ? "capture" : "ask";
        if (isCapture && !ready("capture")) {
          const filed = await scribe(config.selfhubDir, text.replace(/^note:\s*/i, ""), today());
          return json(res, 200, { kind: "capture", text: filed.message + (filed.question ? `\n${filed.question}` : ""), where: filed.where, model: "rules" });
        }
        if (!ready(intent)) return json(res, 200, { kind: "answer", text: NO_MODEL });
        const r = await runIntent({ config, intent, message: text, today: today(), modelFlag: o.modelFlag });
        return json(res, 200, { kind: isCapture ? "capture" : "answer", text: r.text, model: r.model, changes: changes(r.toolCalls) });
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
      case "POST /api/speak/stop":
        return json(res, 200, { ok: true, stopped: stopSpeaking() });
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
    // Keys added to ~/.cos/.env apply to the next request; no restart.
    if (url.pathname.startsWith("/api/")) reloadHomeEnv();
    try {
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else await serveStatic(res, url.pathname);
    } catch (err) {
      await json(res, 500, { error: (err as Error).message });
    }
  });
}
