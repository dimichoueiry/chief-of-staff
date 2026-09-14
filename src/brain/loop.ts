/**
 * The orchestrator: one Claude tool-use loop. Loads context, picks the prompt
 * template for the intent, exposes the right tools, streams the answer.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import { buildContext, renderContext, type ContextBundle, type Intent } from "../core/context.js";
import type { CalendarProvider } from "../sensors/calendar.js";
import { PERSONA } from "./persona.js";
import { DEFAULT_MESSAGES, loadPrompt } from "./prompts.js";
import { BRIEF_SCHEMA, type Brief } from "./schema.js";
import { ToolRuntime, toolsFor, type ToolCall } from "./tools.js";

/** One model call. Injectable so the loop can be tested without the network. */
export type ModelCall = (
  params: Anthropic.MessageStreamParams,
  onText?: (delta: string) => void,
) => Promise<Anthropic.Message>;

export function defaultModelCall(client: Anthropic = new Anthropic()): ModelCall {
  return async (params, onText) => {
    const stream = client.messages.stream(params);
    if (onText) stream.on("text", onText);
    return stream.finalMessage();
  };
}

export interface RunOptions {
  config: Config;
  intent: Intent;
  message?: string;
  project?: string;
  today?: string;
  calendarProvider?: CalendarProvider;
  model?: ModelCall;
  onText?: (delta: string) => void;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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
}

export class RefusedError extends Error {
  constructor(message = "The model declined this request.") {
    super(message);
    this.name = "RefusedError";
  }
}

export async function runIntent(opts: RunOptions): Promise<RunResult> {
  const { config, intent } = opts;
  const context =
    opts.context ??
    (await buildContext({ config, intent, project: opts.project, today: opts.today, calendarProvider: opts.calendarProvider }));
  const runtime = new ToolRuntime(config, context.today);
  const tools = toolsFor(intent);
  const call = opts.model ?? defaultModelCall();
  const maxTurns = opts.maxTurns ?? 12;

  const system: Anthropic.TextBlockParam[] = [
    // Stable across every request: cacheable.
    { type: "text", text: `${PERSONA}\n\n# Task\n${await loadPrompt(intent)}`, cache_control: { type: "ephemeral" } },
    // Changes daily: after the cache breakpoint.
    { type: "text", text: `# Memory\n${renderContext(context)}` },
  ];

  const userMessage = (opts.message ?? "").trim() || DEFAULT_MESSAGES[intent];
  if (!userMessage) throw new Error(`Intent "${intent}" needs a message.`);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

  const params: Anthropic.MessageStreamParams = {
    model: config.model,
    max_tokens: 16000,
    system,
    messages,
    thinking: { type: "adaptive" },
    output_config: {
      effort: opts.effort ?? (process.env.COS_EFFORT as RunOptions["effort"]) ?? "medium",
      ...(intent === "brief" ? { format: { type: "json_schema", schema: BRIEF_SCHEMA } } : {}),
    },
    ...(tools.length ? { tools } : {}),
  };

  let turns = 0;
  let final: Anthropic.Message | undefined;
  while (turns < maxTurns) {
    turns++;
    const response = await call(params, opts.onText);
    final = response;

    if (response.stop_reason === "refusal") throw new RefusedError();
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason !== "tool_use") break;

    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      const done = await runtime.execute(use.name, (use.input ?? {}) as Record<string, unknown>);
      results.push({ type: "tool_result", tool_use_id: use.id, content: done.result, is_error: done.isError || undefined });
    }
    messages.push({ role: "user", content: results });
  }
  if (!final) throw new Error("The model returned nothing.");

  const text = final.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  let brief: Brief | undefined;
  if (intent === "brief") {
    try {
      brief = JSON.parse(text) as Brief;
    } catch {
      throw new Error(`The model did not return a valid brief:\n${text}`);
    }
  }

  return { text, brief, toolCalls: runtime.calls, context, turns, stopReason: final.stop_reason ?? "unknown" };
}
