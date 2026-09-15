/**
 * Any Chat Completions API through the official OpenAI SDK: OpenAI itself,
 * OpenRouter (hundreds of models behind one key), and OpenAI-compatible
 * servers such as Ollama or LM Studio. The differences are options, not code.
 */
import OpenAI from "openai";
import type { ChatMessage, ChatRequest, ChatResponse, JsonSchema, LLMProvider, ProviderId, StopReason, ToolCall } from "./types.js";

type Params = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.Completions.ChatCompletion;
type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface CompatOptions {
  id: Exclude<ProviderId, "anthropic">;
  /** How to ask for reasoning depth: OpenAI's reasoning_effort, OpenRouter's reasoning object, or not at all. */
  reasoning: "openai" | "openrouter" | "none";
  /** OpenAI reasoning models reject max_tokens; most compatible servers only know max_tokens. */
  maxTokensParam: "max_completion_tokens" | "max_tokens";
  /** Send response_format json_schema. Retried without it if the server rejects it. */
  structuredOutputs: boolean;
  /** OpenRouter returns reasoning_details that must be passed back across tool turns. */
  replayReasoningDetails: boolean;
}

/** OpenAI's strict schema mode rejects some keywords; the prompt and normalisation cover them. */
export function strictSchema(schema: JsonSchema): JsonSchema {
  const drop = new Set(["maxItems", "minItems", "format", "pattern"]);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !drop.has(k))
          .map(([k, val]) => [k, walk(val)]),
      );
    }
    return v;
  };
  return walk(schema) as JsonSchema;
}

function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[1-9])/.test(model);
}

function toMessages(req: ChatRequest, opts: CompatOptions): MessageParam[] {
  // One system message, stable part first, so prefix caching still applies.
  const out: MessageParam[] = [{ role: "system", content: `${req.instructions}\n\n${req.context}` }];
  for (const m of req.messages) {
    if (m.role === "user") {
      if (!m.images?.length) out.push({ role: "user", content: m.content });
      else {
        out.push({
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...m.images.map((img) => ({ type: "image_url" as const, image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
          ],
        });
      }
    }
    else if (m.role === "tool") {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.id, content: r.content });
    } else {
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = { role: "assistant", content: m.text || null };
      if (m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        }));
      }
      const details = (m.providerData as { reasoning_details?: unknown } | undefined)?.reasoning_details;
      if (opts.replayReasoningDetails && details !== undefined) {
        (msg as unknown as Record<string, unknown>).reasoning_details = details;
      }
      out.push(msg);
    }
  }
  return out;
}

export function buildCompatParams(req: ChatRequest, opts: CompatOptions): Params {
  const params: Params = { model: req.model, messages: toMessages(req, opts) };
  if (opts.maxTokensParam === "max_completion_tokens") params.max_completion_tokens = req.maxTokens;
  else params.max_tokens = req.maxTokens;
  if (req.tools.length) {
    params.tools = req.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.json && opts.structuredOutputs) {
    params.response_format = {
      type: "json_schema",
      json_schema: { name: req.json.name, schema: strictSchema(req.json.schema), strict: true },
    };
  }
  if (req.effort) {
    if (opts.reasoning === "openai" && isReasoningModel(req.model)) params.reasoning_effort = req.effort;
    if (opts.reasoning === "openrouter") (params as unknown as Record<string, unknown>).reasoning = { effort: req.effort };
  }
  return params;
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    // Returned to the model as a tool error by the runtime ("name is required"), which lets it retry.
    return { _unparsed: raw };
  }
}

const FINISH: Record<string, StopReason> = {
  stop: "end",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

export function parseCompletion(c: Completion): ChatResponse {
  const choice = c.choices[0];
  if (!choice) return { text: "", toolCalls: [], stop: "end", model: c.model };
  const msg = choice.message;
  const toolCalls: ToolCall[] = [];
  for (const tc of msg.tool_calls ?? []) {
    if (tc.type === "function") toolCalls.push({ id: tc.id, name: tc.function.name, input: parseArguments(tc.function.arguments) });
  }
  let stop = FINISH[choice.finish_reason ?? ""] ?? "end";
  if (toolCalls.length) stop = "tool_use";
  if (msg.refusal) stop = "refusal";
  const details = (msg as unknown as { reasoning_details?: unknown }).reasoning_details;
  return {
    text: (msg.content ?? "").trim(),
    toolCalls,
    stop,
    providerData: details !== undefined ? { reasoning_details: details } : undefined,
    model: c.model,
    usage: c.usage ? { inputTokens: c.usage.prompt_tokens, outputTokens: c.usage.completion_tokens } : undefined,
  };
}

export type CompatSend = (params: Params) => Promise<Completion>;

export function defaultCompatSend(client: OpenAI): CompatSend {
  return (params) => client.chat.completions.create(params);
}

function isBadRequest(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 400;
}

export class CompatProvider implements LLMProvider {
  readonly id: Exclude<ProviderId, "anthropic">;

  constructor(
    private readonly opts: CompatOptions,
    private readonly send: CompatSend,
  ) {
    this.id = opts.id;
  }

  async chat(req: ChatRequest, onText?: (delta: string) => void): Promise<ChatResponse> {
    const params = buildCompatParams(req, this.opts);
    let completion: Completion;
    try {
      completion = await this.send(params);
    } catch (err) {
      // Not every model behind OpenRouter or a local server accepts a JSON schema: fall back to prompt-only JSON.
      if (!params.response_format || !isBadRequest(err)) throw err;
      const { response_format: _dropped, ...rest } = params;
      completion = await this.send(rest);
    }
    const res = parseCompletion(completion);
    if (onText && res.text) onText(res.text);
    return res;
  }
}
