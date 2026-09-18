import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideOpen, openTargets, type OpenTarget } from "../src/brain/fastlane.js";
import { jevFromEnv, type Jev, type JevRequest, type JevResult } from "../src/brain/jev.js";
import { defaultBrowser } from "../src/actions/open.js";

/** A Jev that is sure `said` wants the target described by `match`, with the chances given. */
function fakeJev(o: { match?: RegExp; target?: number; wants?: number; more?: number; also?: [RegExp, number] } = {}): Jev & { asked: JevRequest[] } {
  const asked: JevRequest[] = [];
  const jev = async (req: JevRequest): Promise<JevResult> => {
    asked.push(req);
    const criteria = (req.questions.target as { criteria: Record<string, string> }).criteria;
    const probabilities: Record<string, number> = Object.fromEntries(Object.keys(criteria).map((k) => [k, 0]));
    const hit = o.match ? Object.keys(criteria).find((k) => o.match!.test(criteria[k])) : undefined;
    if (hit) probabilities[hit] = o.target ?? 0.95;
    if (o.also) {
      const other = Object.keys(criteria).find((k) => k !== hit && o.also![0].test(criteria[k]));
      if (other) probabilities[other] = o.also[1];
    }
    probabilities.none = Math.max(0, 1 - Object.values(probabilities).reduce((a, b) => a + b, 0));
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    const wants = o.wants ?? 0.97;
    return {
      model: "jev-test",
      answers: {
        wants: { type: "choice", choice: wants >= 0.5 ? "open" : "other", confidence: Math.max(wants, 1 - wants), probabilities: { open: wants, other: 1 - wants } },
        target: { type: "choice", choice, confidence: probabilities[choice], probabilities },
        more: { type: "noul", noul: o.more ?? 0.02 },
      },
    };
  };
  return Object.assign(jev, { asked });
}

const EDGE = { name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app" };
const TARGETS: OpenTarget[] = openTargets({
  shortcuts: [{ name: "gmail", target: "https://mail.google.com" }, { name: "notes folder", target: "~/Documents/notes" }],
  projects: [{ name: "drawcal", status: "active", path: "~/Desktop/drawcal", extra: [] }, { name: "no path yet", status: "active", extra: [] }],
  apps: [EDGE, { name: "Cursor", path: "/Applications/Cursor.app" }],
});

describe("openTargets", () => {
  it("lists the browser, shortcuts, project folders, Slate, settings pages and apps, most personal first", () => {
    const d = TARGETS.map((t) => t.describe);
    expect(d[0]).toMatch(/web browser/);
    expect(d[1]).toBe("gmail: their saved shortcut to https://mail.google.com");
    expect(d.some((x) => x.includes("no path yet"))).toBe(false);
    expect(d.at(-1)).toBe("Cursor (app)");
    expect(TARGETS[1].action).toMatchObject({ kind: "url", url: "https://mail.google.com/", trusted: true });
    expect(TARGETS[2].action).toMatchObject({ kind: "path", path: "~/Documents/notes" });
  });

  it("stays inside Jev's 255 labels by leaving out installed apps, never shortcuts or projects", () => {
    const apps = Array.from({ length: 400 }, (_, i) => ({ name: `App ${i}`, path: `/Applications/App ${i}.app` }));
    const t = openTargets({ shortcuts: [{ name: "gmail", target: "https://mail.google.com" }], projects: [], apps });
    expect(t).toHaveLength(254);
    expect(t[1].describe).toMatch(/^gmail/);
  });
});

describe("decideOpen", () => {
  it("opens the default browser for 'open the browser for me', asking Jev once", async () => {
    const jev = fakeJev({ match: /web browser/ });
    const d = await decideOpen(jev, "open the browser for me", TARGETS, async () => EDGE);
    expect(d).toEqual({ open: { kind: "app", app: EDGE.path, label: "Microsoft Edge" }, model: "jev-test", sure: 0.95 });
    expect(jev.asked).toHaveLength(1);
    expect(jev.asked[0].state).toEqual({ said: "open the browser for me" });
    expect(Object.keys(jev.asked[0].questions)).toEqual(["wants", "target", "more"]);
  });

  it("adds up labels that open the same thing: 'the browser' and the browser's own app", async () => {
    const d = await decideOpen(fakeJev({ match: /web browser/, target: 0.5, also: [/^Microsoft Edge/, 0.4] }), "bring up edge", TARGETS, async () => EDGE);
    expect(d).toMatchObject({ open: { kind: "app", app: EDGE.path }, sure: 0.9 });
  });

  it("opens shortcuts and project folders it picks", async () => {
    expect(await decideOpen(fakeJev({ match: /^gmail/ }), "take me to my email", TARGETS, async () => EDGE)).toMatchObject({
      open: { kind: "url", url: "https://mail.google.com/", label: "gmail" },
    });
    expect(await decideOpen(fakeJev({ match: /project drawcal/ }), "get drawcal up", TARGETS, async () => EDGE)).toMatchObject({
      open: { kind: "path", path: "~/Desktop/drawcal", label: "drawcal" },
    });
  });

  it("leaves questions, extra asks and unsure picks to the model", async () => {
    expect(await decideOpen(fakeJev({ match: /web browser/, wants: 0.1 }), "what's on today?", TARGETS, async () => EDGE)).toEqual({ skip: "wants open 10%" });
    expect(await decideOpen(fakeJev({ match: /web browser/, more: 0.9 }), "open the browser and look up flights", TARGETS, async () => EDGE)).toEqual({
      skip: "asks for more 90%",
    });
    expect(await decideOpen(fakeJev({ match: /Cursor/, target: 0.6 }), "open that editor", TARGETS, async () => EDGE)).toEqual({ skip: "target 60%" });
    expect(await decideOpen(fakeJev(), "open the thing", TARGETS, async () => EDGE)).toEqual({ skip: "target none 100%" });
  });

  it("doesn't guess a browser when the default one can't be found", async () => {
    expect(await decideOpen(fakeJev({ match: /web browser/ }), "open the browser", TARGETS, async () => null)).toEqual({ skip: "no default browser found" });
  });
});

describe("jevFromEnv", () => {
  it("is off without a key", () => {
    expect(jevFromEnv({})).toBeNull();
    expect(jevFromEnv({ TYPESAFE_API_KEY: "  " })).toBeNull();
  });

  it("posts the questions to /v1/systemone with the key and reads the answers", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const answers = { yes: { type: "noul", noul: 0.9 } };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 20, output_tokens: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const jev = jevFromEnv({ TYPESAFE_API_KEY: "sk-test-123456789" }, fetchImpl)!;
    const r = await jev({ state: { said: "hi" }, questions: { yes: { type: "noul", instructions: "Is it a greeting?" } } });
    expect(r).toEqual({ model: "jev-1.13.0", answers });
    expect(sent[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((sent[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-123456789");
    expect(JSON.parse(String(sent[0].init.body))).toEqual({
      model: "jev-latest",
      state: { said: "hi" },
      questions: { yes: { type: "noul", instructions: "Is it a greeting?" } },
    });
  });

  it("says what went wrong: a refused key, or answers it can't read", async () => {
    const refuse = (async () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 })) as unknown as typeof fetch;
    const q = { state: "x", questions: { yes: { type: "noul" as const, instructions: "?" } } };
    await expect(jevFromEnv({ TYPESAFE_API_KEY: "sk-bad-123456789" }, refuse)!(q)).rejects.toThrow("Jev answered 401: invalid api key");
    const garbled = (async () => new Response(JSON.stringify({ answers: { yes: { type: "noul" } } }))) as unknown as typeof fetch;
    await expect(jevFromEnv({ TYPESAFE_API_KEY: "sk-ok-123456789" }, garbled)!(q)).rejects.toThrow(`Jev's answer to "yes" isn't readable`);
  });
});

describe("defaultBrowser", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-browser-"));
    for (const app of ["Safari.app", "Google Chrome.app"]) await mkdir(join(dir, "apps", app), { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const plist = (handlers: { scheme: string; id: string }[]) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>LSHandlers</key><array>${handlers
      .map((h) => `<dict><key>LSHandlerURLScheme</key><string>${h.scheme}</string><key>LSHandlerRoleAll</key><string>${h.id}</string></dict>`)
      .join("")}</array></dict></plist>`;

  it("is the browser picked for web links in System Settings", async () => {
    const file = join(dir, "ls.plist");
    await writeFile(file, plist([{ scheme: "mailto", id: "com.apple.mail" }, { scheme: "https", id: "com.google.Chrome" }]));
    expect(await defaultBrowser({ plist: file, dirs: [join(dir, "apps")] })).toEqual({ name: "Google Chrome", path: join(dir, "apps", "Google Chrome.app") });
  });

  it("is Safari when none was ever picked, and nothing when the picked one isn't installed", async () => {
    expect(await defaultBrowser({ plist: join(dir, "missing.plist"), dirs: [join(dir, "apps")] })).toEqual({ name: "Safari", path: join(dir, "apps", "Safari.app") });
    const file = join(dir, "ls.plist");
    await writeFile(file, plist([{ scheme: "https", id: "com.brave.browser" }]));
    expect(await defaultBrowser({ plist: file, dirs: [join(dir, "apps")] })).toBeNull();
  });
});
