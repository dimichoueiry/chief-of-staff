import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RefusedError, runIntent, type ModelCall } from "../src/brain/loop.js";
import { ToolRuntime, toolsFor } from "../src/brain/tools.js";
import { loadConfig } from "../src/config.js";
import { ensureRepo, git } from "../src/core/git.js";
import { Ledger } from "../src/core/ledger.js";
import { Reminders } from "../src/core/reminders.js";
import { noneProvider } from "../src/sensors/calendar.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

const TODAY = "2026-09-17";

function message(content: Anthropic.ContentBlock[], stop: Anthropic.StopReason): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}
const text = (t: string): Anthropic.TextBlock => ({ type: "text", text: t, citations: null });
const toolUse = (id: string, name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock =>
  ({ type: "tool_use", id, name, input }) as Anthropic.ToolUseBlock;

/** A scripted model: returns the queued responses in order and records every request. */
function scripted(responses: Anthropic.Message[]) {
  const requests: Anthropic.MessageStreamParams[] = [];
  const model: ModelCall = async (params, onText) => {
    requests.push(params);
    const r = responses.shift();
    if (!r) throw new Error("script exhausted");
    for (const b of r.content) if (b.type === "text" && onText) onText(b.text);
    return r;
  };
  return { model, requests };
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
    expect(rt.calls.map((c) => c.name)).toHaveLength(13);
    const log = await git(dir, ["log", "--format=%s"]);
    expect(log).toContain('cos: skip cadence for "Fampy" until 2026-09-24');
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
    const r = await rt.execute("get_git_log", { project: "proj", limit: 5 });
    expect(r.result).toContain("first real commit");
    expect((await rt.execute("get_git_log", { project: "unknown" })).result).toContain("No folder found");
  });

  it("gives the brief no tools and capture only write tools", () => {
    expect(toolsFor("brief")).toEqual([]);
    expect(toolsFor("capture").map((t) => t.name)).not.toContain("get_git_log");
    expect(toolsFor("focus").map((t) => t.name)).toEqual(["get_project", "upsert_project", "get_git_log"]);
  });
});

describe("runIntent (scripted model)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await makeTmpSelfhub()));
  afterEach(() => cleanup());

  const cfg = () => loadConfig({ COS_SELFHUB: dir, COS_PROJECT_ROOTS: "/nonexistent", COS_NAME: "Dimitri" });

  it("executes tool calls, feeds results back, and returns the final text", async () => {
    const { model, requests } = scripted([
      message([text("Filing that."), toolUse("t1", "upsert_project", { name: "Fampy Academy", why: "course revenue" })], "tool_use"),
      message([text("Created Fampy Academy (why: course revenue).")], "end_turn"),
    ]);
    const streamed: string[] = [];
    const r = await runIntent({
      config: cfg(), intent: "capture", message: "starting a project: fampy academy, it's for course revenue",
      today: TODAY, calendarProvider: noneProvider, model, onText: (t) => streamed.push(t),
    });
    expect(r.turns).toBe(2);
    expect(r.text).toBe("Created Fampy Academy (why: course revenue).");
    expect(r.toolCalls.map((c) => c.name)).toEqual(["upsert_project"]);
    expect((await new Ledger(dir).find("Fampy Academy"))?.why).toBe("course revenue");
    expect(streamed.join("")).toContain("Filing that.");

    // The second request carries the assistant turn and the tool result.
    const second = requests[1].messages;
    expect(second).toHaveLength(3);
    expect(second[2].role).toBe("user");
    const results = second[2].content as Anthropic.ToolResultBlockParam[];
    expect(results[0].tool_use_id).toBe("t1");
    expect(String(results[0].content)).toContain("Created");

    // Persona + task are the cacheable first system block; memory comes after.
    const system = requests[0].system as Anthropic.TextBlockParam[];
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[0].text).toContain("chief of staff");
    expect(system[1].text).toContain("# Memory");
    const toolNames = (requests[0].tools ?? []).map((t) => ("name" in t ? t.name : ""));
    expect(toolNames).toContain("upsert_project");
  });

  it("asks for a structured brief with no tools and parses it", async () => {
    const brief = { greeting: "Good morning, Dimitri", date: TODAY, headline: "h", focus: [], schedule: [], decisions: [], reminders: [], nudges: [] };
    const { model, requests } = scripted([message([text(JSON.stringify(brief))], "end_turn")]);
    const r = await runIntent({ config: cfg(), intent: "brief", today: TODAY, calendarProvider: noneProvider, model });
    expect(r.brief).toEqual(brief);
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].output_config?.format?.type).toBe("json_schema");
    expect(requests[0].thinking).toEqual({ type: "adaptive" });
  });

  it("surfaces refusals and stops runaway loops", async () => {
    const { model } = scripted([message([], "refusal")]);
    await expect(runIntent({ config: cfg(), intent: "ask", today: TODAY, calendarProvider: noneProvider, model })).rejects.toBeInstanceOf(RefusedError);

    const endless = scripted(Array.from({ length: 5 }, (_, i) => message([toolUse(`t${i}`, "add_note", { text: "loop" })], "tool_use")));
    const r = await runIntent({ config: cfg(), intent: "ask", today: TODAY, calendarProvider: noneProvider, model: endless.model, maxTurns: 3 });
    expect(r.turns).toBe(3);
    expect(r.toolCalls).toHaveLength(3);
  });
});
