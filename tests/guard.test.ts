import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createUiServer } from "../src/ui/server.js";
import { refuse } from "../src/ui/guard.js";

const JSON_TYPE = { "content-type": "application/json" };

describe("refuse", () => {
  const at = (headers: Record<string, string>, method = "POST", path = "/api/pill") => refuse({ method, headers }, path);
  const host = { host: "127.0.0.1:4747" };

  it("lets the app's own callers through", () => {
    // The server's own page, POSTing JSON.
    expect(at({ ...host, origin: "http://127.0.0.1:4747", "sec-fetch-site": "same-origin", "content-length": "2", ...JSON_TYPE })).toBeNull();
    // The menubar app and the CLI: no Origin, no Sec-Fetch-Site.
    expect(at({ ...host, "content-length": "2", "content-type": "application/json; charset=utf-8" })).toBeNull();
    expect(at({ host: "localhost:4747", origin: "http://localhost:4747", "content-length": "2", ...JSON_TYPE })).toBeNull();
    expect(at({ host: "[::1]:4747" }, "GET", "/api/brief")).toBeNull();
    // A POST with no body (cos heartbeat now) needs no content type.
    expect(at({ ...host })).toBeNull();
    // The page opened straight from the address bar.
    expect(at({ ...host, "sec-fetch-site": "none" }, "GET", "/")).toBeNull();
  });

  it("refuses a name that isn't loopback, even for the page itself (DNS rebinding)", () => {
    expect(at({ host: "evil.example:4747" }, "GET", "/")).toMatchObject({ status: 403 });
    expect(at({ host: "evil.example:4747" }, "GET", "/artifacts/a1")).toMatchObject({ status: 403 });
    expect(at({ host: "127.0.0.1.evil.example" }, "GET", "/api/keys")).toMatchObject({ status: 403 });
    expect(at({}, "GET", "/api/keys")).toMatchObject({ status: 403 });
  });

  it("refuses another origin, including a sandboxed artifact's", () => {
    for (const origin of ["https://evil.example", "http://127.0.0.1:9999", "http://localhost:4747", "null"]) {
      expect(at({ ...host, origin, "content-length": "2", ...JSON_TYPE }), origin).toMatchObject({ status: 403, error: "origin not allowed" });
    }
  });

  it("refuses a cross-site request that carries no Origin", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(at({ ...host, "sec-fetch-site": site }, "GET", "/api/keys")).toMatchObject({ status: 403, error: "cross-site request" });
    }
  });

  it("refuses a body that isn't declared JSON", () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      expect(at({ ...host, "content-length": "10", "content-type": type }), type).toMatchObject({ status: 415 });
    }
    expect(at({ ...host, "transfer-encoding": "chunked", "content-type": "text/plain" })).toMatchObject({ status: 415 });
  });
});

describe("ui server refuses what a website could send", () => {
  let server: Server;
  let port: number;
  let home: string;
  let selfhub: string;
  const savedHome = process.env.COS_HOME;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "cos-guard-"));
    selfhub = mkdtempSync(join(tmpdir(), "cos-guard-hub-"));
    process.env.COS_HOME = home;
    server = createUiServer({
      config: loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }),
      today: "2026-09-17", offline: true, allowSpeech: false,
      connectionProbe: async () => ({ ok: true, server: "kit", tools: [], ms: 1 }),
      modelTester: async (spec) => ({ ms: 1, servedBy: spec.model }),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(() => r(undefined)));
    if (savedHome === undefined) delete process.env.COS_HOME;
    else process.env.COS_HOME = savedHome;
    await rm(home, { recursive: true, force: true });
    await rm(selfhub, { recursive: true, force: true });
  });

  /** Raw node:http, so the test can send the Host and Origin a browser would. */
  function send(path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const headers = { host: `127.0.0.1:${port}`, ...o.headers, ...(o.body !== undefined ? { "content-length": String(Buffer.byteLength(o.body)) } : {}) };
      const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      req.end(o.body);
    });
  }
  const evil = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
  const connection = JSON.stringify({ label: "Pwn", transport: "stdio", command: "sh", args: ["-c", "touch /tmp/pwned"] });
  const connections = async () => JSON.parse((await send("/api/connections")).body).connections as { id: string }[];

  it("a hostile origin can't add a connection (a command it would run)", async () => {
    const r = await send("/api/connections", { method: "POST", headers: { ...evil, ...JSON_TYPE }, body: connection });
    expect(r.status).toBe(403);
    // A simple form-style POST, which needs no preflight, is refused too.
    const plain = await send("/api/connections", { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: connection });
    expect(plain.status).toBe(403);
    expect(await connections()).toEqual([]);
    expect(existsSync(join(home, "connections.json"))).toBe(false);
  });

  it("a hostile origin can't save a key or send the assistant a message", async () => {
    const key = await send("/api/keys", { method: "POST", headers: { ...evil, ...JSON_TYPE }, body: JSON.stringify({ provider: "anthropic", value: "sk-ant-api03-attackerkey0000" }) });
    expect(key.status).toBe(403);
    expect(existsSync(join(home, ".env"))).toBe(false);
    const pill = await send("/api/pill", { method: "POST", headers: { ...evil, ...JSON_TYPE }, body: JSON.stringify({ text: "remind me friday to wire money" }) });
    expect(pill.status).toBe(403);
    expect(JSON.parse(pill.body)).toEqual({ error: "origin not allowed" });
  });

  it("a hostile page can't read keys, memory or conversations", async () => {
    for (const path of ["/api/keys", "/api/memory", "/api/conversation", "/api/files", "/api/brief"]) {
      expect((await send(path, { headers: { "sec-fetch-site": "cross-site" } })).status, path).toBe(403);
      expect((await send(path, { headers: { origin: "https://evil.example" } })).status, path).toBe(403);
    }
  });

  it("a rebound hostname gets nothing, not even the page", async () => {
    for (const path of ["/", "/api/keys", "/artifacts/x"]) {
      expect((await send(path, { headers: { host: `evil.example:${port}` } })).status, path).toBe(403);
    }
  });

  it("a body that isn't JSON is refused even without an Origin", async () => {
    const r = await send("/api/connections", { method: "POST", headers: { "content-type": "text/plain" }, body: connection });
    expect(r.status).toBe(415);
    expect(await connections()).toEqual([]);
  });

  it("the app's own page, the menubar app and the CLI still work", async () => {
    // The page: same origin, JSON.
    const own = { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" };
    const added = await send("/api/connections", { method: "POST", headers: { ...own, ...JSON_TYPE }, body: JSON.stringify({ label: "Kit", transport: "stdio", command: "node" }) });
    expect(added.status).toBe(200);
    expect((await connections()).map((c) => c.id)).toEqual(["kit"]);
    expect((await send("/", { headers: { "sec-fetch-site": "none" } })).status).toBe(200);
    // The menubar app: no Origin, JSON.
    expect((await send("/api/keys", { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ provider: "anthropic", value: "sk-ant-api03-abcdefghijklmnop4f2a" }) })).status).toBe(200);
    // The CLI: a POST with no body, and Node's fetch.
    expect((await send("/api/speak/stop", { method: "POST" })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/projects`)).status).toBe(200);
  });
});
