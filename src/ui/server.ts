/**
 * Local server for the pill + brief page. No framework: node:http, static files,
 * a few JSON endpoints that call the same functions the CLI does.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_INTENTS, PROVIDERS, PROVIDER_ORDER, forgetModel, formatSpec, parseModelSpec, presets, providerConfigured,
  readModelSettings, rememberModel, resolveModel, setModel, testModel, type ModelIntent,
} from "../brain/llm/registry.js";
import { Conversations, conversationsDir, displayTitle, eventsSinceReply, historyMessages, messageCount, visibleTurns, withEvents, type Conversation, type Turn } from "../brain/conversation.js";
import type { LLMProvider, ChatMessage } from "../brain/llm/types.js";
import type { ModelSpec } from "../brain/llm/registry.js";
import { providerFor, runIntent } from "../brain/loop.js";
import { WRITES } from "../brain/tools.js";
import { chatPreview, findConversation, nameConversations, renderRecall, summarizeEnded } from "../brain/recall.js";
import type { Brief } from "../brain/schema.js";
import type { Config } from "../config.js";
import { buildContext } from "../core/context.js";
import { Journal } from "../core/journal.js";
import { Ledger, normalizeStatus } from "../core/ledger.js";
import { buildBrief } from "../logic/brief.js";
import { daysIdle } from "../logic/cadence.js";
import { decide, isChoice } from "../logic/decide.js";
import { scribe } from "../logic/scribe.js";
import { loadLastBrief, notify, saveBrief } from "../output/notify.js";
import { markdownToSpeech, renderBriefSpeech } from "../output/render.js";
import { eventsInRange } from "../sensors/calendar.js";
import { activityRoots, applyActivity, scanActivity } from "../sensors/git.js";
import { readAccess } from "../actions/access.js";
import { findBookmarks, formatBookmarks, readBookmarks, type BookmarkRead } from "../actions/bookmarks.js";
import { readConsent } from "../actions/consent.js";
import { LOOK_REQUEST, SCREEN_PERMISSION_HELP, ScreenPermissionError, describeShot, helperCapturer, type ScreenCapturer, type Screenshot } from "../sensors/screen.js";
import { addDays, todayISO } from "../util/dates.js";
import { reloadHomeEnv } from "../util/env.js";
import type { Access } from "../actions/access.js";
import { AgentGrid } from "../actions/agentgrid.js";
import { watchAgents, type Watcher } from "../actions/agentwatch.js";
import type { AssistantBrowser } from "../actions/browser.js";
import { macOpen, openOrQueue, type Runner } from "../actions/open.js";
import { confirmView, isPending, take, type ConfirmView } from "../actions/pending.js";
import { performPending } from "../actions/perform.js";
import type { Shell } from "../actions/terminal.js";
import { findFolders, formatFolderSearch } from "../actions/folders.js";
import { Shortcuts } from "../actions/shortcuts.js";
import { slateBoards, type SlateBoard } from "../actions/slate.js";
import { speak, stopSpeaking, type SpeakOptions, type SpeakResult } from "../voice/tts.js";

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
  /** Speak through this instead of the speakers (tests). */
  speaker?: (text: string, o: SpeakOptions) => Promise<SpeakResult>;
  /** Replace `open` and the Slate board list (tests). */
  openRunner?: Runner;
  slateLoader?: () => Promise<{ boards: SlateBoard[]; live: boolean; reason?: string }>;
  /** Use this provider for every model request instead of the configured one (tests). */
  llm?: { provider: LLMProvider; spec: ModelSpec };
  /** Where conversations are kept (tests). */
  conversations?: Conversations;
  /** Summarise ended conversations in the background after each message (default true). */
  backgroundSummaries?: boolean;
  /** How commands run, where Agent Grid is, what's allowed, and where favorites come from (tests). */
  shell?: Shell;
  agentGrid?: AgentGrid;
  /** The assistant's own browser (tests). */
  browser?: AssistantBrowser;
  access?: () => Access;
  bookmarks?: () => Promise<BookmarkRead>;
  screen?: ScreenCapturer;
  /** How a model is checked before it's used from the menu (tests). */
  modelTester?: (spec: ModelSpec) => Promise<{ ms: number; servedBy: string }>;
  /**
   * Tell them when an Agent Grid agent finishes: a notification, and a line in the conversation so the
   * assistant knows too. Agent Grid's event stream is listened to while the server listens; `cos ui`
   * turns this on. Tests pass a fake Agent Grid and notifier, or leave it out.
   */
  agentWatch?: { notifier?: (title: string, body: string) => Promise<boolean>; retryMs?: number };
}

/** How long a finished action counts as "just done", so the same one isn't queued again. */
const RECENT_MS = 15 * 60_000;

/** What the pill says while a tool runs. */
const DOING: Record<string, string> = {
  get_calendar: "Checking your calendar…",
  get_project: "Reading the ledger…",
  get_git_log: "Reading recent commits…",
  find_folder: "Looking for the folder…",
  get_conversations: "Searching earlier conversations…",
  run_command: "Running a command…",
  get_agents: "Checking your agents…",
  start_agent: "Starting an agent…",
  get_agent_output: "Reading what the agent did…",
  look_at_screen: "Looking at your screen…",
  message_agent: "Messaging the agent…",
  browser_open: "Opening it in my browser…",
  browser_read: "Reading the page…",
  browser_click: "Clicking…",
  browser_type: "Typing…",
  browser_select: "Choosing…",
  browser_back: "Going back…",
  open: "Opening…",
  add_shortcut: "Saving a shortcut…",
  add_reminder: "Setting a reminder…",
  complete_reminder: "Updating reminders…",
  add_note: "Taking a note…",
  append_journal: "Writing in the journal…",
};

type Emit = (event: Record<string, unknown>) => void;

interface PillReply {
  kind: "answer" | "capture" | "action" | "confirm" | "focus" | "error";
  text: string;
  model?: string;
  changes?: number;
  confirm?: ConfirmView[];
  done?: { kind: string; detail: string }[];
  where?: string;
  project?: string;
  steps?: ChatMessage[];
  /** A screenshot went with the message. */
  screen?: { app: string; window: string };
}

/** The model can't take images: say which setting fixes it rather than a raw provider error. */
function explainImageError(err: unknown, model: string): string | null {
  const msg = String((err as Error).message ?? err);
  if (!/image|vision|multimodal|image_url|modalit/i.test(msg)) return null;
  return `The model in use (${model}) can't look at images. Pick one that can, like openrouter:openai/gpt-5.4-mini or openrouter:anthropic/claude-sonnet-5, from the Model menu.`;
}

/** "open slate", "pull up my gmail", "launch cursor", "search for …": handled without a model. */
const OPEN_SHAPE = /^(?:(?:please\s+)?(?:open|launch|pull up|bring up|go to|show me)\s+.+|(?:search(?: the web| google)?(?: for)?|google|look up)\s+.+)$/i;

/**
 * With a model available, the instant rules step aside when a request could mean memory rather than the web:
 * "search for …" / "look up …" without saying web or Google, and anything that refers back to what was said.
 */
const PLAIN_SEARCH = /^(?:please\s+)?(?:search|look up)\b/i;
const WEB_SEARCH = /^(?:please\s+)?(?:google\b|search (?:the web|google|online)\b)|\b(?:on|in) (?:google|the web)\s*[.?!]?$|\bonline\s*[.?!]?$/i;
const REFERS_BACK = /\b(?:we|our|us|i said|i told you|you said|talked|discussed|decided|mentioned|conversations?|remember|earlier|yesterday|last (?:time|week))\b/i;


/** What goes into the conversation about something that was done: the result, with any cut stated. */
function outcome(text: string, max = 3_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${(text.length - max).toLocaleString("en-US")} more characters not kept here)`;
}

/** Sentences the offline Scribe can file without a model. */
const CAPTURE_SHAPE = /^(remind|starting|start|new project|park|kill|done with|finished|touched|worked on|today i|note:|.+\s+every\s+|.+\s+next\s*:)/i;

function Log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

const NO_MODEL = "That needs a model. Add a key (Anthropic, OpenAI or OpenRouter) to ~/.cos/.env or the project's .env, and pick one with `cos models use …` or the Model menu. The brief, decisions and capture work without one.";

export function createUiServer(o: UiOptions): Server {
  const { config } = o;
  const today = () => o.today ?? todayISO();

  let activityAt = 0;
  /** Move "last touched" forward from git commits: the brief always, conversations at most every 10 minutes. */
  async function syncActivity(force = false): Promise<void> {
    if (!force && Date.now() - activityAt < 10 * 60_000) return;
    activityAt = Date.now();
    const ledger = new Ledger(config.selfhubDir);
    await applyActivity(ledger, await scanActivity(activityRoots(config.projectRoots, await ledger.read())));
  }

  /** Settings are re-read on every request, so a switch in the menubar applies immediately. */
  function ready(intent: ModelIntent): boolean {
    if (o.offline) return false;
    if (o.llm) return true;
    try {
      return Boolean(resolveModel(intent, { flag: o.modelFlag })?.ready);
    } catch {
      return false;
    }
  }

  async function freshBrief(): Promise<{ brief: Brief; source: string }> {
    await syncActivity(true);
    const rules = async (why: string) => {
      const ctx = await buildContext({ config, intent: "brief", today: today() });
      return { brief: buildBrief(ctx), source: why ? `rules (${why})` : "rules" };
    };
    if (!ready("brief")) return rules(o.offline ? "" : "no model key");
    try {
      const r = await runIntent({ config, intent: "brief", today: today(), modelFlag: o.modelFlag, llm: o.llm });
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
    const current = (intents.ask as { spec?: string } | null)?.spec ?? "";
    return {
      default: settings.default ?? null,
      intents,
      presets: presets(settings).map((spec) => {
        const provider = parseModelSpec(spec).provider;
        return { spec, provider, ready: providerConfigured(provider), custom: (settings.presets ?? []).includes(spec) };
      }),
      // Extra items for the menubar's Model menu; the app draws whatever is listed here.
      actions: [
        {
          kind: "input", title: "Use any model…", prompt: "Use any model",
          message: "An OpenRouter model id, like ~openai/gpt-luna-latest or anthropic/claude-sonnet-5, or provider:model (anthropic:claude-opus-5, openai:gpt-5.4). It's tried once before it's used, and added to this list.",
          placeholder: "~openai/gpt-luna-latest", value: current, button: "Try and use", path: "api/models/use",
        },
        { kind: "open", title: "Browse OpenRouter models…", url: "https://openrouter.ai/models" },
        ...((settings.presets ?? []).includes(current)
          ? [{ kind: "post", title: `Remove ${current} from this list`, path: "api/models/forget", body: { spec: current } }]
          : []),
      ],
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

  const changes = (calls: { name: string; isError: boolean }[]) => calls.filter((c) => !c.isError && WRITES.includes(c.name)).length;

  const conversations = o.conversations ?? new Conversations(conversationsDir(), config.conversationIdleMinutes);
  const openRunner = o.openRunner ?? macOpen;
  const boards = o.slateLoader ?? (() => slateBoards());
  const bookmarks = o.bookmarks ?? (() => readBookmarks());
  const access = () => (o.access ?? readAccess)();
  const screen = o.screen ?? helperCapturer;
  const modelInUse = (intent: ModelIntent) => {
    if (o.llm) return formatSpec(o.llm.spec);
    try {
      const r = resolveModel(intent, { flag: o.modelFlag });
      return r ? formatSpec(r.spec) : "this model";
    } catch {
      return "this model";
    }
  };
  const deps = { run: openRunner, shell: o.shell, agentGrid: o.agentGrid, browser: o.browser };
  let pillQueue: Promise<unknown> = Promise.resolve();
  let summarizing = false;
  let summarizeAgain = false;

  /** Name new chats and write summaries for conversations that just ended, without holding up the reply. */
  function summarizeSoon(): void {
    if (o.backgroundSummaries === false) return;
    if (summarizing) {
      summarizeAgain = true; // a chat that just got its first reply shouldn't wait for the next message to be named
      return;
    }
    summarizing = true;
    let llm: { provider: LLMProvider; spec: ModelSpec } | null = null;
    try {
      llm = o.llm ?? (ready("ask") ? providerFor("ask", o.modelFlag) : null);
    } catch {
      /* no model: short conversations are still recorded from their own words */
    }
    nameConversations(conversations, llm)
      .catch((err) => console.error(`chat names: ${(err as Error).message}`))
      .then(() => summarizeEnded(conversations, llm))
      .catch((err) => console.error(`conversation summaries: ${(err as Error).message}`))
      .finally(() => {
        summarizing = false;
        if (summarizeAgain) {
          summarizeAgain = false;
          summarizeSoon();
        }
      });
  }

  /** A conversation as the page shows it: its turns, its name once something was said, and whether there are others to go back to. */
  function shownConversation(c: Conversation) {
    const others = conversations.count() - (conversations.get(c.id) ? 1 : 0);
    return { id: c.id, title: messageCount(c) ? displayTitle(c) : null, turns: visibleTurns(c), others };
  }

  /** One message in the pill: remembered with its reply, and answered with the conversation so far. */
  async function pill(b: Record<string, unknown>, emit: Emit): Promise<{ status: number; body: Record<string, unknown> }> {
    const text = String(b.text ?? "").trim();
    if (!text) return { status: 400, body: { error: "empty" } };
    const mode = String(b.mode ?? "auto");

    let said = text;
    let focusOn: string | undefined;
    if (mode === "focus") {
      const p = await new Ledger(config.selfhubDir).find(text);
      if (!p) return { status: 404, body: { error: `No project matches "${text}".` } };
      focusOn = p.name;
      said = `What are the top 3 moves on ${p.name} right now?`;
    }

    const convo = conversations.current();
    emit({ type: "start", conversation: convo.id, user: said });
    await syncActivity().catch(() => undefined);
    let reply: PillReply;
    try {
      // "yes" or "no" to what the last reply was waiting on: do it (or drop it) first, then answer with the result in hand.
      const settled = mode === "focus" ? [] : await settlePending(convo, said, emit);
      if (settled.length && !ready("ask")) reply = { kind: "action", text: settled.join("\n"), model: "rules" };
      // Anything that happened since the last reply (this yes, a tapped button) travels with the message.
      else reply = await respond(said, mode, focusOn, convo, emit, withEvents(eventsSinceReply(convo), said));
    } catch (err) {
      reply = { kind: "error", text: `That didn't work: ${String((err as Error).message).split("\n")[0]}` };
    }
    conversations.append(
      convo,
      { role: "user", text: said, ...(reply.screen ? { screen: reply.screen } : {}) },
      {
        role: "assistant", text: reply.text, model: reply.model, kind: reply.kind,
        steps: reply.steps?.length ? reply.steps : undefined,
        confirm: reply.confirm?.length ? reply.confirm : undefined,
        actionsDone: reply.done?.length ? reply.done : undefined,
      },
    );
    summarizeSoon();
    const { steps: _steps, done: _done, ...shown } = reply;
    return { status: 200, body: { ...shown, conversation: convo.id, title: displayTitle(convo), user: said } };
  }

  /** What the last reply left waiting that can still be done. */
  function awaiting(convo: Conversation): ConfirmView[] {
    const last = [...convo.turns].reverse().find((t) => t.role === "assistant");
    return (last?.confirm ?? []).filter((c) => isPending(c.id));
  }

  /** Actions carried out in this conversation in the last few minutes. */
  function recentlyDone(convo: Conversation): { kind: string; detail: string }[] {
    const since = Date.now() - RECENT_MS;
    return convo.turns.filter((t) => new Date(t.at).getTime() >= since).flatMap((t) => [...(t.done ? [t.done] : []), ...(t.actionsDone ?? [])]);
  }

  /** A clear yes or no to what's waiting is carried out here; anything else goes to the model, which has confirm_pending. */
  async function settlePending(convo: Conversation, said: string, emit: Emit): Promise<string[]> {
    const waiting = awaiting(convo);
    if (!waiting.length) return [];
    const consent = readConsent(said);
    if (consent === "unclear") return [];
    const turns: Omit<Turn, "at">[] = [];
    for (const c of waiting) {
      const p = take(c.id);
      if (!p) continue;
      if (consent === "no") {
        turns.push({ role: "event", text: `They said no, so this was not done: ${p.label}.` });
        continue;
      }
      emit({ type: "status", text: p.kind === "command" ? "Running it…" : p.kind === "agent-start" ? "Starting the agent…" : p.kind === "agent-message" ? "Sending it…" : "On it…" });
      try {
        const out = await performPending(p, deps);
        turns.push({ role: "event", text: `They said yes and it is already done (do not do it again): ${p.label}. Result: ${outcome(out)}`, done: { kind: p.kind, detail: p.detail } });
      } catch (err) {
        turns.push({ role: "event", text: `They said yes, but ${p.label} failed: ${(err as Error).message}` });
      }
    }
    if (turns.length) conversations.append(convo, ...turns);
    return turns.map((t) => t.text);
  }

  async function respond(text: string, mode: string, focusOn: string | undefined, convo: Conversation, emit: Emit, modelText = text): Promise<PillReply> {
    // "look at this": the screenshot goes with the message, before anything else is tried.
    let shot: Screenshot | null = null;
    let seen: PillReply["screen"];
    if (!focusOn && mode !== "capture" && LOOK_REQUEST.test(text) && access().screen !== "off") {
      if (!ready("ask")) return { kind: "answer", text: `Looking at your screen ${NO_MODEL.charAt(0).toLowerCase()}${NO_MODEL.slice(1)}`, model: "rules" };
      emit({ type: "status", text: "Looking at your screen…" });
      try {
        shot = await screen.capture();
        seen = { app: shot.app, window: shot.window };
        modelText = `(${describeShot(shot)})\n\n${modelText}`;
      } catch (err) {
        if (err instanceof ScreenPermissionError) {
          await screen.request().catch(() => false); // shows macOS's prompt, once
          return { kind: "answer", text: SCREEN_PERMISSION_HELP, model: "rules" };
        }
        modelText = `(You tried to take a screenshot because they asked you to look, but it failed: ${(err as Error).message}. Tell them.)\n\n${modelText}`;
      }
    }
    const model = async (intent: ModelIntent, project?: string) => {
      try {
        return await runIntent({
        config, intent, project, message: modelText, today: today(), modelFlag: o.modelFlag, llm: o.llm,
        history: historyMessages(convo),
        recall: renderRecall(conversations, { today: today(), excludeId: convo.id }),
        images: shot ? [{ mediaType: shot.mediaType, data: shot.data }] : undefined,
        actions: {
          run: openRunner, slate: boards, conversations, shell: o.shell, agentGrid: o.agentGrid, access: o.access, browser: o.browser,
          awaiting: awaiting(convo), recentlyDone: recentlyDone(convo), bookmarks, screen,
        },
        onTool: (name) => emit({ type: "status", text: DOING[name] ?? "Updating your memory…" }),
        onText: (delta) => emit({ type: "text", delta }),
        });
      } catch (err) {
        throw new Error(explainImageError(err, modelInUse(intent)) ?? (err as Error).message);
      }
    };
    const fromModel = (kind: PillReply["kind"], r: Awaited<ReturnType<typeof runIntent>>, extra: Partial<PillReply> = {}): PillReply => ({
      kind, text: r.text, model: r.model, changes: changes(r.toolCalls), confirm: r.pending.map(confirmView), done: r.done, steps: r.steps,
      ...(seen ? { screen: seen } : {}), ...extra,
    });

    if (focusOn) {
      if (ready("focus")) return fromModel("focus", await model("focus", focusOn), { project: focusOn });
      const p = (await new Ledger(config.selfhubDir).find(focusOn))!;
      return {
        kind: "focus",
        project: p.name,
        model: "rules",
        text: `Recorded next action: ${p.next ?? "none yet"}.\n${p.why ? `Why it matters: ${p.why}.\n` : ""}\nThe top-3 analysis needs a model. ${NO_MODEL.split(". ").slice(1).join(". ")}`,
      };
    }

    const forModel = Boolean(shot) || (ready("ask") && ((PLAIN_SEARCH.test(text) && !WEB_SEARCH.test(text)) || REFERS_BACK.test(text)));
    if (mode !== "capture" && OPEN_SHAPE.test(text) && !forModel) {
      const opened = await openOrQueue(
        {
          target: text.replace(/^please\s+/i, "").replace(/^(?:pull up|bring up|show me)\s+/i, "open "),
          shortcuts: await new Shortcuts(config.selfhubDir).list(),
          projects: await new Ledger(config.selfhubDir).read(),
          boards,
          bookmarks,
        },
        openRunner,
        { confirmLinks: access().links !== "auto" },
      );
      if (opened.status === "opened") return { kind: "action", text: opened.message, model: "rules" };
      if (opened.status === "confirm") return { kind: "confirm", text: opened.message, confirm: [confirmView(opened.pending)], model: "rules" };
      // Not something the rules know ("open the second one"): the model has the conversation and the same open tool.
      if (!ready("ask")) {
        const known = opened.candidates?.length ? `\nI know: ${opened.candidates.slice(0, 10).join(", ")}` : "";
        return { kind: "answer", text: `Couldn't open that: ${opened.message}.${known}`, model: "rules" };
      }
    }

    // With a model, everything in auto mode is one conversation that can both answer and file.
    const intent: ModelIntent = mode === "capture" ? "capture" : "ask";
    if (ready(intent)) return fromModel(mode === "capture" ? "capture" : "answer", await model(intent));
    if (mode === "capture" || CAPTURE_SHAPE.test(text)) {
      const filed = await scribe(config.selfhubDir, text.replace(/^note:\s*/i, ""), today());
      return { kind: "capture", text: filed.message + (filed.question ? `\n${filed.question}` : ""), where: filed.where, model: "rules", changes: 1 };
    }
    return { kind: "answer", text: NO_MODEL, model: "rules" };
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
      case "GET /api/calendar": {
        const from = url.searchParams.get("from") ?? today();
        const to = url.searchParams.get("to") ?? addDays(from, 6);
        const r = await eventsInRange(from, to);
        return json(res, r.error ? 422 : 200, { from, to, provider: r.provider, error: r.error ?? null, events: r.events });
      }
      case "GET /api/screen":
        return json(res, 200, { permission: await screen.permission(), access: access().screen });
      case "POST /api/screen/request":
        return json(res, 200, { permission: await screen.request() });
      case "GET /api/bookmarks": {
        const q = (url.searchParams.get("q") ?? "").trim();
        const read = await bookmarks();
        const matches = q ? findBookmarks(read.bookmarks, q) : [];
        return json(res, 200, { total: read.bookmarks.length, browsers: read.browsers, blocked: read.blocked, matches, text: formatBookmarks(read, matches, q) });
      }
      case "GET /api/folders": {
        const name = (url.searchParams.get("name") ?? "").trim();
        if (!name) return json(res, 400, { error: "name is required" });
        const r = await findFolders(name, { roots: config.projectRoots });
        return json(res, 200, { ...r, text: formatFolderSearch(r) });
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
      case "POST /api/models/use": {
        const b = await body(req);
        const raw = String(b.value ?? b.spec ?? "").trim();
        if (!raw) return json(res, 400, { error: "Type a model, like ~openai/gpt-luna-latest." });
        let spec: ModelSpec;
        try {
          spec = parseModelSpec(raw);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        const name = formatSpec(spec);
        try {
          const t = await (o.modelTester ?? testModel)(spec);
          setModel(name);
          rememberModel(name);
          Log(`model → ${name}`);
          return json(res, 200, { ok: true, message: `Now using ${name}`, detail: `It answered in ${(t.ms / 1000).toFixed(1)} s (served by ${t.servedBy}).`, ...modelsState() });
        } catch (err) {
          const why = String((err as Error).message).split("\n")[0];
          return json(res, 422, { error: `${name} didn't work, so nothing changed: ${why}` });
        }
      }
      case "POST /api/models/forget": {
        const b = await body(req);
        forgetModel(String(b.spec ?? ""));
        return json(res, 200, { ok: true, message: "Removed from the list", ...modelsState() });
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
        // Streamed as one JSON object per line: start, status and text while it works, then done.
        const line = (event: Record<string, unknown>) => {
          if (!res.headersSent) res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
          res.write(`${JSON.stringify(event)}\n`);
        };
        const stream = b.stream === true;
        // One message at a time, so each reply is saved before the next message reads the conversation.
        const turn = pillQueue.then(() => pill(b, stream ? line : () => {}));
        pillQueue = turn.catch(() => undefined);
        try {
          const r = await turn;
          if (!res.headersSent) return json(res, r.status, r.body);
          line({ type: "done", result: r.body });
        } catch (err) {
          if (!res.headersSent) throw err;
          line({ type: "error", error: (err as Error).message });
        }
        res.end();
        return;
      }
      case "GET /api/conversation": {
        const c = conversations.current();
        return json(res, 200, shownConversation(c));
      }
      case "POST /api/conversation/new": {
        const c = conversations.startNew();
        summarizeSoon();
        return json(res, 200, shownConversation(c));
      }
      case "GET /api/conversations": {
        // Every saved chat they said something in, most recently active first: no cap, so none goes missing.
        const current = conversations.current();
        const { conversations: all, unreadable } = conversations.list();
        const chats = all
          .filter((c) => messageCount(c) > 0)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((c) => ({ id: c.id, title: displayTitle(c), named: Boolean(c.title), startedAt: c.startedAt, updatedAt: c.updatedAt, messages: messageCount(c), preview: chatPreview(c), current: c.id === current.id }));
        return json(res, 200, { current: current.id, chats, unreadable });
      }
      case "POST /api/conversation/open": {
        // By id from the list, or by a few words ("the module 6 one") when asked by voice.
        const b = await body(req);
        const query = String(b.query ?? "").trim();
        const current = conversations.current();
        const found = b.id ? conversations.get(String(b.id)) : query ? findConversation(conversations, query, { excludeId: current.id }) : null;
        if (!found) return json(res, 404, { error: query ? `No chat matches "${query}".` : "That chat isn't saved anymore." });
        const c = conversations.open(found.id)!;
        if (c.id !== current.id) summarizeSoon(); // the one they left has ended
        return json(res, 200, shownConversation(c));
      }
      case "POST /api/conversation/rename": {
        const b = await body(req);
        const c = conversations.rename(String(b.id ?? ""), String(b.title ?? ""));
        if (!c) return json(res, 404, { error: "That chat isn't saved anymore." });
        return json(res, 200, { id: c.id, title: displayTitle(c), named: Boolean(c.title) });
      }
      case "POST /api/conversation/delete": {
        // It leaves the list, memory and search. Deleting the chat in progress starts a new one in its place.
        const b = await body(req);
        const id = String(b.id ?? "");
        const wasCurrent = conversations.current().id === id;
        if (!conversations.delete(id)) return json(res, 404, { error: "That chat isn't saved anymore." });
        const c = wasCurrent ? conversations.startNew() : conversations.current();
        return json(res, 200, { ok: true, deleted: id, current: shownConversation(c) });
      }
      case "POST /api/actions/confirm": {
        const b = await body(req);
        const p = take(String(b.id ?? ""));
        if (!p) return json(res, 410, { error: "That request expired. Ask again." });
        if (b.cancel === true) {
          conversations.append(conversations.current(), { role: "event", text: `They tapped Cancel, so this was not done: ${p.label}.` });
          return json(res, 200, { ok: true, text: "Cancelled." });
        }
        try {
          const text = await performPending(p, deps);
          conversations.append(conversations.current(), { role: "event", text: `They tapped ${p.verb} and it is already done (do not do it again): ${p.label}. Result: ${outcome(text)}`, done: { kind: p.kind, detail: p.detail } });
          return json(res, 200, { ok: true, text });
        } catch (err) {
          conversations.append(conversations.current(), { role: "event", text: `They confirmed, but ${p.label} failed: ${(err as Error).message}` });
          return json(res, 422, { error: (err as Error).message });
        }
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
        const speaker = o.speaker ?? (o.allowSpeech === false ? null : speak);
        if (!speaker) return json(res, 200, { ok: true, muted: true });
        // Cues are for voice conversations: the pill asks for them, read-aloud buttons don't.
        const asked = (b.cues ?? {}) as { start?: unknown; turn?: unknown };
        const spoken = await speaker(markdownToSpeech(text), { cues: { start: asked.start === true, turn: asked.turn === true } });
        return json(res, 200, { ok: true, engine: spoken.engine, fellBack: spoken.fellBack ?? null, stopped: spoken.stopped, cued: spoken.cued });
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

  const server = createServer(async (req, res) => {
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

  if (o.agentWatch) {
    const w = o.agentWatch;
    let watcher: Watcher | null = null;
    server.on("listening", () => {
      watcher = watchAgents({
        grid: o.agentGrid ?? new AgentGrid(),
        retryMs: w.retryMs,
        allowed: () => access().agents !== "off",
        log: Log,
        onFinished: async (_f, said) => {
          Log(`agent finished: ${said.line}`);
          // Written between messages, never in the middle of one, so a reply being saved can't drop it.
          const job = pillQueue.then(() => conversations.append(conversations.current(), { role: "event", text: said.line }));
          pillQueue = job.catch(() => undefined);
          await job;
          await (w.notifier ?? notify)(said.title, said.body);
          // Said out loud too: they may not be looking at the screen. A reply being spoken is cut short.
          const speaker = o.speaker ?? (o.allowSpeech === false ? null : speak);
          if (speaker) await speaker(said.speech, { cues: { start: false, turn: false } }).catch((err) => Log(`agent finished: couldn't say it: ${(err as Error).message}`));
        },
      });
    });
    server.on("close", () => watcher?.stop());
  }
  return server;
}
