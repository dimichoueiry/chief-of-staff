/**
 * The provider-neutral contract between the loop and a model. The loop only
 * speaks these types; each adapter translates to and from one API.
 */

export type ProviderId = "anthropic" | "openai" | "openrouter" | "compatible";

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/** An image to show the model, e.g. a screenshot. */
export interface ImageInput {
  mediaType: "image/jpeg" | "image/png";
  /** Base64, no data: prefix. */
  data: string;
}

export type ChatMessage =
  | { role: "user"; content: string; images?: ImageInput[] }
  /** providerData carries what the same provider needs replayed next turn (thinking blocks, reasoning details). */
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; providerData?: unknown }
  | { role: "tool"; results: ToolResult[] };

export type Effort = "low" | "medium" | "high";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high"];

export interface ChatRequest {
  model: string;
  /** Identical across requests: persona and task. Goes first so providers can cache it. */
  instructions: string;
  /** Changes per request: the rendered memory. Goes after the instructions. */
  context: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  /** Ask for one JSON object matching this schema instead of prose. */
  json?: { name: string; schema: JsonSchema };
  effort?: Effort;
  maxTokens: number;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "pause";

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
  providerData?: unknown;
  /** The model that actually answered, as the provider reports it. */
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  readonly id: ProviderId;
  chat(req: ChatRequest, onText?: (delta: string) => void): Promise<ChatResponse>;
}
