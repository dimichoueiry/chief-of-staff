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

  it("reads any calendar range through get_calendar and rejects bad ranges", async () => {
    const asked: string[] = [];
    const provider = {
      name: "fixture",
      available: async () => true,
      eventsBetween: async (from: string, to: string) => {
        asked.push(`${from}..${to}`);
        return [{ title: "Board meeting", start: "2026-10-05T14:00:00", end: "2026-10-05T15:00:00", allDay: false }];
      },
    };
    const rt = new ToolRuntime(loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent" }), TODAY, provider);
    const r = await rt.execute("get_calendar", { from: "2026-10-01", to: "2026-10-31" });
    expect(r.isError).toBe(false);
    expect(r.result).toContain("Calendar 2026-10-01 to 2026-10-31 (source: fixture)");
    expect(r.result).toContain("Mon, Oct 5 (2026-10-05)\n- 14:00–15:00  Board meeting");
    expect(asked).toEqual(["2026-10-01..2026-10-31"]);
    expect((await rt.execute("get_calendar", { from: "2026-10-05" })).result).toContain("Board meeting");
    expect(asked.at(-1)).toBe("2026-10-05..2026-10-05");
    expect((await rt.execute("get_calendar", { from: "2026-10-31", to: "2026-10-01" })).isError).toBe(true);
    expect((await rt.execute("get_calendar", { from: "2026-01-01", to: "2026-12-31" })).result).toMatch(/at most 92 days/);
    expect((await rt.execute("get_calendar", { from: "next friday" })).isError).toBe(true);
  });

  it("gives the brief no tools and each intent only its own", () => {
    expect(toolsFor("brief")).toEqual([]);
    expect(toolsFor("capture").map((t) => t.name)).not.toContain("get_git_log");
    expect(toolsFor("focus").map((t) => t.name)).toEqual(["get_project", "upsert_project", "get_git_log", "get_calendar", "open", "get_conversations", "find_folder", "run_command", "get_agents", "start_agent", "get_agent_output", "confirm_pending"]);
    expect(toolsFor("capture").map((t) => t.name)).not.toContain("run_command");
    expect(toolsFor("capture").map((t) => t.name)).toContain("find_folder");
    expect(toolsFor("ask").map((t) => t.name)).toContain("get_conversations");
    expect(toolsFor("capture").map((t) => t.name)).toContain("add_shortcut");
    expect(toolsFor("ask").map((t) => t.name)).toContain("get_calendar");
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

  it("sends the conversation so far before the new message and returns this run's steps without provider data", async () => {
    const { llm, requests } = scripted([
      reply({ stop: "tool_use", toolCalls: [{ id: "t9", name: "add_note", input: { text: "tauri for the menubar" } }], providerData: { reasoning_details: [1] } }),
      reply({ text: "Noted." }),
    ]);
    const history = [
      { role: "user" as const, content: "what was that menubar framework?" },
      { role: "assistant" as const, text: "Tauri.", toolCalls: [] },
    ];
    const tools: string[] = [];
    const r = await runIntent({
      config: cfg(), intent: "ask", message: "save that as a note", today: TODAY, calendarProvider: noneProvider, llm, history,
      onTool: (name) => tools.push(name),
    });
    expect(requests[0].messages).toEqual([...history, { role: "user", content: "save that as a note" }]);
    expect(tools).toEqual(["add_note"]);
    expect(r.steps).toEqual([
      { role: "assistant", text: "", toolCalls: [{ id: "t9", name: "add_note", input: { text: "tauri for the menubar" } }] },
      { role: "tool", results: [{ id: "t9", content: "Noted: tauri for the menubar" }] },
    ]);

    const brief = scripted([reply({ text: "{}" })]);
    await runIntent({ config: cfg(), intent: "brief", today: TODAY, calendarProvider: noneProvider, llm: brief.llm, history, recall: "# Earlier conversations\n- x" });
    expect(brief.requests[0].messages).toHaveLength(1); // the morning brief never carries a chat
    expect(brief.requests[0].context).not.toContain("Earlier conversations");

    const withRecall = scripted([reply({ text: "Yes." })]);
    await runIntent({ config: cfg(), intent: "ask", message: "did we pick a tier?", today: TODAY, calendarProvider: noneProvider, llm: withRecall.llm, recall: "# Earlier conversations (last 7 days, newest first)\n- picked the pro tier" });
    expect(withRecall.requests[0].context).toMatch(/# Memory[\s\S]*# Earlier conversations \(last 7 days, newest first\)\n- picked the pro tier$/);
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
