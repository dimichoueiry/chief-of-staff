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

/**
 * Tools the provider runs on its own servers. We never see the call: the model asks for it
 * mid-answer, the provider carries it out and folds the result in. No round trip through
 * ToolRuntime, and nothing opens on the user's screen.
 */
export interface ServerTools {
  /** Let the model look things up on the web itself: news, prices, facts it can't know. */
  webSearch?: {
    /** Results per search, where the provider takes that (OpenRouter). Keeps the context small. */
    maxResults?: number;
    /** How many searches one answer may run, where the provider takes that (Anthropic). */
    maxSearches?: number;
  };
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
  /** Offered alongside `tools`. A provider without them is simply asked without them. */
  serverTools?: ServerTools;
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
  /** webSearches is how many searches the provider ran for this answer, when it says. */
  usage?: { inputTokens: number; outputTokens: number; webSearches?: number };
}

export interface LLMProvider {
  readonly id: ProviderId;
  chat(req: ChatRequest, onText?: (delta: string) => void): Promise<ChatResponse>;
}
