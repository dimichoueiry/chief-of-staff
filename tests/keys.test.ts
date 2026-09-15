import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createUiServer } from "../src/ui/server.js";
import { parseEnv } from "../src/util/env.js";
import { cleanKey, keysState, maskKey, saveKey, upsertEnvLine } from "../src/util/keys.js";

describe("showing a key without giving it away", () => {
  it("masks all but the ends, and short values entirely", () => {
    expect(maskKey("sk-ant-api03-abcdefghijklmnop4f2a")).toBe("sk-ant…4f2a");
    expect(maskKey("short")).toBe("•••••");
    expect(maskKey("tiny")).toBe("••••");
  });
});

describe("a pasted key", () => {
  it("takes what a paste actually looks like, quotes and all", () => {
    expect(cleanKey('  "sk-ant-api03-abcdefghij"  ')).toEqual({ value: "sk-ant-api03-abcdefghij" });
    expect(cleanKey("'sk-or-v1-abcdefghijkl'")).toEqual({ value: "sk-or-v1-abcdefghijkl" });
  });

  it("says what is wrong instead of saving something that can't work", () => {
    expect(cleanKey("   ")).toMatchObject({ error: expect.stringContaining("empty") });
    expect(cleanKey("sk-ant-api03 abcdefghij")).toMatchObject({ error: expect.stringContaining("space") });
    expect(cleanKey("sk-ant\nkey-abcdefghij")).toMatchObject({ error: expect.stringContaining("space") });
    expect(cleanKey("sk-123")).toMatchObject({ error: expect.stringContaining("too short") });
    expect(cleanKey("your-api-key-here")).toMatchObject({ error: expect.stringContaining("example") });
  });
});

describe("writing one line of an env file", () => {
  const file = "# keys\nANTHROPIC_API_KEY=old\n\n# a note\nCOS_NAME=Darius\n";

  it("replaces a value and leaves every other line alone", () => {
    expect(upsertEnvLine(file, "ANTHROPIC_API_KEY", "new")).toBe("# keys\nANTHROPIC_API_KEY=new\n\n# a note\nCOS_NAME=Darius\n");
  });

  it("appends one that isn't there yet", () => {
    expect(upsertEnvLine(file, "OPENAI_API_KEY", "sk-new")).toBe("# keys\nANTHROPIC_API_KEY=old\n\n# a note\nCOS_NAME=Darius\nOPENAI_API_KEY=sk-new\n");
  });

  it("removes a line, and handles export, spacing and duplicates", () => {
    expect(upsertEnvLine(file, "ANTHROPIC_API_KEY", null)).toBe("# keys\n\n# a note\nCOS_NAME=Darius\n");
    expect(upsertEnvLine("export ANTHROPIC_API_KEY=old\n", "ANTHROPIC_API_KEY", "new")).toBe("ANTHROPIC_API_KEY=new\n");
    expect(upsertEnvLine("  ANTHROPIC_API_KEY = old\n", "ANTHROPIC_API_KEY", "new")).toBe("ANTHROPIC_API_KEY=new\n");
    expect(upsertEnvLine("A=1\nA=2\n", "A", "3")).toBe("A=3\n");
    expect(upsertEnvLine("", "OPENAI_API_KEY", "sk-new")).toBe("OPENAI_API_KEY=sk-new\n");
  });

  it("quotes a value that would otherwise be read back wrong", () => {
    const written = upsertEnvLine("", "COS_COMPATIBLE_BASE_URL", "http://x/ # y");
    expect(parseEnv(written).get("COS_COMPATIBLE_BASE_URL")).toBe("http://x/ # y");
  });
});

describe("the keys file", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cos-keys-"));
    file = join(dir, ".env");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports what is set, from the file and from the shell, without the values", () => {
    writeFileSync(file, "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop4f2a\n");
    const state = keysState(file, { OPENAI_API_KEY: "sk-shell-abcdefghijkl" });
    expect(state.ready).toBe(true);
    expect(state.keys.map((k) => [k.provider, k.set, k.masked, k.source])).toEqual([
      ["anthropic", true, "sk-ant…4f2a", "file"],
      ["openai", true, "sk-she…ijkl", "shell"],
      ["openrouter", false, "", null],
    ]);
    expect(JSON.stringify(state)).not.toContain("abcdefghijklmnop");
    // A key from the shell wins over the file, so say so rather than letting a save look ignored.
    expect(state.keys[1].note).toContain("shell");
  });

  it("saves, replaces and removes a key while keeping the rest of the file", () => {
    writeFileSync(file, "# mine\nCOS_NAME=Darius\nANTHROPIC_AUTH_TOKEN=older\n");
    saveKey("anthropic", "sk-ant-api03-abcdefghijklmnop", file);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("COS_NAME=Darius");
    expect(text).toContain("# mine");
    // The other name Anthropic accepts is cleared, so it can't shadow the key just saved.
    expect(text).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(parseEnv(text).get("ANTHROPIC_API_KEY")).toBe("sk-ant-api03-abcdefghijklmnop");

    saveKey("anthropic", null, file);
    expect(keysState(file, {}).keys[0].set).toBe(false);
    expect(readFileSync(file, "utf8")).toContain("COS_NAME=Darius");
  });

  it("keeps the file readable only by its owner", () => {
    writeFileSync(file, "COS_NAME=Darius\n");
    chmodSync(file, 0o644);
    saveKey("openai", "sk-openai-abcdefghijkl", file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("the keys endpoint the window talks to", () => {
  let dir: string;
  let selfhub: string;
  let server: ReturnType<typeof createUiServer>;
  let url: string;
  const saved = { home: process.env.COS_HOME, anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cos-keys-api-"));
    selfhub = mkdtempSync(join(tmpdir(), "cos-keys-hub-"));
    process.env.COS_HOME = dir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    server = createUiServer({
      config: loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }),
      today: "2026-09-17", offline: true, allowSpeech: false,
      modelTester: async (spec) => {
        if (spec.provider === "openai") throw new Error("401 Incorrect API key provided\nmore detail");
        return { ms: 820, servedBy: spec.model };
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(() => r(undefined)));
    for (const [k, v] of [["COS_HOME", saved.home], ["ANTHROPIC_API_KEY", saved.anthropic], ["OPENAI_API_KEY", saved.openai]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
    await rm(selfhub, { recursive: true, force: true });
  });

  const post = (b: unknown) => fetch(`${url}/api/keys`, { method: "POST", body: JSON.stringify(b) });

  it("lists every key someone can paste, with somewhere to get one", async () => {
    const state = await (await fetch(`${url}/api/keys`)).json();
    expect(state.ready).toBe(false);
    expect(state.file).toBe(join(dir, ".env"));
    expect(state.keys.map((k: { provider: string; set: boolean }) => [k.provider, k.set])).toEqual([
      ["anthropic", false],
      ["openai", false],
      ["openrouter", false],
    ]);
    expect(state.keys[0].keyUrl).toBe("https://console.anthropic.com");
  });

  it("saves a key that answers, and starts using that provider", async () => {
    const r = await (await post({ provider: "anthropic", value: "sk-ant-api03-abcdefghijklmnop4f2a" })).json();
    expect(r).toMatchObject({ ok: true, works: true, message: "Anthropic (Claude) is connected", ready: true });
    expect(r.detail).toContain("0.8 s");
    expect(r.keys[0]).toMatchObject({ set: true, masked: "sk-ant…4f2a", source: "file" });
    expect(JSON.stringify(r)).not.toContain("abcdefghijklmnop");

    const models = await (await fetch(`${url}/api/models`)).json();
    expect(models.intents.ask).toMatchObject({ spec: "anthropic:claude-opus-5", ready: true });
  });

  it("keeps a key the provider rejected, and says what it said", async () => {
    const r = await (await post({ provider: "openai", value: "sk-openai-wrongkey12345" })).json();
    expect(r).toMatchObject({ ok: true, works: false, message: "Saved, but OpenAI didn't answer" });
    expect(r.detail).toContain("401 Incorrect API key provided");
    expect(r.detail).not.toContain("more detail");
    expect(r.keys[1].set).toBe(true);
  });

  it("refuses what can't be a key, and changes nothing", async () => {
    const bad = await post({ provider: "anthropic", value: "your-api-key-here" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("example");
    expect((await (await fetch(`${url}/api/keys`)).json()).ready).toBe(false);

    const wrong = await post({ provider: "compatible", value: "http://localhost:11434/v1" });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toContain("anthropic, openai, openrouter");
  });

  it("removes a key when the box is emptied", async () => {
    await post({ provider: "anthropic", value: "sk-ant-api03-abcdefghijklmnop4f2a" });
    const r = await (await post({ provider: "anthropic", value: "" })).json();
    expect(r).toMatchObject({ ok: true, message: "Removed the Anthropic (Claude) key", ready: false });
    expect(r.keys[0].set).toBe(false);
  });
});
