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
import { EFFORTS, type ChatMessage, type Effort, type LLMProvider } from "./llm/types.js";
import { PERSONA } from "./persona.js";
import { DEFAULT_MESSAGES, loadPrompt } from "./prompts.js";
import { BRIEF_SCHEMA, type Brief } from "./schema.js";
import { ToolRuntime, toolsFor, type ToolCall } from "./tools.js";

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
  effort?: Effort;
  maxTurns?: number;
  context?: ContextBundle;
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
    (await buildContext({ config, intent, project: opts.project, today: opts.today, calendarProvider: opts.calendarProvider }));
  const runtime = new ToolRuntime(config, context.today);
  const tools = toolsFor(intent);
  const maxTurns = opts.maxTurns ?? 12;

  const instructions = `${PERSONA}\n\n# Task\n${await loadPrompt(intent)}`;
  const memory = `# Memory\n${renderContext(context)}`;
  const userMessage = (opts.message ?? "").trim() || DEFAULT_MESSAGES[intent];
  if (!userMessage) throw new Error(`Intent "${intent}" needs a message.`);
  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

  let turns = 0;
  let last: Awaited<ReturnType<LLMProvider["chat"]>> | undefined;
  while (turns < maxTurns) {
    turns++;
    const res = await provider.chat(
      {
        model: spec.model,
        instructions,
        context: memory,
        messages,
        tools,
        json: intent === "brief" ? { name: "brief", schema: BRIEF_SCHEMA as unknown as Record<string, unknown> } : undefined,
        effort: opts.effort ?? effortFromEnv(),
        maxTokens: 16000,
      },
      opts.onText,
    );
    last = res;

    if (res.stop === "refusal") throw new RefusedError();
    if (res.stop === "pause") {
      messages.push({ role: "assistant", text: res.text, toolCalls: [], providerData: res.providerData });
      continue;
    }
    if (res.stop !== "tool_use" || !res.toolCalls.length) break;

    messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, providerData: res.providerData });
    const results = [];
    for (const call of res.toolCalls) {
      const done = await runtime.execute(call.name, call.input);
      results.push({ id: call.id, content: done.result, isError: done.isError || undefined });
    }
    messages.push({ role: "tool", results });
  }
  if (!last) throw new Error("The model returned nothing.");

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
  };
}
