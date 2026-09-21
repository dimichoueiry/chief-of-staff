/**
 * The orchestrator: one tool-use loop, whatever the model. Loads context,
 * picks the prompt template for the intent, exposes the right tools, and
 * talks to the chosen provider only through the neutral LLMProvider contract.
 */
import type { Config } from "../config.js";
import { buildContext, renderContext, type ContextBundle, type Intent } from "../core/context.js";
import { greetingFor } from "../logic/brief.js";
import type { CalendarProvider } from "../sensors/calendar.js";
import { longDate } from "../util/dates.js";
import { extractJson, normalizeBrief } from "./llm/json.js";
import {
  NoModelError, createProvider, explainNotReady, formatSpec, resolveModel,
  type ModelIntent, type ModelSpec,
} from "./llm/registry.js";
import { EFFORTS, type ChatMessage, type Effort, type ImageInput, type LLMProvider, type ToolResult } from "./llm/types.js";
import { persona } from "./persona.js";
import { DEFAULT_MESSAGES, loadPrompt } from "./prompts.js";
import { BRIEF_SCHEMA, type Brief } from "./schema.js";
import { ToolRuntime, serverToolsFor, toolsFor, type ToolCall } from "./tools.js";
import type { Pending } from "../actions/pending.js";
import type { ArtifactRef } from "../core/artifacts.js";
import { isPageText } from "../actions/browser.js";
import { step } from "../util/trace.js";

export interface RunOptions {
  config: Config;
  intent: Intent;
  message?: string;
  project?: string;
  today?: string;
  calendarProvider?: CalendarProvider;
  /** provider:model for this one run, e.g. openai:gpt-5.4. */
  modelFlag?: string;
  /** Inject a provider (tests). Skips resolution; `spec` names what it pretends to be. */
  llm?: { provider: LLMProvider; spec: ModelSpec };
  onText?: (delta: string) => void;
  /** Called before each tool runs, so a UI can say what is happening. */
  onTool?: (name: string, input: Record<string, unknown>) => void;
  /** Earlier messages in this conversation, oldest first (see conversation.ts). */
  history?: ChatMessage[];
  /** Images sent with the message, e.g. a screenshot taken because they said "look at this". */
  images?: ImageInput[];
  /** Summaries of earlier conversations, added to memory (see recall.ts). */
  recall?: string;
  effort?: Effort;
  maxTurns?: number;
  context?: ContextBundle;
  /** Replace how things are opened and where Slate boards come from (tests). */
  actions?: ToolRuntime["actions"];
}

export interface RunResult {
  text: string;
  brief?: Brief;
  toolCalls: ToolCall[];
  context: ContextBundle;
  turns: number;
  stopReason: string;
  /** provider:model that handled the run. */
  model: string;
  /** Things the model wants to do that wait for the user's OK. */
  pending: Pending[];
  /** How many web searches the provider ran for this answer, across every turn. */
  webSearches: number;
  /** Actions carried out in this run, so a later message doesn't repeat them. */
  done: { kind: string; detail: string }[];
  /** Pictures and pages made in this run, to show with the reply. */
  artifacts: ArtifactRef[];
  /** The tool calls and results of this run, without provider-specific data, for the conversation record. */
  steps: ChatMessage[];
}

/**
 * Tools whose result is the whole page. A browser run reads the page at every step, so by its fifth
 * step the conversation holds five pages and sends every one of them again. Only the newest says
 * anything true about the page now; the rest are replaced with a line saying where they went.
 */
const PAGE_TOOLS = new Set(["browser_open", "browser_read", "browser_click", "browser_type", "browser_select", "browser_back", "browser_do"]);

const PAGE_DROPPED = "(A page read earlier in this run. Only the latest read is kept; read the page again if you still need it.)";

/** The messages as the model should see them, without altering the record they came from. */
export function withoutOldPages(messages: ChatMessage[]): ChatMessage[] {
  const name = new Map<string, string>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.toolCalls) name.set(c.id, c.name);
  // A browser tool answers with a page, or with a line saying why there isn't one ("Not clicked yet:
  // it needs their OK"). Counting the second as the newest page throws away the only page there was,
  // and the model then answers about a page it can no longer see.
  const isPage = (r: ToolResult) => !r.isError && PAGE_TOOLS.has(name.get(r.id) ?? "") && isPageText(r.content);
  const pages = messages.flatMap((m) => (m.role === "tool" ? m.results.filter(isPage) : []));
  if (pages.length < 2) return messages;
  const newest = pages.at(-1);
  return messages.map((m) =>
    m.role === "tool"
      ? { role: "tool", results: m.results.map((r) => (isPage(r) && r !== newest ? { ...r, content: PAGE_DROPPED } : r)) }
      : m,
  );
}

export class RefusedError extends Error {
  constructor(message = "The model declined this request.") {
    super(message);
    this.name = "RefusedError";
  }
}

export function effortFromEnv(env: NodeJS.ProcessEnv = process.env): Effort {
  const e = (env.COS_EFFORT ?? "").toLowerCase();
  return (EFFORTS as readonly string[]).includes(e) ? (e as Effort) : "medium";
}

/** Resolve the provider for an intent or explain exactly what is missing. */
export function providerFor(intent: ModelIntent, modelFlag?: string): { provider: LLMProvider; spec: ModelSpec } {
  const resolved = resolveModel(intent, { flag: modelFlag });
  if (!resolved || !resolved.ready) throw new NoModelError(explainNotReady(intent, resolved));
  return { provider: createProvider(resolved.spec), spec: resolved.spec };
}

export async function runIntent(opts: RunOptions): Promise<RunResult> {
  const { config, intent } = opts;
  if (intent === "silence-check") throw new Error("silence-check does not use a model");
  const { provider, spec } = opts.llm ?? providerFor(intent, opts.modelFlag);

  const context =
    opts.context ??
    (await buildContext({ config, intent, project: opts.project, today: opts.today, calendarProvider: opts.calendarProvider, query: opts.message }));
  const runtime = new ToolRuntime(config, context.today, opts.calendarProvider, opts.actions);
  const tools = toolsFor(intent);
  const serverTools = serverToolsFor(intent);
  const maxTurns = opts.maxTurns ?? 12;

  const instructions = `${persona()}\n\n# Task\n${await loadPrompt(intent)}`;
  const recall = intent === "brief" ? "" : (opts.recall ?? "");
  const memory = `# Memory\n${renderContext(context)}${recall ? `\n\n${recall}` : ""}`;
  const userMessage = (opts.message ?? "").trim() || DEFAULT_MESSAGES[intent];
  if (!userMessage) throw new Error(`Intent "${intent}" needs a message.`);
  const history = intent === "brief" ? [] : (opts.history ?? []);
  const messages: ChatMessage[] = [...history, { role: "user", content: userMessage, ...(opts.images?.length ? { images: opts.images } : {}) }];
  const firstNew = messages.length;

  let turns = 0;
  let webSearches = 0;
  let last: Awaited<ReturnType<LLMProvider["chat"]>> | undefined;
  while (turns < maxTurns) {
    turns++;
    const res = await provider.chat(
      {
        model: spec.model,
        instructions,
        context: memory,
        messages: withoutOldPages(messages),
        tools,
        serverTools,
        json: intent === "brief" ? { name: "brief", schema: BRIEF_SCHEMA as unknown as Record<string, unknown> } : undefined,
        effort: opts.effort ?? effortFromEnv(),
        maxTokens: 16000,
      },
      opts.onText,
    );
    last = res;
    webSearches += res.usage?.webSearches ?? 0;
    step("model", `turn ${turns}: ${res.stop}${res.toolCalls.length ? `, wants ${res.toolCalls.map((c) => c.name).join(", ")}` : ""}`, {
      model: res.model, ...(res.usage ? { in: res.usage.inputTokens, out: res.usage.outputTokens } : {}),
    });

    if (res.stop === "refusal") throw new RefusedError();
    if (res.stop === "pause") {
      messages.push({ role: "assistant", text: res.text, toolCalls: [], providerData: res.providerData });
      continue;
    }
    if (res.stop !== "tool_use" || !res.toolCalls.length) break;

    messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, providerData: res.providerData });
    const results = [];
    const images: ImageInput[] = [];
    for (const call of res.toolCalls) {
      opts.onTool?.(call.name, call.input);
      const began = Date.now();
      const done = await runtime.execute(call.name, call.input);
      step("tool", `${call.name} ${JSON.stringify(call.input)}`, { ms: Date.now() - began, ...(done.isError ? { failed: true } : {}) });
      step("result", done.result.split("\n")[0] ?? "", { turn: turns });
      results.push({ id: call.id, content: done.result, isError: done.isError || undefined });
      images.push(...(done.images ?? []));
    }
    messages.push({ role: "tool", results });
    // Tool results can't carry images on every provider, so a screenshot follows as its own message. It isn't kept in the record.
    if (images.length) messages.push({ role: "user", content: "(The screenshot you just took.)", images });
  }
  if (!last) throw new Error("The model returned nothing.");
  // The last turn of the cap is usually another tool call, which carries no words: without this the
  // reply is empty and a minute of work looks to them like nothing happened at all.
  if (turns >= maxTurns && last.stop === "tool_use" && !last.text.trim()) {
    const did = runtime.calls.filter((c) => !c.isError).map((c) => c.name);
    const tally = [...new Set(did)].map((n) => `${n}${did.filter((x) => x === n).length > 1 ? ` ×${did.filter((x) => x === n).length}` : ""}`);
    last = {
      ...last,
      text: `I ran out of steps before finishing that (${maxTurns} in one go)${tally.length ? `. I got as far as: ${tally.join(", ")}` : ""}. Tell me to carry on and I'll pick up where I stopped.`,
    };
    step("error", `ran out of turns at ${maxTurns} with nothing said`, { tools: did.length });
  }

  let brief: Brief | undefined;
  if (intent === "brief") {
    let raw: unknown;
    try {
      raw = extractJson(last.text);
    } catch {
      throw new Error(`${formatSpec(spec)} did not return a readable brief:\n${last.text.slice(0, 400)}`);
    }
    brief = normalizeBrief(raw, {
      greeting: greetingFor(context.name),
      date: context.today,
      headline: longDate(context.today),
    });
  }

  return {
    text: last.text,
    brief,
    toolCalls: runtime.calls,
    context,
    turns,
    stopReason: last.stop,
    model: formatSpec(spec),
    pending: runtime.pending,
    webSearches,
    done: runtime.done,
    artifacts: runtime.artifacts,
    steps: messages
      .slice(firstNew)
      .flatMap((m): ChatMessage[] => {
        if (m.role === "tool") return [m];
        if (m.role === "assistant" && m.toolCalls.length) return [{ role: "assistant", text: m.text, toolCalls: m.toolCalls }];
        return [];
      }),
  };
}
