import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_MODEL, NoModelError, explainNotReady, formatSpec, parseImageSpec, parseModelSpec, presets, providerConfigured,
  readModelSettings, resolveImageModel, resolveModel, setImageModel, setModel,
} from "../src/brain/llm/registry.js";
import { providerFor } from "../src/brain/loop.js";

describe("parseModelSpec", () => {
  it("reads provider:model, keeping slashes and colons in the model name", () => {
    expect(parseModelSpec("anthropic:claude-opus-5")).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    expect(parseModelSpec("openai:gpt-5.4")).toEqual({ provider: "openai", model: "gpt-5.4" });
    expect(parseModelSpec("openrouter:meta-llama/llama-3.3-70b-instruct:free")).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct:free",
    });
    expect(parseModelSpec("OpenRouter:~anthropic/claude-sonnet-latest").provider).toBe("openrouter");
  });

  it("infers the provider from a bare model name", () => {
    expect(parseModelSpec("claude-haiku-4-5")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(parseModelSpec("gpt-5.2").provider).toBe("openai");
    expect(parseModelSpec("o3").provider).toBe("openai");
    expect(parseModelSpec("openai/gpt-5.2")).toEqual({ provider: "openrouter", model: "openai/gpt-5.2" });
    expect(() => parseModelSpec("llama3.2")).toThrow(/provider:model/);
  });

  it("expands a bare provider to its default model", () => {
    expect(parseModelSpec("openrouter")).toEqual({ provider: "openrouter", model: "openrouter/auto" });
    expect(parseModelSpec("compatible", { COS_COMPATIBLE_MODEL: "qwen3" })).toEqual({ provider: "compatible", model: "qwen3" });
    expect(() => parseModelSpec("compatible", {})).toThrow(/compatible needs a model/);
    expect(formatSpec(parseModelSpec("anthropic"))).toBe("anthropic:claude-opus-5");
  });
});

describe("resolveModel", () => {
  const keys = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };

  it("applies flag > intent setting > default setting > COS_MODEL > first provider with a key", () => {
    const settings = { default: "openai:gpt-5.2", intents: { capture: "anthropic:claude-haiku-4-5" } };
    const env = { ...keys, COS_MODEL: "claude-sonnet-5" };
    expect(resolveModel("ask", { flag: "openrouter:openrouter/auto", env, settings })).toMatchObject({ source: "flag", ready: false, missing: "OPENROUTER_API_KEY" });
    expect(resolveModel("capture", { env, settings })).toMatchObject({ source: "settings (this intent)", spec: { model: "claude-haiku-4-5" }, ready: true });
    expect(resolveModel("ask", { env, settings })).toMatchObject({ source: "settings (default)", spec: { provider: "openai", model: "gpt-5.2" } });
    expect(resolveModel("ask", { env, settings: {} })).toMatchObject({ source: "COS_MODEL", spec: { provider: "anthropic", model: "claude-sonnet-5" } });
    expect(resolveModel("ask", { env: { OPENAI_API_KEY: "o" }, settings: {} })).toMatchObject({ source: "auto", spec: { provider: "openai", model: "gpt-5.4" } });
    expect(resolveModel("ask", { env: { COS_COMPATIBLE_BASE_URL: "http://localhost:11434/v1", COS_COMPATIBLE_MODEL: "llama3.2" }, settings: {} })).toMatchObject({
      spec: { provider: "compatible", model: "llama3.2" },
    });
    expect(resolveModel("ask", { env: {}, settings: {} })).toBeNull();
  });

  it("explains what is missing", () => {
    expect(explainNotReady("ask", null)).toContain("OPENROUTER_API_KEY");
    const r = resolveModel("ask", { flag: "openai:gpt-5.4", env: {}, settings: {} });
    expect(explainNotReady("ask", r)).toBe("openai:gpt-5.4 is selected (flag) but OPENAI_API_KEY is not set in .env.");
    expect(providerConfigured("anthropic", { ANTHROPIC_AUTH_TOKEN: "t" })).toBe(true);
  });

  it("refuses to build a provider when the key is missing", () => {
    const saved = { ...process.env };
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => providerFor("ask", "openai:gpt-5.4")).toThrow(NoModelError);
    } finally {
      process.env = saved;
    }
  });
});

describe("models.json", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-home-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("sets and clears the default and per-intent choices, validating specs", () => {
    const file = join(dir, "models.json");
    expect(readModelSettings(file)).toEqual({});
    setModel("openai:gpt-5.4", undefined, file);
    setModel("anthropic:claude-haiku-4-5", "capture", file);
    expect(readModelSettings(file)).toEqual({ default: "openai:gpt-5.4", intents: { capture: "anthropic:claude-haiku-4-5" } });
    expect(() => setModel("llama3.2", undefined, file)).toThrow(/provider:model/);
    setModel(null, "capture", file);
    setModel(null, undefined, file);
    expect(readModelSettings(file)).toEqual({});
    expect(presets({ presets: ["openrouter:qwen/qwen3-coder"] })).toContain("openrouter:qwen/qwen3-coder");
  });
});

describe("the model that draws", () => {
  const env = { OPENROUTER_API_KEY: "sk-or" } as NodeJS.ProcessEnv;

  it("uses theirs, then COS_IMAGE_MODEL, then the default", () => {
    expect(formatSpec(resolveImageModel({ env, settings: {} }).spec)).toBe(DEFAULT_IMAGE_MODEL);
    expect(resolveImageModel({ env, settings: {} })).toMatchObject({ source: "auto", ready: true });
    expect(resolveImageModel({ env: { ...env, COS_IMAGE_MODEL: "openai/gpt-image-2" }, settings: {} })).toMatchObject({
      source: "COS_IMAGE_MODEL",
      spec: { provider: "openrouter", model: "openai/gpt-image-2" },
    });
    expect(resolveImageModel({ env, settings: { image: "openrouter:qwen/qwen-image-3" } })).toMatchObject({ source: "settings (images)" });
    expect(resolveImageModel({ env: {}, settings: {} })).toMatchObject({ ready: false, missing: "OPENROUTER_API_KEY" });
  });

  it("only takes a model that can draw, and clearing it goes back to the default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cos-home-"));
    const file = join(dir, "models.json");
    try {
      expect(() => parseImageSpec("anthropic:claude-opus-5")).toThrow(/OpenRouter/);
      expect(() => setImageModel("openai:gpt-image-2", file)).toThrow(/OpenRouter/);
      expect(setImageModel("google/gemini-3-pro-image", file).image).toBe("openrouter:google/gemini-3-pro-image");
      expect(readModelSettings(file)).toEqual({ image: "openrouter:google/gemini-3-pro-image" });
      expect(setImageModel(null, file).image).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
