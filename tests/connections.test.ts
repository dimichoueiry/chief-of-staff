import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  CATALOGUE, normalizeEnvName, normalizeId, describe as describeConnection, missingEnv,
  readConnections, removeConnection, saveConnection, setEnabled, validate, writeConnections,
} from "../src/actions/connections.js";
import { connect, envFor, explain, probe, splitToolName, toolName, trimDescription } from "../src/actions/mcp.js";
import { createUiServer } from "../src/ui/server.js";

describe("naming a connection", () => {
  it("makes an id that is safe in a tool name", () => {
    expect(normalizeId("My Thing!")).toBe("my-thing");
    expect(normalizeId("  Notion  ")).toBe("notion");
    expect(normalizeId("Google Drive")).toBe("google-drive");
    expect(normalizeId("!!!")).toBe("");
  });

  it("makes a variable name an env file can hold", () => {
    expect(normalizeEnvName("notion token")).toBe("NOTION_TOKEN");
    expect(normalizeEnvName("hf-token")).toBe("HF_TOKEN");
  });

  it("namespaces tools so two servers can both have a search", () => {
    expect(toolName("notion", "search")).toBe("notion__search");
    expect(splitToolName("notion__search")).toEqual({ connectionId: "notion", tool: "search" });
    expect(splitToolName("get_calendar")).toBeNull();
    // A tool whose own name has the separator in it still splits at the first one.
    expect(splitToolName("gh__repo__list")).toEqual({ connectionId: "gh", tool: "repo__list" });
  });
});

describe("checking a connection before saving it", () => {
  it("takes a command line the way a person writes it", () => {
    const r = validate({ label: "Notion", transport: "stdio", command: "npx", args: ["-y", "some-server"], env: ["notion token"] });
    expect(r).toHaveProperty("connection");
    if ("connection" in r) {
      expect(r.connection).toMatchObject({ id: "notion", label: "Notion", transport: "stdio", command: "npx", enabled: true });
      expect(r.connection.env).toEqual(["NOTION_TOKEN"]);
      expect(describeConnection(r.connection)).toBe("npx -y some-server");
    }
  });

  it("takes an address, and insists on https unless it is this machine", () => {
    expect(validate({ label: "Zapier", transport: "http", url: "https://mcp.example.com/mcp" })).toHaveProperty("connection");
    expect(validate({ label: "Local", transport: "http", url: "http://localhost:3000/mcp" })).toHaveProperty("connection");
    expect(validate({ label: "Bad", transport: "http", url: "http://example.com/mcp" })).toMatchObject({ error: expect.stringContaining("https") });
  });

  it("says what is missing instead of saving something that cannot work", () => {
    expect(validate({ label: "", transport: "stdio", command: "npx" })).toMatchObject({ error: expect.stringContaining("name") });
    expect(validate({ label: "X", transport: "stdio", command: "" })).toMatchObject({ error: expect.stringContaining("which program") });
    expect(validate({ label: "X", transport: "http", url: "" })).toMatchObject({ error: expect.stringContaining("address") });
    expect(validate({ label: "X", transport: "http", url: "not a url" })).toMatchObject({ error: expect.stringContaining("web address") });
    // A command is a program, not a shell line: no chaining something else onto it.
    expect(validate({ label: "X", transport: "stdio", command: "npx; rm -rf ~" })).toMatchObject({ error: expect.stringContaining("shell line") });
  });

  it("names services without hardcoding addresses that go stale", () => {
    expect(CATALOGUE.map((c) => c.id)).toContain("notion");
    expect(CATALOGUE.map((c) => c.id)).toContain("github");
    for (const entry of CATALOGUE) {
      expect(entry.hint.length).toBeGreaterThan(0);
      expect(entry).not.toHaveProperty("command");
      expect(entry).not.toHaveProperty("url");
    }
  });
});

describe("the connections file", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cos-conn-"));
    file = join(dir, "connections.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("saves, replaces, turns off and removes, owner-only", () => {
    const one = validate({ label: "Notion", transport: "stdio", command: "npx", args: ["-y", "a"] });
    const two = validate({ label: "Airtable", transport: "stdio", command: "npx", args: ["-y", "b"] });
    if (!("connection" in one) || !("connection" in two)) throw new Error("both should be valid");
    saveConnection(one.connection, file);
    saveConnection(two.connection, file);
    expect(readConnections(file).map((c) => c.label)).toEqual(["Airtable", "Notion"]); // alphabetical
    expect(statSync(file).mode & 0o777).toBe(0o600);

    saveConnection({ ...one.connection, args: ["-y", "a", "--verbose"] }, file);
    expect(readConnections(file)).toHaveLength(2);
    expect(readConnections(file).find((c) => c.id === "notion")?.args).toEqual(["-y", "a", "--verbose"]);

    setEnabled("notion", false, file);
    expect(readConnections(file).find((c) => c.id === "notion")?.enabled).toBe(false);

    removeConnection("notion", file);
    expect(readConnections(file).map((c) => c.id)).toEqual(["airtable"]);
  });

  it("survives a file that has been mangled by hand", () => {
    writeFileSync(file, "{ not json");
    expect(readConnections(file)).toEqual([]);
    writeFileSync(file, JSON.stringify({ connections: [{ nope: 1 }, { id: "ok", label: "Ok", transport: "stdio", enabled: true }] }));
    expect(readConnections(file).map((c) => c.id)).toEqual(["ok"]);
  });

  it("never holds a secret: only the names of the variables", () => {
    const r = validate({ label: "Notion", transport: "stdio", command: "npx", env: ["NOTION_TOKEN"] });
    if (!("connection" in r)) throw new Error("valid");
    writeConnections([r.connection], file);
    expect(readFileSync(file, "utf8")).toContain("NOTION_TOKEN");
    expect(readFileSync(file, "utf8")).not.toContain("secret");
    expect(missingEnv(r.connection, {})).toEqual(["NOTION_TOKEN"]);
    expect(missingEnv(r.connection, { NOTION_TOKEN: "secret-value" })).toEqual([]);
  });

  it("hands a server only the variables it named", () => {
    const env = join(dir, ".env");
    writeFileSync(env, "NOTION_TOKEN=for-notion\nANTHROPIC_API_KEY=mine\n");
    const r = validate({ label: "Notion", transport: "stdio", command: "npx", env: ["NOTION_TOKEN"] });
    if (!("connection" in r)) throw new Error("valid");
    const passed = envFor(r.connection, env);
    expect(passed).toEqual({ NOTION_TOKEN: "for-notion" });
    expect(passed).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
});

describe("what to tell someone when it doesn't work", () => {
  const stdio = { id: "x", label: "X", transport: "stdio" as const, command: "nope-server", enabled: true, env: ["X_TOKEN"] };
  const http = { id: "y", label: "Y", transport: "http" as const, url: "https://example.com/mcp", enabled: true };

  it("turns the failure into the next thing to try", () => {
    expect(explain(new Error("spawn nope-server ENOENT"), stdio)).toContain("isn't installed");
    expect(explain(new Error("HTTP 401 Unauthorized"), http)).toContain("refused the credentials");
    expect(explain(new Error("HTTP 401"), stdio)).toContain("X_TOKEN");
    expect(explain(new Error("getaddrinfo ENOTFOUND mcp.nope"), http)).toContain("doesn't resolve");
    expect(explain(new Error("connect ECONNREFUSED 127.0.0.1:1"), http)).toContain("Nothing answered");
    expect(explain(new Error("HTTP 404 Not Found"), http)).toContain("/mcp");
    expect(explain(new Error("connecting took longer than 20 s"), http)).toContain("starting slowly");
    // undici says only "fetch failed" and puts the reason in the cause, so look there.
    expect(explain(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }), http)).toContain("Nothing answered");
    expect(explain(new Error("fetch failed"), http)).toContain("Couldn't reach https://example.com/mcp");
    expect(explain(Object.assign(new Error("fetch failed"), { cause: { message: "self-signed certificate" } }), http)).toContain("certificate");
  });

  it("keeps a tool description short enough to live in a prompt", () => {
    expect(trimDescription("  lots   of\n whitespace  ")).toBe("lots of whitespace");
    expect(trimDescription("x".repeat(400))).toHaveLength(300);
    expect(trimDescription("x".repeat(400)).endsWith("…")).toBe(true);
  });

  it("reports a program that isn't there rather than throwing", async () => {
    const r = await probe({ ...stdio, command: "definitely-not-a-real-program-xyz" }, 8000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("isn't installed");
    expect(r.tools).toEqual([]);
  });
});

describe("a real MCP server, connected end to end", () => {
  let dir: string;
  const fixture = join(process.cwd(), "tests", "helpers", "mcp-test-server.mjs");
  const savedHome = process.env.COS_HOME;
  const savedToken = process.env.TEST_KIT_TOKEN;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cos-mcp-"));
    process.env.COS_HOME = dir; // so the secrets come from this run's env file, as they do from ~/.cos
    delete process.env.TEST_KIT_TOKEN;
  });
  afterEach(async () => {
    if (savedHome === undefined) delete process.env.COS_HOME;
    else process.env.COS_HOME = savedHome;
    if (savedToken === undefined) delete process.env.TEST_KIT_TOKEN;
    else process.env.TEST_KIT_TOKEN = savedToken;
    await rm(dir, { recursive: true, force: true });
  });

  it("connects, lists what it can do, and passes only the variable it named", async () => {
    writeFileSync(join(dir, ".env"), "TEST_KIT_TOKEN=the-right-one\nANTHROPIC_API_KEY=not-for-this-server\n");
    const connection = {
      id: "kit", label: "Test kit", transport: "stdio" as const,
      command: process.execPath, args: [fixture], env: ["TEST_KIT_TOKEN"], enabled: true,
    };

    const r = await probe(connection, 30_000);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.server).toBe("test-kit");
    expect(r.tools.map((t) => t.name)).toEqual(["echo", "whoami"]);
    expect(r.tools[0]).toMatchObject({ description: "Says back what you gave it.", readOnly: true });
    expect(r.tools[1].readOnly).toBeUndefined(); // it didn't say, so nothing is claimed

    const session = await connect(connection, 30_000);
    try {
      expect(await session.call("echo", { text: "hello" })).toBe("hello");
      // The variable it asked for reaches it; the one it didn't ask for does not.
      const [token, other] = (await session.call("whoami", {})).split("|");
      expect(token).toBe("the-right-one");
      expect(other).toBe("(none)");
    } finally {
      await session.close();
    }
  }, 60_000);

  it("gives up on a server that never answers, without hanging the app", async () => {
    const r = await probe(
      { id: "slow", label: "Slow", transport: "stdio", command: "/bin/sleep", args: ["30"], enabled: true },
      1500,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("longer than");
    expect(r.ms).toBeLessThan(10_000);
  }, 30_000);

  it("says so when something answers but isn't an MCP server", async () => {
    // /bin/cat echoes the handshake straight back, which is a fast wrong answer rather than silence.
    const r = await probe({ id: "cat", label: "Cat", transport: "stdio", command: "/bin/cat", args: [], enabled: true }, 8000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("isn't an MCP server");
  }, 30_000);
});

describe("the connections endpoint the window talks to", () => {
  let home: string;
  let selfhub: string;
  let server: ReturnType<typeof createUiServer>;
  let url: string;
  const savedHome = process.env.COS_HOME;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "cos-conn-api-"));
    selfhub = mkdtempSync(join(tmpdir(), "cos-conn-hub-"));
    process.env.COS_HOME = home;
    server = createUiServer({
      config: loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }),
      today: "2026-09-17", offline: true, allowSpeech: false,
      connectionProbe: async (c) =>
        c.id === "broken"
          ? { ok: false, tools: [], error: "Nothing answered at that address.", ms: 30 }
          : { ok: true, server: "test-kit", tools: [{ name: "echo" }, { name: "whoami" }], ms: 120 },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(() => r(undefined)));
    if (savedHome === undefined) delete process.env.COS_HOME;
    else process.env.COS_HOME = savedHome;
    await rm(home, { recursive: true, force: true });
    await rm(selfhub, { recursive: true, force: true });
  });

  const post = (path: string, b: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  it("starts empty, naming services to add and where to find them", async () => {
    const state = await (await fetch(`${url}/api/connections`)).json();
    expect(state.connections).toEqual([]);
    expect(state.catalogue.map((c: { id: string }) => c.id)).toContain("notion");
    expect(state.registry).toContain("modelcontextprotocol.io");
    expect(state.trust).toContain("runs with your access");
    // Honest about the state of things: added and checked, but the loop doesn't call them yet.
    expect(state.usable).toBe(false);
  });

  it("adds one, checks it, and says what it can do", async () => {
    const r = await (await post("/api/connections", { label: "Test kit", transport: "stdio", command: "node", args: ["server.mjs"], env: "TEST_KIT_TOKEN" })).json();
    expect(r).toMatchObject({ ok: true, works: true, message: "Test kit is connected" });
    expect(r.detail).toContain("2 tools from test-kit");
    expect(r.tools).toEqual(["echo", "whoami"]);
    expect(r.connections[0]).toMatchObject({ id: "test-kit", enabled: true, address: "node server.mjs", missing: ["TEST_KIT_TOKEN"] });
    // Added means it leaves the list of things left to add.
    expect(r.catalogue.map((c: { id: string }) => c.id)).not.toContain("test-kit");
  });

  it("keeps one that didn't answer, and says why", async () => {
    const r = await (await post("/api/connections", { label: "Broken", transport: "http", url: "https://nope.example.com/mcp" })).json();
    expect(r).toMatchObject({ ok: true, works: false, message: "Saved, but Broken didn't answer" });
    expect(r.detail).toContain("Nothing answered");
    expect(r.connections.find((c: { id: string }) => c.id === "broken")).toBeTruthy();
  });

  it("refuses one that cannot work, and changes nothing", async () => {
    const bad = await post("/api/connections", { label: "X", transport: "http", url: "http://example.com/mcp" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("https");
    expect((await (await fetch(`${url}/api/connections`)).json()).connections).toEqual([]);
  });

  it("turns one off, checks it again, and removes it", async () => {
    await post("/api/connections", { label: "Test kit", transport: "stdio", command: "node" });
    const off = await (await post("/api/connections/enable", { id: "test-kit", enabled: false })).json();
    expect(off.connections[0].enabled).toBe(false);

    const checked = await (await post("/api/connections/check", { id: "test-kit" })).json();
    expect(checked).toMatchObject({ works: true, message: "Test kit is working" });

    const gone = await (await post("/api/connections/remove", { id: "test-kit" })).json();
    expect(gone).toMatchObject({ ok: true, message: "Removed Test kit" });
    expect(gone.connections).toEqual([]);

    expect((await post("/api/connections/check", { id: "test-kit" })).status).toBe(404);
    expect((await post("/api/connections/enable", { id: "nope", enabled: true })).status).toBe(404);
  });
});
