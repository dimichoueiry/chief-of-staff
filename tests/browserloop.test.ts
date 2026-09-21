import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Access } from "../src/actions/access.js";
import { AssistantBrowser, findElement, findElements, type BrowserDriver } from "../src/actions/browser.js";
import { confirmView } from "../src/actions/pending.js";
import { describeElement, runGoal } from "../src/brain/browserloop.js";
import type { Jev, JevRequest, JevResult } from "../src/brain/jev.js";
import { withoutOldPages } from "../src/brain/loop.js";
import { ToolRuntime } from "../src/brain/tools.js";
import { loadConfig } from "../src/config.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

const SEARCH = [
  '- searchbox "Search" [ref=e1]',
  '- link "Assignments" [ref=e2]',
  '- button "More actions" [ref=e3]',
  '- button "More actions" [ref=e4]',
  '- button "Delete course" [ref=e5]',
  '- textbox "Message to TA" [ref=e6]',
].join("\n");

const DONE = '- heading "Nothing left" [ref=e1]\n- link "Home" [ref=e2]';

/** A browser of two pages: the second is where a click on "Assignments" lands. */
function fakeBrowser(outline = SEARCH) {
  let at = "https://canvas.illinois.edu/";
  let page = outline;
  const calls: string[] = [];
  const driver: BrowserDriver = {
    async call(tool, args) {
      calls.push(`${tool} ${JSON.stringify(args)}`);
      switch (tool) {
        case "browser_snapshot":
          return `### Page\n- Page URL: ${at}\n- Page Title: Canvas\n### Snapshot\n\`\`\`yaml\n${page}\n\`\`\``;
        case "browser_click":
          if (args.target === "e2") page = DONE;
          return "";
        case "browser_type":
        case "browser_navigate":
        case "browser_navigate_back":
          return "";
        case "browser_evaluate":
          return "### Result\nfalse";
        default:
          throw new Error(`unexpected ${tool}`);
      }
    },
    async close() {},
  };
  return { driver, calls, at: () => at };
}

/**
 * A Jev that answers `finished` with `done`, and picks the label whose text matches `want`. Being
 * unsure means a rival close behind, not an even spread, so `rival` is what the runner-up gets.
 */
function fakeJev(o: { want?: RegExp; sure?: number; rival?: number; done?: number; value?: number } = {}): Jev & { asked: JevRequest[] } {
  const asked: JevRequest[] = [];
  const jev = async (req: JevRequest): Promise<JevResult> => {
    asked.push(JSON.parse(JSON.stringify(req)) as JevRequest);
    const criteria = (req.questions.target as { criteria: Record<string, string> }).criteria;
    const keys = Object.keys(criteria);
    const hit = o.want ? keys.find((k) => o.want!.test(criteria[k])) : undefined;
    const sure = o.sure ?? 0.9;
    const rival = o.rival ?? (1 - sure) / 2;
    const runnerUp = keys.find((k) => k !== hit);
    const rest = (1 - sure - rival) / Math.max(1, keys.length - 2);
    const probabilities = Object.fromEntries(keys.map((k) => [k, k === hit ? sure : k === runnerUp ? rival : rest]));
    const answers: JevResult["answers"] = {
      finished: { type: "noul", noul: o.done ?? 0.01 },
      target: { type: "choice", choice: hit ?? "none", confidence: sure, probabilities },
    };
    if (req.questions.value) {
      const vs = Object.keys((req.questions.value as { criteria: Record<string, string> }).criteria);
      answers.value = { type: "choice", choice: vs[(o.value ?? 1) - 1], confidence: 0.9, probabilities: Object.fromEntries(vs.map((v, i) => [v, i === (o.value ?? 1) - 1 ? 0.9 : 0.1 / (vs.length - 1)])) };
    }
    return { model: "jev-test", answers };
  };
  return Object.assign(jev, { asked });
}

describe("telling identical elements apart", () => {
  it("numbers elements that share a name, and says which one it means", () => {
    const els = findElements(SEARCH);
    expect(els.filter((e) => e.name === "More actions").map((e) => e.nth)).toEqual([1, 2]);
    expect(describeElement(findElement(SEARCH, "e3")!)).toBe('button "More actions"');
    expect(describeElement(findElement(SEARCH, "e4")!)).toBe('button "More actions" (the 2nd one like it on the page)');
    expect(describeElement(findElement(SEARCH, "e2")!)).toBe('link "Assignments"');
  });

  it("finds the element they OK'd again by its position when the name alone is ambiguous", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cos-loop-"));
    try {
      const browser = new AssistantBrowser(fakeBrowser().driver, join(dir, "browser.json"), { stepMs: 0, maxMs: 0 });
      browser.allow("https://canvas.illinois.edu/");
      await browser.read();
      const second = browser.element("e4");
      // The refs moved, but "the 2nd More actions" is still the 2nd.
      const moved = { ...second, ref: "e9" };
      expect(await browser.again(moved, "https://canvas.illinois.edu/")).toMatchObject({ ref: "e4", nth: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("running a goal on a page", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-loop-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const browserOf = (outline?: string) => {
    const fake = fakeBrowser(outline);
    const browser = new AssistantBrowser(fake.driver, join(dir, "browser.json"), { stepMs: 0, maxMs: 0 });
    browser.allow("https://canvas.illinois.edu/");
    return { browser, fake };
  };

  it("clicks its way to the goal and stops when Jev says it is there", async () => {
    const { browser } = browserOf();
    const jev = fakeJev({ want: /Assignments/ });
    const out = await runGoal(jev, browser, { goal: "open the assignments page" });
    expect(out).toMatchObject({ kind: "handover", steps: ['clicked link "Assignments"'] });
    // The page changed, so the second step has nothing matching and Jev says none.
    expect(jev.asked).toHaveLength(2);
    expect(jev.asked[0].state).toMatchObject({ goal: "open the assignments page", done_so_far: [] });
  });

  it("says it is done without acting when the goal is already met", async () => {
    const { browser, fake } = browserOf();
    const out = await runGoal(fakeJev({ want: /Assignments/, done: 0.95 }), browser, { goal: "already done" });
    expect(out.kind).toBe("done");
    expect(fake.calls.some((c) => c.startsWith("browser_click"))).toBe(false);
  });

  it("hands the page back rather than guess when a rival is close behind", async () => {
    const { browser, fake } = browserOf();
    const out = await runGoal(fakeJev({ want: /Assignments/, sure: 0.4, rival: 0.3 }), browser, { goal: "open something" });
    expect(out).toMatchObject({ kind: "handover", steps: [] });
    expect((out as { why: string }).why).toMatch(/not sure what to do next \(40%\)/);
    expect(fake.calls.some((c) => c.startsWith("browser_click"))).toBe(false);
  });

  it("still acts on a small share when nothing else comes close, as a long page spreads it thin", async () => {
    const { browser } = browserOf();
    const out = await runGoal(fakeJev({ want: /Assignments/, sure: 0.35, rival: 0.05 }), browser, { goal: "open the assignments page" });
    expect(out).toMatchObject({ steps: ['clicked link "Assignments"'] });
  });

  it("stops for an OK before a click that could change something, and does not click it", async () => {
    const { browser, fake } = browserOf();
    const out = await runGoal(fakeJev({ want: /Delete course/ }), browser, { goal: "clean up the course" });
    expect(out).toMatchObject({ kind: "confirm", ask: { action: "click", element: { ref: "e5", name: "Delete course" } } });
    expect(fake.calls.some((c) => c.startsWith("browser_click"))).toBe(false);
  });

  it("fills a field on its own but waits for an OK before a search that sends", async () => {
    const typed = await runGoal(fakeJev({ want: /Message to TA/ }), browserOf().browser, { goal: "write to the TA", values: ["I'll be late"] });
    expect(typed).toMatchObject({ steps: ['typed into textbox "Message to TA"'] });

    const searched = await runGoal(fakeJev({ want: /Search/ }), browserOf().browser, { goal: "search for MP3", values: ["MP3"] });
    expect(searched).toMatchObject({ kind: "confirm", ask: { action: "type", text: "MP3", element: { ref: "e1" } } });
  });

  it("will not invent text to type when the goal supplies none", async () => {
    const out = await runGoal(fakeJev({ want: /Message to TA/ }), browserOf().browser, { goal: "write to the TA" });
    expect(out).toMatchObject({ kind: "handover" });
    expect((out as { why: string }).why).toMatch(/type something the goal doesn't say/);
  });

  it("hands the page back with what it did when Jev cannot be reached", async () => {
    const { browser, fake } = browserOf();
    let asked = 0;
    const flaky: Jev = async (req) => {
      if (++asked > 1) throw new Error("Jev answered 503");
      return fakeJev({ want: /Assignments/ })(req);
    };
    const out = await runGoal(flaky, browser, { goal: "open the assignments page" });
    expect(out).toMatchObject({ kind: "handover", steps: ['clicked link "Assignments"'] });
    expect((out as { why: string }).why).toMatch(/Jev couldn't answer \(Jev answered 503\)/);
    // The page it hands back is the real one, so the model can pick up where this left off.
    expect((out as { page: string }).page).toMatch(/Nothing left/);
    expect(fake.calls.filter((c) => c.startsWith("browser_click"))).toHaveLength(1);
  });

  it("gives up instead of clicking the same dead element over and over", async () => {
    // "More actions" changes nothing, so the second step picks it again.
    const out = await runGoal(fakeJev({ want: /More actions/ }), browserOf().browser, { goal: "open the menu" });
    expect(out).toMatchObject({ kind: "handover", steps: ['clicked button "More actions"'] });
    expect((out as { why: string }).why).toMatch(/did not do anything/);
  });
});

describe("browser_do as a tool", () => {
  let selfhub: string;
  let cleanup: () => Promise<void>;
  let dir: string;
  beforeEach(async () => {
    ({ dir: selfhub, cleanup } = await makeTmpSelfhub());
    dir = await mkdtemp(join(tmpdir(), "cos-loop-"));
  });
  afterEach(async () => {
    await cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  const access = (browser: Access["browser"]): Access => ({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser });
  const runtime = (browser: AssistantBrowser, jev: Jev | null) =>
    new ToolRuntime(loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }), "2026-09-15", undefined, { browser, jev, access: () => access("ask") });

  it("queues the same OK a click would, and says a repeat call finishes the goal", async () => {
    const fake = fakeBrowser();
    const browser = new AssistantBrowser(fake.driver, join(dir, "browser.json"), { stepMs: 0, maxMs: 0 });
    browser.allow("https://canvas.illinois.edu/");
    const tools = runtime(browser, fakeJev({ want: /Delete course/ }));
    const out = await tools.execute("browser_do", { goal: "clean up the course" });
    expect(out.isError).toBe(false);
    expect(out.result).toMatch(/Ask them in one short sentence whether to do it/);
    expect(out.result).toMatch(/call browser_do again with the same goal/);
    expect(tools.pending.map(confirmView)).toEqual([
      expect.objectContaining({ kind: "browser-act", verb: "Click", detail: "Click “Delete course” on https://canvas.illinois.edu/" }),
    ]);
    expect(fake.calls.some((c) => c.startsWith("browser_click"))).toBe(false);
  });

  it("says what to use instead when there is no key for it", async () => {
    const browser = new AssistantBrowser(fakeBrowser().driver, join(dir, "browser.json"), { stepMs: 0, maxMs: 0 });
    const out = await runtime(browser, null).execute("browser_do", { goal: "anything" });
    expect(out.isError).toBe(true);
    expect(out.result).toMatch(/needs a TypeSafe API key; use browser_read and browser_click instead/);
  });
});

describe("keeping only the newest page in the record", () => {
  const page = (n: number) => `Page: ${n}\nAddress: https://x/${n}\n- link "one" [ref=e1]`;
  const messages = [
    { role: "assistant" as const, text: "", toolCalls: [{ id: "1", name: "browser_open", input: {} }] },
    { role: "tool" as const, results: [{ id: "1", content: page(1) }] },
    { role: "assistant" as const, text: "", toolCalls: [{ id: "2", name: "browser_click", input: {} }, { id: "3", name: "get_project", input: {} }] },
    { role: "tool" as const, results: [{ id: "2", content: page(2) }, { id: "3", content: "a project" }] },
    { role: "assistant" as const, text: "", toolCalls: [{ id: "4", name: "browser_read", input: {} }] },
    { role: "tool" as const, results: [{ id: "4", content: page(3) }] },
  ];

  it("replaces every page but the last and leaves other results alone", () => {
    const sent = withoutOldPages(messages);
    const contents = sent.flatMap((m) => (m.role === "tool" ? m.results.map((r) => r.content) : []));
    expect(contents[0]).toMatch(/^\(A page read earlier in this run\./);
    expect(contents[1]).toMatch(/^\(A page read earlier in this run\./);
    expect(contents[2]).toBe("a project");
    expect(contents[3]).toBe(page(3));
    // The record it was given is untouched, so the conversation still holds what really happened.
    expect(messages[1]).toMatchObject({ results: [{ content: page(1) }] });
  });

  it("changes nothing when only one page was read", () => {
    const one = messages.slice(0, 2);
    expect(withoutOldPages(one)).toBe(one);
  });
});
