/** Claude through the official Anthropic SDK. */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider, StopReason, ToolCall } from "./types.js";

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.BetaMessage;

/** Models that take adaptive thinking and the effort setting. Older ones get neither. */
export function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(fable|mythos|opus-5|sonnet-5|opus-4-[678]|sonnet-4-6)/.test(model);
}

/** Models where a safety decline can be re-run on another model inside the same call. */
export function supportsRefusalFallback(model: string): boolean {
  return /^claude-(opus-5|fable-5-1)$/.test(model);
}

function toMessages(messages: ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m): Anthropic.Beta.BetaMessageParam => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "tool") {
      return {
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      };
    }
    // Replay Claude's own blocks untouched: thinking blocks must come back exactly as sent.
    if (Array.isArray(m.providerData)) {
      return { role: "assistant", content: m.providerData as Anthropic.Beta.BetaContentBlockParam[] };
    }
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (m.text) content.push({ type: "text", text: m.text });
    for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    return { role: "assistant", content };
  });
}

export function buildAnthropicParams(req: ChatRequest): Params {
  const adaptive = supportsAdaptiveThinking(req.model);
  const params: Params = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [
      { type: "text", text: req.instructions, cache_control: { type: "ephemeral" } },
      { type: "text", text: req.context },
    ],
    messages: toMessages(req.messages),
  };
  if (req.tools.length) {
    params.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.BetaTool["input_schema"],
    }));
  }
  if (adaptive) params.thinking = { type: "adaptive" };
  const outputConfig: NonNullable<Params["output_config"]> = {};
  if (adaptive && req.effort) outputConfig.effort = req.effort;
  if (req.json) outputConfig.format = { type: "json_schema", schema: req.json.schema };
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;
  if (supportsRefusalFallback(req.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

const STOP: Record<string, StopReason> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
  pause_turn: "pause",
};

export function parseAnthropicMessage(msg: Message): ChatResponse {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of msg.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
    }
  }
  return {
    text: text.trim(),
    toolCalls,
    stop: STOP[msg.stop_reason ?? ""] ?? "end",
    providerData: msg.content,
    model: msg.model,
    usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
  };
}

export type AnthropicSend = (params: Params, onText?: (delta: string) => void) => Promise<Message>;

export function defaultAnthropicSend(client: Anthropic = new Anthropic()): AnthropicSend {
  return async (params, onText) => {
    const stream = client.beta.messages.stream(params);
    if (onText) stream.on("text", onText);
    return stream.finalMessage();
  };
}

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  private sendFn?: AnthropicSend;

  constructor(send?: AnthropicSend) {
    this.sendFn = send;
  }

  async chat(req: ChatRequest, onText?: (delta: string) => void): Promise<ChatResponse> {
    this.sendFn ??= defaultAnthropicSend();
    return parseAnthropicMessage(await this.sendFn(buildAnthropicParams(req), onText));
  }
}
