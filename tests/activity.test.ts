import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, LLMProvider } from "../src/brain/llm/types.js";
import { Conversations } from "../src/brain/conversation.js";
import { loadConfig } from "../src/config.js";
import { listApprovals, recordApproval } from "../src/core/approvals.js";
import { Reminders } from "../src/core/reminders.js";
import { saveAccess } from "../src/actions/access.js";
import { createUiServer } from "../src/ui/server.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

describe("the approvals history", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cos-ap-"));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it("keeps each answer, newest first, and skips a damaged line", async () => {
    const file = join(home, "approvals.jsonl");
    recordApproval({ kind: "open", label: "example.com", detail: "https://example.com", outcome: "allowed", how: "tapped", at: "2026-09-22T10:00:00Z" }, file);
    recordApproval({ kind: "command", label: "rm -rf build", outcome: "declined", how: "said", at: "2026-09-22T11:00:00Z" }, file);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(file, "not json\n");
    expect(listApprovals(10, file)).toEqual([
      { at: "2026-09-22T11:00:00Z", kind: "command", label: "rm -rf build", outcome: "declined", how: "said" },
      { at: "2026-09-22T10:00:00Z", kind: "open", label: "example.com", detail: "https://example.com", outcome: "allowed", how: "tapped" },
    ]);
    expect(listApprovals(10, join(home, "missing.jsonl"))).toEqual([]);
  });
});

describe("choices and the activity page", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let home: string;
  let base: string;
  let close: () => Promise<void>;
  let requests: ChatRequest[];
  let responses: ChatResponse[];
  let opened: string[][];

  const reply = (o: Partial<ChatResponse>): ChatResponse => ({ text: "", toolCalls: [], stop: "end", model: "scripted", ...o });
  const post = async (path: string, b: unknown = {}) => (await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(b) })).json();
  const get = async (path: string) => (await fetch(`${base}${path}`)).json();

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTmpSelfhub());
    await cp(resolve("examples/selfhub-sample"), dir, { recursive: true });
    process.env.COS_CALENDAR = "none";
    home = await mkdtemp(join(tmpdir(), "cos-home-"));
    process.env.COS_HOME = home;
    requests = [];
    responses = [];
    opened = [];
    const provider: LLMProvider = {
      id: "openai",
      async chat(req) {
        requests.push(structuredClone(req));
        const r = responses.shift();
        if (!r) throw new Error("script exhausted");
        return r;
      },
    };
    const server = createUiServer({
      config: loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent", COS_NAME: "Dimitri" }),
      today: "2026-09-22",
      allowSpeech: false,
      backgroundSummaries: false,
      llm: { provider, spec: { provider: "openai", model: "gpt-test" } },
      conversations: new Conversations(join(home, "conversations")),
      openRunner: async (args) => {
        opened.push(args);
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterEach(async () => {
    await close();
    await cleanup();
    await rm(home, { recursive: true, force: true });
    delete process.env.COS_CALENDAR;
    delete process.env.COS_HOME;
  });

  it("puts the answers the model offers under its reply, and keeps them with it", async () => {
    responses.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "c1", name: "offer_choices", input: { options: ["Swap in the revised caption", " Keep the approved caption ", "Swap in the revised caption"] } }] }),
      reply({ text: "Swap the Instagram caption, or keep the one you approved?" }),
    );
    const r = await post("/api/pill", { text: "these look great" });
    expect(r.choices).toEqual(["Swap in the revised caption", "Keep the approved caption"]);
    expect(requests[0].tools.map((t) => t.name)).toContain("offer_choices");
    const convo = await get("/api/conversation");
    expect(convo.turns.at(-1)).toMatchObject({ role: "assistant", choices: ["Swap in the revised caption", "Keep the approved caption"] });

    // One option is no choice: the model is told, and nothing is shown.
    responses.push(
      reply({ stop: "tool_use", toolCalls: [{ id: "c2", name: "offer_choices", input: { options: ["Only this"] } }] }),
      reply({ text: "OK." }),
    );
    const one = await post("/api/pill", { text: "Keep the approved caption" });
    expect(one.choices).toBeUndefined();
    expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toContain("Give two to four options.");
  });

  it("lists reminders, rhythm, the heartbeat and every answer given", async () => {
    await new Reminders(dir).add("2026-09-23", "Module 2 posts go out", "09:00");
    saveAccess({ links: "ask", screen: "auto", browser: "ask" });
    const link = await post("/api/pill", { text: "open https://example.com/page" });
    await post("/api/actions/confirm", { id: link.confirm[0].id });
    const another = await post("/api/pill", { text: "open https://example.org" });
    await post("/api/actions/confirm", { id: another.confirm[0].id, cancel: true });

    const a = await get("/api/activity");
    expect(a.heartbeat).toMatchObject({ mode: "proactive", schedule: null, offers: [] });
    expect(a.reminders).toContainEqual({ date: "2026-09-23", time: "09:00", text: "Module 2 posts go out", done: false });
    expect(a.rhythm).toContainEqual(expect.objectContaining({ name: "MLGuerrilla", cadence: "Thursdays" }));
    expect(a.approvals.map((x: { outcome: string; how: string; kind: string }) => [x.kind, x.outcome, x.how])).toEqual([
      ["open", "declined", "tapped"],
      ["open", "allowed", "tapped"],
    ]);

    expect(await post("/api/reminders/done", { text: "Module 2 posts go out" })).toMatchObject({ ok: true });
    expect((await get("/api/activity")).reminders.map((r: { text: string }) => r.text)).not.toContain("Module 2 posts go out");
    expect(await post("/api/reminders/done", { text: "Module 2 posts go out" })).toMatchObject({ error: expect.any(String) });
  });

  it("doesn't list routine opens or what it only made", async () => {
    saveAccess({ links: "auto", screen: "auto", browser: "ask" });
    responses.push(
      reply({ stop: "tool_use", toolCalls: [
        { id: "o1", name: "open", input: { target: "https://example.com/docs" } },
        { id: "d1", name: "make_document", input: { title: "Notes", markdown: "## Hi" } },
      ] }),
      reply({ text: "Opened it and wrote the notes." }),
    );
    await post("/api/pill", { text: "open the docs and write me notes" });
    const kinds = (await get("/api/activity")).approvals.map((x: { kind: string; outcome: string }) => `${x.kind}:${x.outcome}`);
    expect(opened).toEqual([["https://example.com/docs"]]);
    expect(kinds).toEqual([]);
  });

  it("sends a message to the chat the dashboard is showing, not whichever the pill is on", async () => {
    responses.push(reply({ text: "First." }));
    const a = await post("/api/pill", { text: "one" });
    await post("/api/conversation/new", {});
    responses.push(reply({ text: "Second." }));
    const b = await post("/api/pill", { text: "two" });
    expect(b.conversation).not.toBe(a.conversation);
    responses.push(reply({ text: "Back in the first." }));
    const again = await post("/api/pill", { text: "three", conversation: a.conversation });
    expect(again.conversation).toBe(a.conversation);
    expect((await get("/api/conversation")).turns.map((t: { text: string }) => t.text)).toEqual(["one", "First.", "three", "Back in the first."]);
    // An id that isn't a chat is ignored: it goes to the one in progress.
    responses.push(reply({ text: "Still here." }));
    expect((await post("/api/pill", { text: "four", conversation: "nope" })).conversation).toBe(a.conversation);
    expect(await (await fetch(`${base}/chat.html`)).text()).toContain('src="/chat.js"');
  });

  it("serves the page", async () => {
    const html = await (await fetch(`${base}/activity.html`)).text();
    expect(html).toContain('src="/activity.js"');
    expect(await (await fetch(`${base}/activity.js`)).text()).toContain("/api/activity");
    expect(await (await fetch(`${base}/`)).text()).toContain('id="activity-btn"');
  });
});
