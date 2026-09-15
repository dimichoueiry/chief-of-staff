import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  AnthropicProvider, buildAnthropicParams, parseAnthropicMessage, supportsAdaptiveThinking, supportsRefusalFallback,
} from "../src/brain/llm/anthropic.js";
import { extractJson, normalizeBrief } from "../src/brain/llm/json.js";
import { CompatProvider, buildCompatParams, parseCompletion, strictSchema, type CompatOptions } from "../src/brain/llm/openai.js";
import type { ChatRequest } from "../src/brain/llm/types.js";

const baseRequest = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "claude-opus-5",
  instructions: "PERSONA+TASK",
  context: "# Memory",
  messages: [
    { role: "user", content: "file this" },
    { role: "assistant", text: "Filing.", toolCalls: [{ id: "t1", name: "add_note", input: { text: "x" } }] },
    { role: "tool", results: [{ id: "t1", content: "Noted: x" }, { id: "t2", content: "Error: bad", isError: true }] },
  ],
  tools: [{ name: "add_note", description: "keep a note", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
  effort: "medium",
  maxTokens: 16000,
  ...over,
});

describe("Anthropic adapter", () => {
  it("puts cached instructions before the memory, maps tools and tool results", () => {
    const p = buildAnthropicParams(baseRequest());
    expect(p.system).toEqual([
      { type: "text", text: "PERSONA+TASK", cache_control: { type: "ephemeral" } },
      { type: "text", text: "# Memory" },
    ]);
    expect(p.tools?.[0]).toMatchObject({ name: "add_note", input_schema: { type: "object" } });
    expect(p.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Filing." }, { type: "tool_use", id: "t1", name: "add_note", input: { text: "x" } }],
    });
    expect(p.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "Noted: x" },
        { type: "tool_result", tool_use_id: "t2", content: "Error: bad", is_error: true },
      ],
    });
  });

  it("uses adaptive thinking, effort and refusal fallbacks only where the model supports them", () => {
    const opus5 = buildAnthropicParams(baseRequest());
    expect(opus5.thinking).toEqual({ type: "adaptive" });
    expect(opus5.output_config).toEqual({ effort: "medium" });
    expect(opus5.fallbacks).toBe("default");
    expect(opus5.betas).toEqual(["server-side-fallback-2026-07-01"]);

    const haiku = buildAnthropicParams(baseRequest({ model: "claude-haiku-4-5", json: { name: "brief", schema: { type: "object" } } }));
    expect(haiku.thinking).toBeUndefined();
    expect(haiku.fallbacks).toBeUndefined();
    expect(haiku.output_config).toEqual({ format: { type: "json_schema", schema: { type: "object" } } });

    expect(supportsAdaptiveThinking("claude-sonnet-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-4-5")).toBe(false);
    expect(supportsRefusalFallback("claude-fable-5-1")).toBe(true);
    expect(supportsRefusalFallback("claude-sonnet-5")).toBe(false);
  });

  it("replays Claude's own content blocks untouched", () => {
    const blocks = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "t1", name: "add_note", input: {} }];
    const p = buildAnthropicParams(baseRequest({ messages: [{ role: "user", content: "hi" }, { role: "assistant", text: "", toolCalls: [], providerData: blocks }] }));
    expect(p.messages[1]).toEqual({ role: "assistant", content: blocks });
  });

  it("parses text, tool calls and stop reasons, ignoring thinking and fallback blocks", async () => {
    const msg = {
      model: "claude-opus-5",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "Filing " },
        { type: "text", text: "now." },
        { type: "tool_use", id: "t9", name: "add_note", input: { text: "y" } },
      ],
    } as unknown as Anthropic.Beta.BetaMessage;
    const r = parseAnthropicMessage(msg);
    expect(r).toMatchObject({ text: "Filing now.", stop: "tool_use", toolCalls: [{ id: "t9", name: "add_note", input: { text: "y" } }], usage: { inputTokens: 10, outputTokens: 5 } });
    expect(r.providerData).toBe(msg.content);
    expect(parseAnthropicMessage({ ...msg, stop_reason: "pause_turn" } as Anthropic.Beta.BetaMessage).stop).toBe("pause");
    expect(parseAnthropicMessage({ ...msg, stop_reason: "refusal" } as Anthropic.Beta.BetaMessage).stop).toBe("refusal");

    let sent: unknown;
    const provider = new AnthropicProvider(async (params) => ((sent = params), msg));
    expect((await provider.chat(baseRequest())).text).toBe("Filing now.");
    expect(sent).toMatchObject({ model: "claude-opus-5" });
  });
});

const OPENAI: CompatOptions = { id: "openai", reasoning: "openai", maxTokensParam: "max_completion_tokens", structuredOutputs: true, replayReasoningDetails: false };
const OPENROUTER: CompatOptions = { id: "openrouter", reasoning: "openrouter", maxTokensParam: "max_tokens", structuredOutputs: true, replayReasoningDetails: true };

describe("OpenAI-compatible adapter", () => {
  it("builds one system message, function tools, assistant tool_calls and tool messages", () => {
    const p = buildCompatParams(baseRequest({ model: "gpt-5.4" }), OPENAI);
    expect(p.messages[0]).toEqual({ role: "system", content: "PERSONA+TASK\n\n# Memory" });
    expect(p.messages[2]).toEqual({
      role: "assistant",
      content: "Filing.",
      tool_calls: [{ id: "t1", type: "function", function: { name: "add_note", arguments: '{"text":"x"}' } }],
    });
    expect(p.messages.slice(3)).toEqual([
      { role: "tool", tool_call_id: "t1", content: "Noted: x" },
      { role: "tool", tool_call_id: "t2", content: "Error: bad" },
    ]);
    expect(p.tools?.[0]).toEqual({ type: "function", function: { name: "add_note", description: "keep a note", parameters: expect.any(Object) } });
    expect(p.max_completion_tokens).toBe(16000);
    expect(p.reasoning_effort).toBe("medium");
  });

  it("sends reasoning effort the way each provider expects, and only to reasoning models on OpenAI", () => {
    expect(buildCompatParams(baseRequest({ model: "gpt-4.1" }), OPENAI).reasoning_effort).toBeUndefined();
    const or = buildCompatParams(baseRequest({ model: "openai/gpt-5.2" }), OPENROUTER) as unknown as Record<string, unknown>;
    expect(or.reasoning).toEqual({ effort: "medium" });
    expect(or.max_tokens).toBe(16000);
    expect(or.reasoning_effort).toBeUndefined();
  });

  it("asks for strict JSON schema output with unsupported keywords removed", () => {
    const schema = { type: "object", properties: { focus: { type: "array", maxItems: 3, items: { type: "string" } } } };
    const p = buildCompatParams(baseRequest({ model: "gpt-5.4", json: { name: "brief", schema } }), OPENAI);
    expect(p.response_format).toEqual({ type: "json_schema", json_schema: { name: "brief", schema: { type: "object", properties: { focus: { type: "array", items: { type: "string" } } } }, strict: true } });
    expect(strictSchema(schema)).not.toHaveProperty("properties.focus.maxItems");
    const local = buildCompatParams(baseRequest({ model: "llama3.2", json: { name: "brief", schema } }), { ...OPENROUTER, id: "compatible", structuredOutputs: false, reasoning: "none" });
    expect(local.response_format).toBeUndefined();
  });

  it("replays OpenRouter reasoning_details across tool turns", () => {
    const req = baseRequest({ model: "~anthropic/claude-sonnet-latest", messages: [{ role: "user", content: "hi" }, { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "add_note", input: {} }], providerData: { reasoning_details: [{ type: "reasoning.text" }] } }] });
    const or = buildCompatParams(req, OPENROUTER);
    expect((or.messages[2] as unknown as Record<string, unknown>).reasoning_details).toEqual([{ type: "reasoning.text" }]);
    expect((buildCompatParams(req, OPENAI).messages[2] as unknown as Record<string, unknown>).reasoning_details).toBeUndefined();
  });

  const completion = (message: Record<string, unknown>, finish = "stop") =>
    ({ model: "gpt-5.4-2026", choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: null, refusal: null, ...message } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }) as unknown as OpenAI.Chat.Completions.ChatCompletion;

  it("parses tool calls (including broken JSON), finish reasons and refusals", () => {
    const r = parseCompletion(completion({ tool_calls: [
      { id: "c1", type: "function", function: { name: "add_note", arguments: '{"text":"hi"}' } },
      { id: "c2", type: "function", function: { name: "add_note", arguments: "{not json" } },
    ] }, "tool_calls"));
    expect(r.stop).toBe("tool_use");
    expect(r.toolCalls).toEqual([
      { id: "c1", name: "add_note", input: { text: "hi" } },
      { id: "c2", name: "add_note", input: { _unparsed: "{not json" } },
    ]);
    expect(r.model).toBe("gpt-5.4-2026");
    expect(parseCompletion(completion({ content: " done " })).text).toBe("done");
    expect(parseCompletion(completion({ content: "x" }, "length")).stop).toBe("max_tokens");
    expect(parseCompletion(completion({ refusal: "no" })).stop).toBe("refusal");
    expect(parseCompletion(completion({ content: "x", reasoning_details: [1] })).providerData).toEqual({ reasoning_details: [1] });
  });

  it("retries without response_format when a model rejects JSON schema output", async () => {
    const sent: Record<string, unknown>[] = [];
    const provider = new CompatProvider(OPENROUTER, async (params) => {
      sent.push(params as unknown as Record<string, unknown>);
      if (params.response_format) throw Object.assign(new Error("response_format not supported"), { status: 400 });
      return completion({ content: '{"greeting":"hi"}' });
    });
    const streamed: string[] = [];
    const r = await provider.chat(baseRequest({ model: "some/model", json: { name: "brief", schema: { type: "object" } } }), (t) => streamed.push(t));
    expect(sent).toHaveLength(2);
    expect(sent[1].response_format).toBeUndefined();
    expect(r.text).toBe('{"greeting":"hi"}');
    expect(streamed).toEqual(['{"greeting":"hi"}']);

    const failing = new CompatProvider(OPENAI, async () => {
      throw Object.assign(new Error("server down"), { status: 500 });
    });
    await expect(failing.chat(baseRequest({ model: "gpt-5.4", json: { name: "b", schema: {} } }))).rejects.toThrow("server down");
  });
});

describe("lenient brief JSON", () => {
  it("finds JSON bare, fenced or wrapped in prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure!\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Here you go: {"a":3} hope that helps')).toEqual({ a: 3 });
    expect(() => extractJson("no json here")).toThrow();
  });

  it("normalises missing or malformed fields and caps focus at three", () => {
    const b = normalizeBrief(
      { focus: [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }, { why: "no title" }], decisions: [{ question: "keep?" }], nudges: ["n", 3, ""], schedule: "nope" },
      { greeting: "Good morning", date: "2026-09-17", headline: "Thursday" },
    );
    expect(b.greeting).toBe("Good morning");
    expect(b.focus.map((f) => f.title)).toEqual(["a", "b", "c"]);
    expect(b.focus[0].size).toBe("1 hour");
    expect(b.decisions[0].options).toEqual(["keep", "park", "kill"]);
    expect(b.schedule).toEqual([]);
    expect(b.nudges).toEqual(["n"]);
  });
});
