import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, LLMProvider } from "../src/brain/llm/types.js";
import { RefusedError, runIntent } from "../src/brain/loop.js";
import { ToolRuntime, toolsFor } from "../src/brain/tools.js";
import { loadConfig } from "../src/config.js";
import { ensureRepo, git } from "../src/core/git.js";
import { Ledger } from "../src/core/ledger.js";
import { Reminders } from "../src/core/reminders.js";
import { noneProvider } from "../src/sensors/calendar.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

const TODAY = "2026-09-17";

const reply = (o: Partial<ChatResponse>): ChatResponse => ({ text: "", toolCalls: [], stop: "end", model: "scripted", ...o });

/** A provider that returns queued responses in order and records every request. Deep-copies requests so later pushes don't rewrite history. */
function scripted(responses: ChatResponse[]) {
  const requests: ChatRequest[] = [];
  const provider: LLMProvider = {
    id: "openai",
    async chat(req, onText) {
      requests.push(structuredClone(req));
      const r = responses.shift();
      if (!r) throw new Error("script exhausted");
      if (onText && r.text) onText(r.text);
      return r;
    },
  };
  return { llm: { provider, spec: { provider: "openai" as const, model: "gpt-test" } }, requests };
}

describe("ToolRuntime", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await makeTmpSelfhub()));
  afterEach(() => cleanup());

  it("routes writes to the stores with validation and records every call", async () => {
    const rt = new ToolRuntime(loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent" }), TODAY);
    expect((await rt.execute("upsert_project", { name: "Fampy", why: "revenue", status: "Parked" })).result).toContain('Created "Fampy"');
    expect((await rt.execute("upsert_project", { name: "fampy", status: "sleeping" })).isError).toBe(true);
    expect((await rt.execute("upsert_project", { name: "fampy", deadline: "next week" })).result).toMatch(/YYYY-MM-DD/);
    expect((await rt.execute("skip_cadence", { name: "Fampy" })).result).toContain("until 2026-09-24");
    expect((await rt.execute("touch_project", { name: "Fampy" })).result).toContain("last touched 2026-09-17");
    expect((await rt.execute("touch_project", { name: "nope" })).isError).toBe(true);
    expect((await rt.execute("add_reminder", { date: "Friday", text: "x" })).isError).toBe(true);
    expect((await rt.execute("add_reminder", { date: "2026-09-19", text: "email advisor" })).result).toContain("Reminder set");
    expect((await rt.execute("complete_reminder", { match: "advisor" })).result).toBe("Done: email advisor");
    expect((await rt.execute("add_note", { text: "an idea" })).result).toBe("Noted: an idea");
    expect((await rt.execute("append_journal", { text: "touched fampy" })).result).toBe("Journal 2026-09-17 updated.");
    expect((await rt.execute("get_project", { name: "FAMPY" })).result).toContain('"status": "parked"');
    expect((await rt.execute("nope", {})).isError).toBe(true);

    const p = await new Ledger(dir).find("Fampy");
    expect(p?.skipUntil).toBe("2026-09-24");
    expect(p?.lastTouched).toBe("2026-09-17");
    expect((await new Reminders(dir).list())[0].done).toBe(true);
    expect(rt.calls).toHaveLength(13);
    expect(await git(dir, ["log", "--format=%s"])).toContain('cos: skip cadence for "Fampy" until 2026-09-24');
  });

  it("reads git history for a project through its path field", async () => {
    const repo = join(dir, "proj");
    await ensureRepo(repo);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "T"]);
    await writeFile(join(repo, "f"), "1");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "first real commit"]);
    const rt = new ToolRuntime(loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent" }), TODAY);
    await rt.execute("upsert_project", { name: "Proj", path: repo });
    expect((await rt.execute("get_git_log", { project: "proj", limit: 5 })).result).toContain("first real commit");
    expect((await rt.execute("get_git_log", { project: "unknown" })).result).toContain("No folder found");
  });

  it("gives the brief no tools and each intent only its own", () => {
    expect(toolsFor("brief")).toEqual([]);
    expect(toolsFor("capture").map((t) => t.name)).not.toContain("get_git_log");
    expect(toolsFor("focus").map((t) => t.name)).toEqual(["get_project", "upsert_project", "get_git_log"]);
    expect(toolsFor("ask")[0].parameters).toMatchObject({ type: "object" });
  });
});

describe("runIntent (scripted provider)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await makeTmpSelfhub()));
  afterEach(() => cleanup());

  const cfg = () => loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent", COS_NAME: "Dimitri" });

  it("executes tool calls, feeds results back in neutral form, and returns the final text", async () => {
    const { llm, requests } = scripted([
      reply({ text: "Filing that.", stop: "tool_use", toolCalls: [{ id: "t1", name: "upsert_project", input: { name: "Fampy Academy", why: "course revenue" } }], providerData: { opaque: 1 } }),
      reply({ text: "Created Fampy Academy (why: course revenue)." }),
    ]);
    const streamed: string[] = [];
    const r = await runIntent({
      config: cfg(), intent: "capture", message: "starting a project: fampy academy, it's for course revenue",
      today: TODAY, calendarProvider: noneProvider, llm, onText: (t) => streamed.push(t),
    });
    expect(r.turns).toBe(2);
    expect(r.model).toBe("openai:gpt-test");
    expect(r.text).toBe("Created Fampy Academy (why: course revenue).");
    expect(r.toolCalls.map((c) => c.name)).toEqual(["upsert_project"]);
    expect((await new Ledger(dir).find("Fampy Academy"))?.why).toBe("course revenue");
    expect(streamed.join("")).toContain("Filing that.");

    const [first, second] = requests;
    expect(first.model).toBe("gpt-test");
    expect(first.instructions).toContain("chief of staff");
    expect(first.context).toContain("# Memory");
    expect(first.tools.map((t) => t.name)).toContain("upsert_project");
    expect(first.json).toBeUndefined();
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toMatchObject({ role: "assistant", providerData: { opaque: 1 } });
    expect(second.messages[2]).toMatchObject({ role: "tool", results: [{ id: "t1" }] });
  });

  it("asks for a JSON brief with no tools and normalises a prose-wrapped answer", async () => {
    const payload = { greeting: "Good morning, Dimitri", date: TODAY, headline: "h", focus: [{ title: "Do it", project: "X", why: "y", size: "1 hour", when: "" }], schedule: [], decisions: [], reminders: [], nudges: [] };
    const { llm, requests } = scripted([reply({ text: "Here is the brief:\n```json\n" + JSON.stringify(payload) + "\n```" })]);
    const r = await runIntent({ config: cfg(), intent: "brief", today: TODAY, calendarProvider: noneProvider, llm });
    expect(r.brief?.focus[0].title).toBe("Do it");
    expect(requests[0].tools).toEqual([]);
    expect(requests[0].json?.name).toBe("brief");
  });

  it("surfaces refusals, continues after a pause, and stops runaway loops", async () => {
    const refused = scripted([reply({ stop: "refusal" })]);
    await expect(runIntent({ config: cfg(), intent: "ask", today: TODAY, calendarProvider: noneProvider, llm: refused.llm })).rejects.toBeInstanceOf(RefusedError);

    const paused = scripted([reply({ stop: "pause", text: "partial" }), reply({ text: "done" })]);
    const p = await runIntent({ config: cfg(), intent: "ask", today: TODAY, calendarProvider: noneProvider, llm: paused.llm });
    expect(p.text).toBe("done");
    expect(paused.requests[1].messages[1]).toMatchObject({ role: "assistant", text: "partial" });

    const endless = scripted(Array.from({ length: 5 }, (_, i) => reply({ stop: "tool_use", toolCalls: [{ id: `t${i}`, name: "add_note", input: { text: "loop" } }] })));
    const r = await runIntent({ config: cfg(), intent: "ask", today: TODAY, calendarProvider: noneProvider, llm: endless.llm, maxTurns: 3 });
    expect(r.turns).toBe(3);
    expect(r.toolCalls).toHaveLength(3);
  });
});
