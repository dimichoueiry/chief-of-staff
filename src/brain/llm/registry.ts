/**
 * Which model answers which intent. A model is written provider:model, e.g.
 *   anthropic:claude-opus-5
 *   openai:gpt-5.4
 *   openrouter:openai/gpt-5.2      (anything on OpenRouter, slashes and colons allowed)
 *   compatible:llama3.2            (an OpenAI-compatible server at COS_COMPATIBLE_BASE_URL)
 *
 * Precedence, highest first:
 *   --model flag  >  models.json per intent  >  models.json default  >  COS_MODEL  >  first provider with a key
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import OpenAI from "openai";
import { cosHome } from "../../util/home.js";
import { AnthropicProvider } from "./anthropic.js";
import { CompatProvider, defaultCompatSend } from "./openai.js";
import type { LLMProvider, ProviderId } from "./types.js";

export const MODEL_INTENTS = ["brief", "ask", "focus", "capture", "wrap"] as const;
export type ModelIntent = (typeof MODEL_INTENTS)[number];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Any one of these set means the provider is usable. */
  keyEnv: string[];
  defaultModel: string;
  examples: string[];
  keyUrl: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    keyEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    defaultModel: "claude-opus-5",
    examples: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1"],
    keyUrl: "https://console.anthropic.com",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    keyEnv: ["OPENAI_API_KEY"],
    defaultModel: "gpt-5.4",
    examples: ["gpt-5.4", "gpt-5.2"],
    keyUrl: "https://platform.openai.com/api-keys",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    keyEnv: ["OPENROUTER_API_KEY"],
    defaultModel: "openrouter/auto",
    examples: ["openrouter/auto", "~anthropic/claude-sonnet-latest", "openai/gpt-5.2"],
    keyUrl: "https://openrouter.ai/keys",
  },
  compatible: {
    id: "compatible",
    label: "OpenAI-compatible server (Ollama, LM Studio, …)",
    keyEnv: ["COS_COMPATIBLE_BASE_URL"],
    defaultModel: "",
    examples: ["llama3.2", "qwen3"],
    keyUrl: "set COS_COMPATIBLE_BASE_URL, e.g. http://localhost:11434/v1 for Ollama",
  },
};

export const PROVIDER_ORDER: ProviderId[] = ["anthropic", "openai", "openrouter", "compatible"];

export interface ModelSpec {
  provider: ProviderId;
  model: string;
}

export function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_ORDER as string[]).includes(s);
}

export function formatSpec(spec: ModelSpec): string {
  return `${spec.provider}:${spec.model}`;
}

export function parseModelSpec(input: string, env: NodeJS.ProcessEnv = process.env): ModelSpec {
  const s = input.trim();
  if (!s) throw new Error("Empty model. Use provider:model, e.g. anthropic:claude-opus-5");
  const lower = s.toLowerCase();
  if (isProviderId(lower)) return { provider: lower, model: defaultModelFor(lower, env) };
  const colon = s.indexOf(":");
  if (colon > 0) {
    const prefix = s.slice(0, colon).toLowerCase();
    if (isProviderId(prefix)) {
      const model = s.slice(colon + 1).trim() || defaultModelFor(prefix, env);
      return { provider: prefix, model };
    }
  }
  if (/^claude-/.test(s)) return { provider: "anthropic", model: s };
  if (/^(gpt-|chatgpt-|o[1-9](\b|-|$))/.test(s)) return { provider: "openai", model: s };
  if (s.includes("/")) return { provider: "openrouter", model: s };
  throw new Error(
    `Can't tell which provider "${s}" belongs to. Write it as provider:model — anthropic:claude-opus-5, openai:gpt-5.4, openrouter:openai/gpt-5.2, compatible:llama3.2`,
  );
}

function defaultModelFor(provider: ProviderId, env: NodeJS.ProcessEnv): string {
  if (provider === "compatible") {
    const m = env.COS_COMPATIBLE_MODEL;
    if (!m) throw new Error("compatible needs a model name: compatible:<model> or COS_COMPATIBLE_MODEL");
    return m;
  }
  return PROVIDERS[provider].defaultModel;
}

export function providerConfigured(provider: ProviderId, env: NodeJS.ProcessEnv = process.env): boolean {
  return PROVIDERS[provider].keyEnv.some((k) => Boolean(env[k]));
}

// ---------- ~/.cos/models.json ----------

export interface ModelSettings {
  default?: string;
  intents?: Partial<Record<ModelIntent, string>>;
  /** Extra models to offer in the menubar picker. */
  presets?: string[];
}

export function settingsFile(): string {
  return join(cosHome(), "models.json");
}

export function readModelSettings(file: string = settingsFile()): ModelSettings {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ModelSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeModelSettings(settings: ModelSettings, file: string = settingsFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/** Set (or with spec null, clear) the default or one intent's model. Validates the spec first. */
export function setModel(spec: string | null, intent?: ModelIntent, file: string = settingsFile()): ModelSettings {
  if (spec !== null) parseModelSpec(spec);
  const s = readModelSettings(file);
  if (intent) {
    s.intents = { ...(s.intents ?? {}) };
    if (spec === null) delete s.intents[intent];
    else s.intents[intent] = spec;
    if (!Object.keys(s.intents).length) delete s.intents;
  } else if (spec === null) delete s.default;
  else s.default = spec;
  writeModelSettings(s, file);
  return s;
}

// ---------- resolution ----------

export type ModelSource = "flag" | "settings (this intent)" | "settings (default)" | "COS_MODEL" | "auto";

export interface ResolvedModel {
  spec: ModelSpec;
  source: ModelSource;
  /** The provider's key (or base URL) is present. */
  ready: boolean;
  missing?: string;
}

export interface ResolveOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  settings?: ModelSettings;
}

/** The model for an intent, or null when nothing is chosen and no provider has a key. */
export function resolveModel(intent: ModelIntent, o: ResolveOptions = {}): ResolvedModel | null {
  const env = o.env ?? process.env;
  const settings = o.settings ?? readModelSettings();
  const candidates: [string | undefined, ModelSource][] = [
    [o.flag, "flag"],
    [settings.intents?.[intent], "settings (this intent)"],
    [settings.default, "settings (default)"],
    [env.COS_MODEL, "COS_MODEL"],
  ];
  for (const [value, source] of candidates) {
    if (!value) continue;
    const spec = parseModelSpec(value, env);
    const ready = providerConfigured(spec.provider, env);
    return { spec, source, ready, missing: ready ? undefined : PROVIDERS[spec.provider].keyEnv[0] };
  }
  for (const id of PROVIDER_ORDER) {
    if (!providerConfigured(id, env)) continue;
    if (id === "compatible" && !env.COS_COMPATIBLE_MODEL) continue;
    return { spec: { provider: id, model: defaultModelFor(id, env) }, source: "auto", ready: true };
  }
  return null;
}

export class NoModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoModelError";
  }
}

export function explainNotReady(intent: ModelIntent, resolved: ResolvedModel | null): string {
  if (!resolved) {
    return [
      `No model is set up for "${intent}". Add one key to .env:`,
      ...PROVIDER_ORDER.map((id) => `  ${PROVIDERS[id].keyEnv[0].padEnd(24)} ${PROVIDERS[id].label}`),
      "Then pick a model any time: cos models use openai:gpt-5.4",
    ].join("\n");
  }
  return `${formatSpec(resolved.spec)} is selected (${resolved.source}) but ${resolved.missing} is not set in .env.`;
}

/** Build the adapter for a spec. Keys are read from the environment at call time. */
export function createProvider(spec: ModelSpec, env: NodeJS.ProcessEnv = process.env): LLMProvider {
  switch (spec.provider) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new CompatProvider(
        { id: "openai", reasoning: "openai", maxTokensParam: "max_completion_tokens", structuredOutputs: true, replayReasoningDetails: false },
        defaultCompatSend(new OpenAI({ apiKey: env.OPENAI_API_KEY })),
      );
    case "openrouter":
      return new CompatProvider(
        { id: "openrouter", reasoning: "openrouter", maxTokensParam: "max_tokens", structuredOutputs: true, replayReasoningDetails: true },
        defaultCompatSend(
          new OpenAI({
            apiKey: env.OPENROUTER_API_KEY,
            baseURL: "https://openrouter.ai/api/v1",
            defaultHeaders: { "X-OpenRouter-Title": "Chief of Staff" },
          }),
        ),
      );
    case "compatible":
      return new CompatProvider(
        {
          id: "compatible",
          reasoning: "none",
          maxTokensParam: "max_tokens",
          structuredOutputs: env.COS_COMPATIBLE_JSON_SCHEMA === "1",
          replayReasoningDetails: false,
        },
        defaultCompatSend(new OpenAI({ apiKey: env.COS_COMPATIBLE_API_KEY || "not-needed", baseURL: env.COS_COMPATIBLE_BASE_URL })),
      );
  }
}

/** Built-in picker entries plus any the user added in models.json. */
export function presets(settings: ModelSettings = readModelSettings()): string[] {
  const builtIn = [
    "anthropic:claude-opus-5",
    "anthropic:claude-sonnet-5",
    "anthropic:claude-haiku-4-5",
    "openai:gpt-5.4",
    "openai:gpt-5.2",
    "openrouter:openrouter/auto",
    "openrouter:~anthropic/claude-sonnet-latest",
  ];
  return [...new Set([...builtIn, ...(settings.presets ?? [])])];
}
