#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Command } from "commander";
import { runIntent, providerFor, RefusedError } from "../brain/loop.js";
import {
  MODEL_INTENTS, NoModelError, PROVIDERS, PROVIDER_ORDER, explainNotReady, formatSpec, parseModelSpec,
  presets, providerConfigured, readModelSettings, resolveModel, setModel, settingsFile, type ModelIntent,
} from "../brain/llm/registry.js";
import type { Brief } from "../brain/schema.js";
import { loadConfig, loadDotenv, type Config } from "../config.js";
import { buildContext, renderContext, type Intent } from "../core/context.js";
import { commitPaths, ensureRepo } from "../core/git.js";
import { Journal } from "../core/journal.js";
import { Ledger, PROJECT_STATUSES, normalizeStatus } from "../core/ledger.js";
import { Notes } from "../core/notes.js";
import { Reminders } from "../core/reminders.js";
import { buildBrief, buildDecisions } from "../logic/brief.js";
import { daysIdle } from "../logic/cadence.js";
import { decide, isChoice } from "../logic/decide.js";
import { createUiServer } from "../ui/server.js";
import { notify, saveBrief } from "../output/notify.js";
import { bold, dim, renderBrief, renderBriefNotification, renderBriefSpeech, type Target } from "../output/render.js";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import * as launchd from "../scheduler/launchd.js";
import { formatEvent, todayEvents } from "../sensors/calendar.js";
import { pickStt } from "../voice/stt.js";
import { speak } from "../voice/tts.js";
import { applyActivity, scanActivity } from "../sensors/git.js";
import { isISODate, todayISO } from "../util/dates.js";
import { buildMenubar, installLoginItem, openMenubar, uninstallMenubar } from "./menubar.js";
import { ask, confirm } from "./prompt.js";

loadDotenv();
const program = new Command();
program
  .name("cos")
  .description("A chief of staff for one person.")
  .version("0.1.0")
  .option("--today <date>", "pretend today is this YYYY-MM-DD (for demos)")
  .option("--model <provider:model>", "use this model for this command, e.g. openai:gpt-5.4 or openrouter:openai/gpt-5.2")
  .option("--selfhub <dir>", "memory repo (overrides COS_SELFHUB)");

function config(): Config {
  const o = program.opts<{ selfhub?: string }>();
  if (o.selfhub) process.env.COS_SELFHUB = o.selfhub;
  return loadConfig();
}
function today(): string {
  const t = program.opts<{ today?: string }>().today;
  if (t && !isISODate(t)) fail("--today must be YYYY-MM-DD");
  return t ?? todayISO();
}
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
function modelFlag(): string | undefined {
  return program.opts<{ model?: string }>().model;
}
/** Is a model with a key available for this intent? */
function modelReady(intent: ModelIntent): boolean {
  try {
    return Boolean(resolveModel(intent, { flag: modelFlag() })?.ready);
  } catch {
    return false;
  }
}
function needModel(intent: ModelIntent): void {
  let resolved;
  try {
    resolved = resolveModel(intent, { flag: modelFlag() });
  } catch (err) {
    fail((err as Error).message);
  }
  if (!resolved?.ready) fail(explainNotReady(intent, resolved ?? null));
}
/** Turn provider errors into one plain line. Anthropic and OpenAI (also OpenRouter and compatible servers) raise their own classes. */
function describeModelError(err: unknown): string | null {
  if (err instanceof RefusedError || err instanceof NoModelError) return err.message;
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) return "The API key was rejected. Check the key for this provider in .env.";
  if (err instanceof Anthropic.NotFoundError || err instanceof OpenAI.NotFoundError) return `Model not found: ${(err as Error).message}. Check the name with: cos models`;
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError) return "Rate limited. Try again in a moment.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  if (err instanceof OpenAI.APIError) return `API error ${err.status}: ${err.message}`;
  return null;
}
async function modelError(err: unknown): Promise<never> {
  const msg = describeModelError(err);
  if (msg) fail(msg);
  throw err;
}

/** Keep 'last touched' honest before anything reads the ledger. */
async function syncTouches(cfg: Config, quiet = true): Promise<void> {
  const touched = await applyActivity(new Ledger(cfg.selfhubDir), await scanActivity(cfg.projectRoots));
  if (!quiet) {
    if (!touched.length) console.log("Nothing new in git.");
    for (const t of touched) console.log(`touched ${t.project} → ${t.date}  (${t.path})`);
  }
}

// ---------- init ----------

const LEDGER_TEMPLATE = `# Projects

One block per project. Fields: why · status (active | parked | done | killed) · cadence · next · last touched · deadline · notes · path
Rules: one next action per project. why is mandatory. last touched is maintained for you from git activity.
Add a project with: cos capture "starting a project: <name>, it's for <why>"
`;

program
  .command("init")
  .description("scaffold the memory stores in your selfhub (ledger, reminders, notes)")
  .option("-y, --yes", "do not ask for confirmation")
  .action(async (o: { yes?: boolean }) => {
    const cfg = config();
    const ledger = new Ledger(cfg.selfhubDir);
    const files: [string, string][] = [
      [ledger.paths.ledger, LEDGER_TEMPLATE],
      [ledger.paths.reminders, "# Reminders\n\n"],
      [ledger.paths.notesInbox, "# Inbox\n\n"],
    ];
    const missing: [string, string][] = [];
    for (const f of files) {
      try {
        await readFile(f[0]);
      } catch {
        missing.push(f);
      }
    }
    if (!missing.length) return console.log(`Already initialised: ${cfg.selfhubDir}`);
    console.log(`Will create in ${cfg.selfhubDir}:\n${missing.map((m) => `  ${relative(cfg.selfhubDir, m[0])}`).join("\n")}`);
    if (!(await confirm("Create these files and commit?", o.yes))) return console.log("Nothing written.");
    await ensureRepo(cfg.selfhubDir);
    for (const [file, text] of missing) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text, "utf8");
    }
    await mkdir(ledger.paths.journalDir, { recursive: true });
    const hash = await commitPaths(cfg.selfhubDir, missing.map((m) => relative(cfg.selfhubDir, m[0])), "cos: initialise memory stores");
    console.log(`Initialised${hash ? ` (commit ${hash})` : ""}. Next: cos capture "starting a project: <name>, it's for <why>"`);
  });

// ---------- brief ----------

async function getBrief(cfg: Config, offline: boolean): Promise<{ brief: Brief; source: string }> {
  await syncTouches(cfg);
  const day = today();
  const rules = async (why: string) => {
    const ctx = await buildContext({ config: cfg, intent: "brief", today: day });
    return { brief: buildBrief(ctx), source: why ? `rules (${why})` : "rules" };
  };
  if (offline) return rules("");
  if (!modelReady("brief")) return rules("no model key");
  try {
    const r = await runIntent({ config: cfg, intent: "brief", today: day, modelFlag: modelFlag() });
    return { brief: r.brief!, source: r.model };
  } catch (err) {
    // The brief must always show up: fall back to rules and say why.
    const msg = describeModelError(err) ?? (err as Error).message;
    return rules(`model failed: ${msg.split("\n")[0]}`);
  }
}

program
  .command("brief")
  .description("today's brief: 1-3 next actions, schedule, decisions, reminders")
  .option("--offline", "rule-based brief, no model call")
  .option("--json", "print the brief as JSON")
  .option("--md", "print markdown")
  .option("--speech", "print the spoken version")
  .option("--speak", "read it aloud")
  .option("--notify", "send a macOS notification and cache the brief for the UI")
  .action(async (o: { offline?: boolean; json?: boolean; md?: boolean; speech?: boolean; speak?: boolean; notify?: boolean }) => {
    const { brief, source } = await getBrief(config(), Boolean(o.offline));
    await saveBrief(brief, source);
    if (o.notify) {
      const n = renderBriefNotification(brief);
      await notify(n.title, n.body);
    }
    if (o.json) console.log(JSON.stringify(brief, null, 2));
    else {
      const target: Target = o.md ? "markdown" : o.speech ? "speech" : "terminal";
      process.stdout.write(renderBrief(brief, target));
      if (target === "terminal") console.log(dim(`— ${source}`));
    }
    if (o.speak) await speak(renderBriefSpeech(brief));
  });

// ---------- model intents ----------

async function runAndPrint(intent: ModelIntent, message?: string, project?: string): Promise<void> {
  needModel(intent);
  const cfg = config();
  await syncTouches(cfg);
  let streamed = false;
  try {
    const r = await runIntent({
      config: cfg,
      intent,
      message,
      project,
      today: today(),
      modelFlag: modelFlag(),
      onText: (t) => {
        streamed = true;
        process.stdout.write(t);
      },
    });
    if (!streamed) process.stdout.write(r.text);
    process.stdout.write("\n");
    const writes = r.toolCalls.filter((c) => !c.isError && !c.name.startsWith("get_"));
    if (writes.length) console.log(dim(`${writes.length} change${writes.length === 1 ? "" : "s"} committed to ${cfg.selfhubDir}`));
    console.log(dim(`— ${r.model}`));
  } catch (err) {
    await modelError(err);
  }
}

program
  .command("ask")
  .argument("<question...>", "anything: 'what should I do today?'")
  .description("ask the chief of staff")
  .action((q: string[]) => runAndPrint("ask", q.join(" ")));

program
  .command("focus")
  .argument("<project>", "project name")
  .description("top 3 highest-leverage moves for one project")
  .action(async (project: string) => {
    const p = await new Ledger(config().selfhubDir).find(project);
    if (!p) fail(`No project matches "${project}". See: cos projects`);
    await runAndPrint("focus", undefined, p.name);
  });

program
  .command("capture")
  .argument("<sentence...>", "one sentence; it gets filed to the right place")
  .description("file a sentence: project, reminder, note or journal")
  .action((s: string[]) => runAndPrint("capture", s.join(" ")));

// ---------- wrap ----------

program
  .command("wrap")
  .argument("[text...]", "what you touched today and what's next")
  .option("--assist", "let the model write the entry from git activity and your notes")
  .description("end-of-day journal entry")
  .action(async (text: string[], o: { assist?: boolean }) => {
    const cfg = config();
    await syncTouches(cfg);
    let body = text.join(" ").trim();
    if (o.assist) return runAndPrint("wrap", body || undefined);
    if (!body) {
      if (!process.stdin.isTTY) fail("Give the entry as an argument, or run in a terminal.");
      const touched = await ask("What did you touch today? ");
      const next = await ask("What's the next move? ");
      body = [touched && `Touched: ${touched}`, next && `Next: ${next}`].filter(Boolean).join("\n");
      if (!body) return console.log("Nothing written.");
    }
    const hash = await new Journal(cfg.selfhubDir).append(today(), body);
    console.log(`Journal ${today()} updated${hash ? ` (commit ${hash})` : ""}.`);
  });

// ---------- deterministic commands ----------

program
  .command("silence-check")
  .description("projects gone quiet: keep, park, or kill?")
  .option("--json", "print as JSON")
  .option("--notify", "send a macOS notification when something needs a decision")
  .action(async (o: { json?: boolean; notify?: boolean }) => {
    const cfg = config();
    await syncTouches(cfg);
    const ctx = await buildContext({ config: cfg, intent: "silence-check", today: today() });
    const decisions = buildDecisions(ctx);
    if (o.notify && decisions.length) {
      await notify(`${decisions.length} project${decisions.length === 1 ? "" : "s"} gone quiet`, decisions.map((d) => d.project).join(", ") + " — keep, park, or kill?");
    }
    if (o.json) return console.log(JSON.stringify(decisions, null, 2));
    if (!decisions.length) return console.log("Nothing has gone quiet.");
    for (const d of decisions) {
      console.log(bold(d.question));
      if (d.reason) console.log(`  ${d.reason}`);
      console.log(`  ${dim(`cos decide "${d.project}" ${d.options.join("|")}`)}`);
    }
  });

program
  .command("decide")
  .argument("<project>")
  .argument("<choice>", "keep | park | kill")
  .description("answer a keep / park / kill question")
  .action(async (project: string, choice: string) => {
    const c = choice.toLowerCase();
    if (!isChoice(c)) fail("choice must be keep, park or kill");
    const r = await decide(new Ledger(config().selfhubDir), project, c, today());
    console.log(r.message);
  });

program
  .command("ui")
  .description("the pill + brief in your browser (same page a menubar shell will host)")
  .option("--port <n>", "port", process.env.COS_UI_PORT ?? "4747")
  .option("--no-open", "do not open the browser")
  .action(async (o: { port: string; open: boolean }) => {
    const cfg = config();
    const server = createUiServer({ config: cfg, modelFlag: modelFlag(), today: program.opts<{ today?: string }>().today });
    const port = Number(o.port) || 4747;
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolveListen());
    });
    const url = `http://127.0.0.1:${port}`;
    console.log(`Chief of Staff UI at ${url}${modelReady("ask") ? "" : dim("  (no model key: brief, decisions and capture work; questions need one — see cos models)")}`);
    console.log(dim("Ctrl+C to stop."));
    if (o.open && process.platform === "darwin") {
      const { execFile } = await import("node:child_process");
      execFile("open", [url]);
    }
  });

program
  .command("touch")
  .description("update 'last touched' from git activity in your project folders")
  .action(async () => syncTouches(config(), false));

program
  .command("remind")
  .argument("<date>", "YYYY-MM-DD")
  .argument("<text...>")
  .description("add a one-off reminder")
  .action(async (date: string, text: string[]) => {
    if (!isISODate(date)) fail("date must be YYYY-MM-DD");
    await new Reminders(config().selfhubDir).add(date, text.join(" "));
    console.log(`Reminder set for ${date}.`);
  });

program
  .command("done")
  .argument("<match...>", "words from the reminder")
  .description("complete a reminder")
  .action(async (m: string[]) => {
    const hit = await new Reminders(config().selfhubDir).complete(m.join(" "));
    console.log(hit ? `Done: ${hit.text}` : "No open reminder matches.");
  });

program
  .command("note")
  .argument("<text...>")
  .description("keep a thought in the inbox")
  .action(async (t: string[]) => {
    await new Notes(config().selfhubDir).add(t.join(" "), today());
    console.log("Noted.");
  });

program
  .command("projects")
  .description("list the ledger")
  .option("--all", "include done and killed")
  .action(async (o: { all?: boolean }) => {
    const projects = await new Ledger(config().selfhubDir).read();
    const day = today();
    const rows = projects.filter((p) => o.all || ["active", "parked"].includes(normalizeStatus(p.status)));
    if (!rows.length) return console.log('No projects yet. Try: cos init, then cos capture "starting a project: ..."');
    const w = Math.max(...rows.map((p) => p.name.length));
    for (const p of rows) {
      const idle = daysIdle(p, day);
      const status = normalizeStatus(p.status).padEnd(6);
      const age = idle === null ? "never" : `${String(idle).padStart(3)}d`;
      console.log(`${p.name.padEnd(w)}  ${status}  ${age.padStart(5)}  ${p.cadence ? `[${p.cadence}] ` : ""}${p.next ?? dim("(no next action)")}`);
    }
    console.log(dim(`statuses: ${PROJECT_STATUSES.join(", ")}`));
  });

program
  .command("calendar")
  .description("today's events as the sensor sees them")
  .action(async () => {
    const r = await todayEvents(today());
    console.log(`source: ${r.provider}${r.error ? `  (error: ${r.error})` : ""}`);
    if (!r.events.length) console.log("no events");
    for (const e of r.events) console.log(formatEvent(e));
  });

program
  .command("context")
  .argument("[intent]", "brief | ask | focus | capture | wrap", "brief")
  .option("--project <name>")
  .description("print the memory block the model would see")
  .action(async (intent: Intent, o: { project?: string }) => {
    const ctx = await buildContext({ config: config(), intent, project: o.project, today: today() });
    console.log(renderContext(ctx));
  });

// ---------- initiative: scheduler and nudges ----------

program
  .command("nudge")
  .argument("<what>", "wrap")
  .description("send a nudge notification (used by the evening job)")
  .action(async (what: string) => {
    if (what !== "wrap") fail("nudge: only 'wrap' is defined");
    const ok = await notify("Wrap up your day", "Two lines: what did you touch, what's next? → cos wrap");
    console.log(ok ? "Nudged." : "Notifications are not available here.");
  });

const scheduler = program.command("scheduler").description("make it speak first: launchd jobs for the brief, the silence check and the wrap-up nudge");

scheduler
  .command("install")
  .option("--morning <HH:MM>", "brief time", launchd.DEFAULT_SCHEDULE.morning)
  .option("--evening <HH:MM>", "wrap-up nudge time", launchd.DEFAULT_SCHEDULE.evening)
  .option("--silence <HH:MM>", "silence check time", launchd.DEFAULT_SCHEDULE.silence)
  .description("install (or reinstall) the launchd agents")
  .action(async (o: { morning: string; evening: string; silence: string }) => {
    if (process.platform !== "darwin") fail("The scheduler uses launchd and only runs on macOS.");
    const root = resolve(new URL("../..", import.meta.url).pathname);
    const entry = resolve(root, "dist", "cli", "cos.js");
    try {
      await access(entry);
    } catch {
      fail(`Build first so launchd has a stable entry point: npm run build   (expected ${entry})`);
    }
    const jobs = await launchd.install({ node: process.execPath, entry, cwd: root }, { morning: o.morning, evening: o.evening, silence: o.silence });
    for (const j of jobs) console.log(`${j.at}  ${launchd.label(j)}  ${dim(j.description)}`);
    console.log(dim(`logs: ${launchd.LOG_DIR}`));
  });

scheduler
  .command("uninstall")
  .description("remove the launchd agents")
  .action(async () => {
    const removed = await launchd.uninstall();
    console.log(removed.length ? `Removed ${removed.join(", ")}` : "Nothing installed.");
  });

scheduler
  .command("status")
  .description("show what is installed and loaded")
  .action(async () => {
    for (const s of await launchd.status()) {
      console.log(`${s.at}  ${s.label}  ${s.installed ? (s.loaded ? "loaded" : "installed, not loaded") : dim("not installed")}`);
    }
  });

// ---------- models and providers ----------

const models = program
  .command("models")
  .description("which model answers what: list, pick, test")
  .action(() => printModels());

function printModels(): void {
  const settings = readModelSettings();
  console.log(bold("Providers"));
  for (const id of PROVIDER_ORDER) {
    const p = PROVIDERS[id];
    const ok = providerConfigured(id);
    console.log(`  ${ok ? "●" : dim("○")} ${p.label.padEnd(48)} ${ok ? "ready" : dim(`set ${p.keyEnv[0]}  (${p.keyUrl})`)}`);
  }
  console.log("");
  console.log(bold("Models in use"));
  for (const intent of MODEL_INTENTS) {
    let line: string;
    try {
      const r = resolveModel(intent, { flag: modelFlag(), settings });
      line = r
        ? `${formatSpec(r.spec).padEnd(44)} ${dim(r.source)}${r.ready ? "" : `  ← ${r.missing} missing`}`
        : dim("none — add a key");
    } catch (err) {
      line = `invalid: ${(err as Error).message}`;
    }
    console.log(`  ${intent.padEnd(8)} ${line}`);
  }
  console.log("");
  console.log(bold("Pick one"));
  console.log(`  cos models use openai:gpt-5.4                 ${dim("everything")}`);
  console.log(`  cos models use anthropic:claude-haiku-4-5 --for capture   ${dim("one intent")}`);
  console.log(`  cos --model openrouter:openai/gpt-5.2 ask "…"  ${dim("one command")}`);
  console.log(dim(`  presets: ${presets(settings).join(", ")}`));
  console.log(dim(`  saved in ${settingsFile()}`));
}

function intentOption(v?: string): ModelIntent | undefined {
  if (!v) return undefined;
  if (!(MODEL_INTENTS as readonly string[]).includes(v)) fail(`--for must be one of: ${MODEL_INTENTS.join(", ")}`);
  return v as ModelIntent;
}

models
  .command("use")
  .argument("<model>", "provider:model, e.g. anthropic:claude-opus-5, openai:gpt-5.4, openrouter:openai/gpt-5.2, compatible:llama3.2")
  .option("--for <intent>", `only for one intent (${MODEL_INTENTS.join(" | ")})`)
  .description("choose the model (saved, used by the CLI, the scheduler and the menubar app)")
  .action((model: string, o: { for?: string }) => {
    const intent = intentOption(o.for);
    let spec;
    try {
      spec = parseModelSpec(model);
      setModel(formatSpec(spec), intent);
    } catch (err) {
      fail((err as Error).message);
    }
    console.log(`${intent ?? "default"} → ${formatSpec(spec)}`);
    if (!providerConfigured(spec.provider)) {
      console.log(dim(`Note: ${PROVIDERS[spec.provider].keyEnv[0]} is not set yet (${PROVIDERS[spec.provider].keyUrl}).`));
    }
  });

models
  .command("reset")
  .option("--for <intent>", "clear only one intent's override")
  .description("clear a saved choice (falls back to COS_MODEL, then the first provider with a key)")
  .action((o: { for?: string }) => {
    const intent = intentOption(o.for);
    setModel(null, intent);
    console.log(`Cleared ${intent ?? "the default"}.`);
  });

models
  .command("test")
  .argument("[model]", "provider:model to test; defaults to the model for ask")
  .description("send one tiny request to check the key and model name work")
  .action(async (model?: string) => {
    let provider, spec;
    try {
      ({ provider, spec } = providerFor("ask", model ?? modelFlag()));
    } catch (err) {
      fail((err as Error).message);
    }
    const started = Date.now();
    try {
      const res = await provider.chat({
        model: spec.model,
        instructions: "You are a connectivity check.",
        context: "Reply with exactly: ok",
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        tools: [],
        effort: "low",
        maxTokens: 2000,
      });
      console.log(`${formatSpec(spec)} answered "${res.text.slice(0, 60)}" in ${Date.now() - started} ms ${dim(`(served by ${res.model})`)}`);
    } catch (err) {
      await modelError(err);
    }
  });

// ---------- the native shell ----------

const menubar = program.command("menubar").description("the native macOS shell: menubar icon, floating pill, double-tap Fn, native listening");

menubar
  .command("build")
  .description("compile the Swift app into ~/Applications/Chief of Staff.app")
  .option("--port <n>", "port the shell starts the server on", process.env.COS_UI_PORT ?? "4747")
  .action(async (o: { port: string }) => {
    const root = resolve(new URL("../..", import.meta.url).pathname);
    try {
      const app = await buildMenubar({ repoRoot: root, node: process.execPath, port: Number(o.port) || 4747, log: (l) => console.log(dim(l)) });
      console.log(`Built ${app}`);
      console.log("Next: cos menubar open   (first run asks for Accessibility, Microphone and Speech permissions)");
    } catch (err) {
      fail((err as Error).message);
    }
  });

menubar
  .command("open")
  .description("launch the shell")
  .action(async () => {
    try {
      await openMenubar();
      console.log("Chief of Staff is in your menubar. Double-tap Fn (or ⌥Space) anywhere to talk to it.");
    } catch (err) {
      fail((err as Error).message);
    }
  });

menubar
  .command("install")
  .description("build, open, and start at login")
  .option("--port <n>", "port", process.env.COS_UI_PORT ?? "4747")
  .action(async (o: { port: string }) => {
    const root = resolve(new URL("../..", import.meta.url).pathname);
    try {
      await buildMenubar({ repoRoot: root, node: process.execPath, port: Number(o.port) || 4747, log: (l) => console.log(dim(l)) });
      const file = await installLoginItem();
      await openMenubar();
      console.log(`Installed. Opens at login via ${file}.`);
    } catch (err) {
      fail((err as Error).message);
    }
  });

menubar
  .command("uninstall")
  .description("quit, remove the login item and the app")
  .action(async () => {
    const removed = await uninstallMenubar();
    console.log(removed.length ? `Removed:\n${removed.join("\n")}` : "Nothing installed.");
  });

// ---------- voice ----------

program
  .command("say")
  .argument("[text...]", "text to speak; 'brief' speaks today's brief")
  .option("--offline", "rule-based brief")
  .description("read something aloud")
  .action(async (words: string[], o: { offline?: boolean }) => {
    const joined = words.join(" ").trim();
    if (!joined || joined === "brief") {
      const { brief } = await getBrief(config(), Boolean(o.offline));
      await saveBrief(brief, "say");
      return speak(renderBriefSpeech(brief));
    }
    await speak(joined);
  });

program
  .command("talk")
  .option("--seconds <n>", "max seconds to listen", "12")
  .description("speak a question (or type it), hear the answer")
  .action(async (o: { seconds: string }) => {
    needModel("ask");
    const stt = await pickStt();
    let question: string;
    if (stt) {
      console.log(dim(`Listening (${stt.name})… speak now.`));
      question = await stt.listen(Number(o.seconds) || 12);
      if (!question) return console.log("Heard nothing.");
      console.log(`${bold("You:")} ${question}`);
    } else {
      console.log(dim("No speech-to-text available (set COS_WHISPER_MODEL with whisper-cli + sox installed). Type instead."));
      question = await ask("You: ");
      if (!question) return;
    }
    const cfg = config();
    await syncTouches(cfg);
    try {
      const r = await runIntent({ config: cfg, intent: "ask", message: question, today: today(), modelFlag: modelFlag() });
      console.log(`${bold("Chief of staff:")} ${r.text}`);
      await speak(r.text);
    } catch (err) {
      await modelError(err);
    }
  });

program.parseAsync().catch((err) => fail(err instanceof Error ? err.message : String(err)));
