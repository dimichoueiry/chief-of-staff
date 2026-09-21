import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Access } from "../src/actions/access.js";
import { AssistantBrowser, findElement, findElements, type BrowserDriver } from "../src/actions/browser.js";
import { confirmView } from "../src/actions/pending.js";
import { saveArtifact } from "../src/core/artifacts.js";
import { performPending } from "../src/actions/perform.js";
import { describeElement, runGoal } from "../src/brain/browserloop.js";
import type { Jev, JevRequest, JevResult } from "../src/brain/jev.js";
import { runIntent, withoutOldPages } from "../src/brain/loop.js";
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

  it("hands the model the page to click itself when there is no key", async () => {
    const browser = new AssistantBrowser(fakeBrowser().driver, join(dir, "browser.json"), { stepMs: 0, maxMs: 0 });
    browser.allow("https://canvas.illinois.edu/");
    const out = await runtime(browser, null).execute("browser_do", { goal: "delete the listing" });
    expect(out.isError).toBe(false);
    expect(out.result).toMatch(/click and type it yourself/);
    expect(out.result).toMatch(/\[ref=e1\]/);
  });

  it("opening a page runs the loop, so the model never chooses whether Jev drives", async () => {
    const fake = fakeBrowser();
    const browser = new AssistantBrowser(fake.driver, join(dir, "browser.json"), { stepMs: 0, maxMs: 0 });
    browser.allow("https://canvas.illinois.edu/");
    const jev = fakeJev({ want: /Assignments/ });
    const out = await runtime(browser, jev).execute("browser_open", { url: "https://canvas.illinois.edu/", goal: "open the assignments page" });
    expect(out.isError).toBe(false);
    expect(out.result).toMatch(/Did this, in order: clicked link "Assignments"/);
    expect(jev.asked.length).toBeGreaterThan(0);
    expect(fake.calls.some((c) => c.startsWith("browser_click"))).toBe(true);
  });

  it("will not open a page without saying what it is for", async () => {
    const browser = new AssistantBrowser(fakeBrowser().driver, join(dir, "browser.json"), { stepMs: 0, maxMs: 0 });
    browser.allow("https://canvas.illinois.edu/");
    const out = await runtime(browser, fakeJev()).execute("browser_open", { url: "https://canvas.illinois.edu/" });
    expect(out.isError).toBe(true);
    expect(out.result).toMatch(/"goal" is required/);
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

  it("keeps the last real page when a later browser step only says it needs an OK", () => {
    // This is what happened on Facebook: the newest browser result was "Not clicked yet", so both
    // real pages were replaced and the model answered by inventing listings it had never seen.
    const withPending = [
      ...messages.slice(0, 4),
      { role: "assistant" as const, text: "", toolCalls: [{ id: "5", name: "browser_click", input: {} }] },
      { role: "tool" as const, results: [{ id: "5", content: "Not clicked yet: “Delete listing” may send or change something." }] },
    ];
    const contents = withoutOldPages(withPending).flatMap((m) => (m.role === "tool" ? m.results.map((r) => r.content) : []));
    expect(contents[0]).toMatch(/^\(A page read earlier in this run\./);
    expect(contents[1]).toBe(page(2));
    expect(contents[3]).toMatch(/^Not clicked yet/);
  });

  it("changes nothing when only one page was read", () => {
    const one = messages.slice(0, 2);
    expect(withoutOldPages(one)).toBe(one);
  });
});

describe("a site that asks before it does the thing", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-dialog-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A listing page where "Delete listing" opens a confirmation instead of deleting. */
  const LISTINGS = '- button "Delete listing" [ref=e1]\n- link "Home" [ref=e2]';
  const ASKING = '- dialog "Delete listing?" [ref=e5]\n- button "Delete" [ref=e6]\n- button "Cancel" [ref=e7]';

  function facebookish() {
    let page = LISTINGS;
    const driver: BrowserDriver = {
      async call(tool, args) {
        if (tool === "browser_snapshot") return `### Page\n- Page URL: https://www.facebook.com/marketplace/you/selling\n- Page Title: Facebook\n### Snapshot\n\`\`\`yaml\n${page}\n\`\`\``;
        if (tool === "browser_click" && args.target === "e1") page = ASKING;
        if (tool === "browser_evaluate") return "### Result\nfalse";
        return "";
      },
      async close() {},
    };
    return driver;
  }

  it("says the deletion has not happened when the click only opened a dialog", async () => {
    const browser = new AssistantBrowser(facebookish(), join(dir, "browser.json"), { stepMs: 0, maxMs: 0 });
    browser.allow("https://www.facebook.com/");
    await browser.read();
    const el = browser.element("e1");
    const out = (await performPending(
      { id: "1", kind: "browser-act", createdAt: Date.now(), label: 'click "Delete listing"', detail: "d", verb: "Click",
        payload: { action: "click", element: el, url: "https://www.facebook.com/marketplace/you/selling" } },
      { browser },
    )).text;
    expect(out).toMatch(/“Delete listing\?”: it is asking before it does the thing, so click "Delete listing" has NOT happened yet/);
    expect(out).toMatch(/Do not close or dismiss it/);
    expect(browser.dialog()).toMatchObject({ role: "dialog", name: "Delete listing?" });
  });

  it("does not record a click that only opened a dialog as done, so it can still be finished", async () => {
    const browser = new AssistantBrowser(facebookish(), join(dir, "browser.json"), { stepMs: 0, maxMs: 0 });
    browser.allow("https://www.facebook.com/");
    await browser.read();
    const pending = {
      id: "1", kind: "browser-act", createdAt: Date.now(), label: 'click "Delete listing"', detail: "d", verb: "Click",
      payload: { action: "click", element: browser.element("e1"), url: "https://www.facebook.com/marketplace/you/selling" },
    } as const;
    const started = await performPending(pending, { browser });
    expect(started.finished).toBe(false);

    // A click that simply worked is finished, and only that one is safe to record as done.
    const plain = new AssistantBrowser(fakeBrowser().driver, join(dir, "b2.json"), { stepMs: 0, maxMs: 0 });
    plain.allow("https://canvas.illinois.edu/");
    await plain.read();
    const worked = await performPending(
      { id: "2", kind: "browser-act", createdAt: Date.now(), label: "click Assignments", detail: "d", verb: "Click",
        payload: { action: "click", element: plain.element("e2"), url: "https://canvas.illinois.edu/" } },
      { browser: plain },
    );
    expect(worked.finished).toBe(true);
  });

  it("says nothing extra when a click simply worked", async () => {
    const browser = new AssistantBrowser(fakeBrowser().driver, join(dir, "browser.json"), { stepMs: 0, maxMs: 0 });
    browser.allow("https://canvas.illinois.edu/");
    await browser.read();
    const out = (await performPending(
      { id: "1", kind: "browser-act", createdAt: Date.now(), label: "click Assignments", detail: "d", verb: "Click",
        payload: { action: "click", element: browser.element("e2"), url: "https://canvas.illinois.edu/" } },
      { browser },
    )).text;
    expect(out).not.toMatch(/NOT happened yet/);
    expect(browser.dialog()).toBeNull();
  });
});

describe("running out of steps", () => {
  let selfhub: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => { ({ dir: selfhub, cleanup } = await makeTmpSelfhub()); });
  afterEach(async () => { await cleanup(); });

  it("says it ran out and what it managed, instead of replying with nothing", async () => {
    let turn = 0;
    const provider = {
      id: "openai" as const,
      async chat() {
        turn++;
        // Always wants another tool: the cap is what stops it, with nothing said.
        return { text: "", toolCalls: [{ id: `t${turn}`, name: "add_note", input: { text: "keeping busy" } }], stop: "tool_use" as const, model: "test" };
      },
    };
    const r = await runIntent({
      config: loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }),
      intent: "ask",
      message: "do the long thing",
      today: "2026-09-15",
      maxTurns: 3,
      llm: { provider, spec: { provider: "openai", model: "test" } as never },
    });
    expect(r.turns).toBe(3);
    expect(r.text).toMatch(/^I ran out of steps before finishing that \(3 in one go\)/);
    expect(r.text).toMatch(/I got as far as: add_note ×3/);
    expect(r.text).toMatch(/Tell me to carry on/);
  });
});

describe("knowing which one it is about to act on", () => {
  /** Two listings, each with its own identical "Delete listing". */
  const LISTINGS = [
    '- list [ref=e1]:',
    '  - listitem [ref=e2]:',
    '    - link "Iphone 12 pro w/ case and screen protector 128 GB like new" [ref=e3]:',
    '      - button "More options" [ref=e4]',
    '      - menuitem "Delete listing" [ref=e5]',
    '  - listitem [ref=e6]:',
    '    - link "Private room for rent" [ref=e7]:',
    '      - button "More options" [ref=e8]',
    '      - menuitem "Delete listing" [ref=e9]',
  ].join("\n");

  it("says which listing a Delete belongs to, instead of two identical labels", () => {
    const els = findElements(LISTINGS);
    const deletes = els.filter((e) => e.name === "Delete listing");
    expect(deletes.map((e) => e.within)).toEqual([
      "Iphone 12 pro w/ case and screen protector 128 GB like new",
      "Private room for rent",
    ]);
    expect(describeElement(deletes[0])).toBe('menuitem "Delete listing", in "Iphone 12 pro w/ case and screen protector 128 GB like new"');
    expect(describeElement(deletes[1])).toBe('menuitem "Delete listing", in "Private room for rent"');
    // The two labels Jev chooses between are now different from each other.
    expect(describeElement(deletes[0])).not.toBe(describeElement(deletes[1]));
  });

  it("a plain box around things is not what a thing belongs to", () => {
    const els = findElements('- generic [ref=e1]:\n  - region "Main" [ref=e2]:\n    - button "Save" [ref=e3]');
    expect(els.find((e) => e.name === "Save")?.within).toBeUndefined();
  });

  it("stops before a delete when it is not sure that is the one named", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cos-one-"));
    try {
      const driver: BrowserDriver = {
        async call(tool) {
          if (tool === "browser_snapshot") return `### Page\n- Page URL: https://www.facebook.com/x\n- Page Title: F\n### Snapshot\n\`\`\`yaml\n${LISTINGS}\n\`\`\``;
          if (tool === "browser_evaluate") return "### Result\nfalse";
          return "";
        },
        async close() {},
      };
      const browser = new AssistantBrowser(driver, join(dir, "b.json"), { stepMs: 0, maxMs: 0 });
      browser.allow("https://www.facebook.com/");

      // Jev picks the room's Delete, but says it is not the one the goal names.
      const jev: Jev = async (req) => {
        if (req.questions.right_one) return { model: "t", answers: { right_one: { type: "noul", noul: 0.05 } } };
        return fakeJev({ want: /Delete listing", in "Private room/ })(req);
      };
      const out = await runGoal(jev, browser, { goal: "delete the iPhone 12 listing" });
      expect(out.kind).toBe("handover");
      expect((out as { why: string }).why).toMatch(/may not be the one .delete the iPhone 12 listing. means \(5%\)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("goes ahead and asks for an OK when it is the one named", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cos-one2-"));
    try {
      const driver: BrowserDriver = {
        async call(tool) {
          if (tool === "browser_snapshot") return `### Page\n- Page URL: https://www.facebook.com/x\n- Page Title: F\n### Snapshot\n\`\`\`yaml\n${LISTINGS}\n\`\`\``;
          if (tool === "browser_evaluate") return "### Result\nfalse";
          return "";
        },
        async close() {},
      };
      const browser = new AssistantBrowser(driver, join(dir, "b.json"), { stepMs: 0, maxMs: 0 });
      browser.allow("https://www.facebook.com/");
      const jev: Jev = async (req) => {
        if (req.questions.right_one) return { model: "t", answers: { right_one: { type: "noul", noul: 0.96 } } };
        return fakeJev({ want: /Delete listing", in "Iphone 12/ })(req);
      };
      const out = await runGoal(jev, browser, { goal: "delete the iPhone 12 listing" });
      expect(out).toMatchObject({ kind: "confirm", ask: { element: { ref: "e5" } } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("finishing what a yes started", () => {
  let dir: string;
  let selfhub: string;
  let cleanup: () => Promise<void>;
  const access = (browser: Access["browser"]): Access => ({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser });
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cos-fin2-")); ({ dir: selfhub, cleanup } = await makeTmpSelfhub()); });
  afterEach(async () => { await cleanup(); await rm(dir, { recursive: true, force: true }); });

  const DIALOG = '- dialog [ref=e1]:\n  - button "Delete" [ref=e2]\n  - button "Cancel" [ref=e3]';

  it("does not ask which one about a Delete that nothing says belongs to anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cos-fin-"));
    try {
      const driver: BrowserDriver = {
        async call(tool) {
          if (tool === "browser_snapshot") return `### Page\n- Page URL: https://www.facebook.com/x\n- Page Title: F\n### Snapshot\n\`\`\`yaml\n${DIALOG}\n\`\`\``;
          if (tool === "browser_evaluate") return "### Result\nfalse";
          return "";
        },
        async close() {},
      };
      const browser = new AssistantBrowser(driver, join(dir, "b.json"), { stepMs: 0, maxMs: 0 });
      browser.allow("https://www.facebook.com/");
      let askedWhichOne = false;
      const jev: Jev = async (req) => {
        if (req.questions.right_one) { askedWhichOne = true; return { model: "t", answers: { right_one: { type: "noul", noul: 0.6 } } }; }
        return fakeJev({ want: /"Delete"/ })(req);
      };
      const out = await runGoal(jev, browser, { goal: "confirm deleting the Clothes Rack listing" });
      // The button has nothing above it saying what it deletes, so it is not asked and not blocked.
      expect(askedWhichOne).toBe(false);
      expect(out).toMatchObject({ kind: "confirm", ask: { element: { ref: "e2" } } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still guards a page click against being queued twice in one reply, but not for minutes after", async () => {
    const fake = fakeBrowser();
    const browser = new AssistantBrowser(fake.driver, join(dir, "browser.json"), { stepMs: 0, maxMs: 0 });
    browser.allow("https://canvas.illinois.edu/");
    const earlier = [{ kind: "browser-act", detail: "Click “Delete course” on https://canvas.illinois.edu/" }];
    const tools = new ToolRuntime(loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }), "2026-09-15", undefined, {
      browser, jev: null, access: () => access("ask"), recentlyDone: earlier,
    });
    await tools.execute("browser_read", {});
    // The same words were clicked minutes ago; on a live page that is a different thing now.
    const first = await tools.execute("browser_click", { ref: "e5", element: "Delete course" });
    expect(first.result).not.toMatch(/already done a moment ago/);
    // Queued twice in the same reply is still refused.
    const again = await tools.execute("browser_click", { ref: "e5", element: "Delete course" });
    expect(again.result).toMatch(/already waiting for their OK/);
  });
});

describe("what a yes already settled", () => {
  let selfhub: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => { ({ dir: selfhub, cleanup } = await makeTmpSelfhub()); });
  afterEach(async () => { await cleanup(); });

  const runtime = (justSettled: string[], recentlyDone: { kind: string; detail: string }[] = []) =>
    new ToolRuntime(loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }), "2026-09-15", undefined, {
      awaiting: [], justSettled, recentlyDone,
    });

  it("answers about this message, not about something else minutes ago on another page", async () => {
    const stale = [{ kind: "browser-act", detail: "Click “Delete” on https://www.facebook.com/marketplace/you/selling" }];
    const out = await runtime(["They said yes, but Click the unlabeled button failed: the page changed."], stale).execute("confirm_pending", { decision: "yes" });
    expect(out.result).toMatch(/this message already settled it/);
    expect(out.result).toMatch(/failed: the page changed/);
    // The unrelated marketplace delete does not get dragged in.
    expect(out.result).not.toMatch(/marketplace/);
  });

  it("says plainly that nothing was waiting when this message settled nothing", async () => {
    const out = await runtime([], [{ kind: "browser-act", detail: "Click “Delete” on https://example.com/" }]).execute("confirm_pending", { decision: "yes" });
    expect(out.result).toBe("Nothing is waiting for their OK (it was dropped, or it expired after 5 minutes).");
  });
});

describe("answering a file chooser", () => {
  let selfhub: string;
  let cleanup: () => Promise<void>;
  let home: string;
  beforeEach(async () => {
    ({ dir: selfhub, cleanup } = await makeTmpSelfhub());
    home = await mkdtemp(join(tmpdir(), "cos-up-"));
    process.env.COS_HOME = home;
  });
  afterEach(async () => {
    delete process.env.COS_HOME;
    await cleanup();
    await rm(home, { recursive: true, force: true });
  });

  /** A browser whose snapshot fails the way Playwright's does while a chooser is open. */
  function chooserOpen() {
    let modal = true;
    const calls: string[] = [];
    const driver: BrowserDriver = {
      async call(tool, args) {
        calls.push(tool);
        if (tool === "browser_file_upload") { modal = false; return ""; }
        if (modal) throw new Error('Tool "browser_snapshot" does not handle the modal state.');
        if (tool === "browser_snapshot") return "### Page\n- Page URL: https://www.facebook.com/x\n- Page Title: F\n### Snapshot\n```yaml\n- button \"Post\" [ref=e1]\n```";
        return "";
      },
      async close() {},
    };
    return { driver, calls };
  }

  const runtime = (browser: AssistantBrowser) =>
    new ToolRuntime(loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }), "2026-09-15", undefined, {
      browser, access: () => ({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser: "ask" }),
    });

  it("sends a picture it made and says it is attached, not posted", async () => {
    const made = saveArtifact({ kind: "image", title: "dog", mediaType: "image/png", data: Buffer.from("not really a png"), prompt: "a dog" });
    const fake = chooserOpen();
    const browser = new AssistantBrowser(fake.driver, join(home, "browser.json"), { stepMs: 0, maxMs: 0 });
    browser.allow("https://www.facebook.com/");
    const out = await runtime(browser).execute("browser_upload", { ids: [made.id] });
    expect(out.isError).toBe(false);
    expect(out.result).toMatch(/It is attached, not posted/);
    expect(fake.calls).toContain("browser_file_upload");
    // Playwright only sends from its own folder, so the picture is copied there and the original stays put.
    expect(existsSync(join(home, "browser", "output", `${made.id}.png`))).toBe(true);
    expect(existsSync(join(home, "artifacts", `${made.id}.png`))).toBe(true);
  });

  it("refuses a file that is not theirs", async () => {
    const browser = new AssistantBrowser(chooserOpen().driver, join(home, "browser.json"), { stepMs: 0, maxMs: 0 });
    const out = await runtime(browser).execute("browser_upload", { paths: ["/etc/passwd"] });
    expect(out.isError).toBe(true);
    expect(out.result).toMatch(/isn't under their home folder/);
  });

  it("says which tool answers a chooser instead of repeating Playwright's wording", async () => {
    const browser = new AssistantBrowser(chooserOpen().driver, join(home, "browser.json"), { stepMs: 0, maxMs: 0 });
    browser.allow("https://www.facebook.com/");
    const out = await runtime(browser).execute("browser_read", {});
    expect(out.result).toMatch(/A file chooser is open .* Use browser_upload with the picture's id, or with nothing to close it\./);
  });
});

describe("getting a stuck page moving again", () => {
  let selfhub: string;
  let cleanup: () => Promise<void>;
  let home: string;
  beforeEach(async () => {
    ({ dir: selfhub, cleanup } = await makeTmpSelfhub());
    home = await mkdtemp(join(tmpdir(), "cos-stuck-"));
  });
  afterEach(async () => { await cleanup(); await rm(home, { recursive: true, force: true }); });

  function spy() {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const driver: BrowserDriver = {
      async call(tool, args) {
        calls.push({ tool, args });
        if (tool === "browser_snapshot") return "### Page\n- Page URL: https://x.test/\n- Page Title: X\n### Snapshot\n```yaml\n- button \"Send\" [ref=e1]\n```";
        if (tool === "browser_tabs") return "1: X\n2: Y";
        return "";
      },
      async close() {},
    };
    return { driver, calls };
  }

  const runtime = (browser: AssistantBrowser) =>
    new ToolRuntime(loadConfig({ COS_SELFHUB: selfhub, COS_PROJECT_ROOTS: "/nonexistent" }), "2026-09-15", undefined, {
      browser, access: () => ({ terminal: "ask", agents: "ask", links: "auto", screen: "auto", browser: "ask" }),
    });

  const browserOf = (fake: ReturnType<typeof spy>) => {
    const b = new AssistantBrowser(fake.driver, join(home, "browser.json"), { stepMs: 0, maxMs: 0 });
    b.allow("https://x.test/");
    return b;
  };

  it("answers the browser's own confirm box either way", async () => {
    const fake = spy();
    const tools = runtime(browserOf(fake));
    await tools.execute("browser_dialog", { accept: true });
    await tools.execute("browser_dialog", { accept: false });
    expect(fake.calls.filter((c) => c.tool === "browser_handle_dialog").map((c) => c.args.accept)).toEqual([true, false]);
  });

  it("presses Escape freely but makes Enter wait, because Enter sends", async () => {
    const fake = spy();
    const tools = runtime(browserOf(fake));
    const esc = await tools.execute("browser_key", { key: "Escape" });
    expect(esc.isError).toBe(false);
    expect(fake.calls.some((c) => c.tool === "browser_press_key" && c.args.key === "Escape")).toBe(true);

    const enter = await tools.execute("browser_key", { key: "Enter" });
    expect(enter.result).toMatch(/Not pressed yet: Enter can send/);
    expect(fake.calls.some((c) => c.tool === "browser_press_key" && c.args.key === "Enter")).toBe(false);
    expect(tools.pending.map(confirmView)).toEqual([expect.objectContaining({ verb: "Press" })]);
  });

  it("presses the Enter they agreed to", async () => {
    const fake = spy();
    const browser = browserOf(fake);
    const out = await performPending(
      { id: "1", kind: "browser-act", createdAt: Date.now(), label: "press Enter", detail: "d", verb: "Press",
        payload: { action: "key", key: "Enter", url: "https://x.test/" } },
      { browser },
    );
    expect(out.finished).toBe(true);
    expect(fake.calls.some((c) => c.tool === "browser_press_key" && c.args.key === "Enter")).toBe(true);
  });

  it("lists tabs, and will not select one without saying which", async () => {
    const fake = spy();
    const tools = runtime(browserOf(fake));
    expect((await tools.execute("browser_tabs", { action: "list" })).result).toContain("1: X");
    const bad = await tools.execute("browser_tabs", { action: "select" });
    expect(bad.isError).toBe(true);
    expect(bad.result).toMatch(/"index" is required/);
    await tools.execute("browser_tabs", { action: "select", index: 2 });
    expect(fake.calls.some((c) => c.tool === "browser_tabs" && c.args.action === "select" && c.args.index === 2)).toBe(true);
  });
});
