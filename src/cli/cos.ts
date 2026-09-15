#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Command } from "commander";
import { Conversations, conversationsDir } from "../brain/conversation.js";
import { runIntent, providerFor, RefusedError } from "../brain/loop.js";
import { WRITES } from "../brain/tools.js";
import { renderRecall, searchConversations, summarizeEnded, summaryText } from "../brain/recall.js";
import {
  MODEL_INTENTS, NoModelError, PROVIDERS, PROVIDER_ORDER, explainNotReady, formatSpec, parseModelSpec,
  presets, providerConfigured, readModelSettings, resolveModel, rememberModel, setModel, settingsFile, type ModelIntent,
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
import { join, resolve } from "node:path";
import * as launchd from "../scheduler/launchd.js";
import { eventsInRange, formatAgenda } from "../sensors/calendar.js";
import { pickStt } from "../voice/stt.js";
import {
  DEFAULT_VOICE, LISTEN_PAUSE, OPENAI_VOICES, activeTts, isKnownVoice, readVoiceSettings, saveVoiceSettings, speak, voiceSettingsFile,
  type TtsProvider,
} from "../voice/tts.js";
import { activityRoots, applyActivity, scanActivity } from "../sensors/git.js";
import { addDays, isISODate, todayISO } from "../util/dates.js";
import { homeEnvFile, parseEnv, syncProjectEnv } from "../util/env.js";
import { deployRuntime } from "./deploy.js";
import { openOrQueue, performOpen } from "../actions/open.js";
import { ACCESS_MODES, accessFile, isAccessMode, readAccess, saveAccess, type AccessMode } from "../actions/access.js";
import { AgentGrid, formatSessions } from "../actions/agentgrid.js";
import { findFolders, formatFolderSearch } from "../actions/folders.js";
import { Shortcuts } from "../actions/shortcuts.js";
import { findBoards, slateBaseUrl, slateBoardUrl, slateBoards } from "../actions/slate.js";
import { buildMenubar, installLoginItem, openMenubar, restartMenubar, uninstallMenubar } from "./menubar.js";
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
  const ledger = new Ledger(cfg.selfhubDir);
  const touched = await applyActivity(ledger, await scanActivity(activityRoots(cfg.projectRoots, await ledger.read())));
  if (!quiet) {
    if (!touched.length) console.log("Nothing new in git.");
    for (const t of touched) console.log(`touched ${t.project} → ${t.date}  (${t.path})`);
  }
}

// ---------- init ----------

const LEDGER_TEMPLATE = `# Projects

One block per project. Fields: why · status (active | parked | done | killed) · cadence · next · last touched · deadline · notes · path
Rules: one next action per project. A why helps rank it. last touched is maintained for you from git activity.
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
    if (o.speak) await speakAndReport(renderBriefSpeech(brief));
  });

// ---------- model intents ----------

/** What the pill's earlier conversations add to a one-off terminal question. */
function recallFor(cfg: Config) {
  const conversations = new Conversations(conversationsDir(), cfg.conversationIdleMinutes);
  return { recall: renderRecall(conversations, { today: today() }), actions: { conversations } };
}

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
      ...recallFor(cfg),
      onText: (t) => {
        streamed = true;
        process.stdout.write(t);
      },
    });
    if (!streamed) process.stdout.write(r.text);
    process.stdout.write("\n");
    const writes = r.toolCalls.filter((c) => !c.isError && WRITES.includes(c.name));
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

// ---------- terminal and agents ----------

const accessCmd = program
  .command("access")
  .description("what the assistant may do on its own: the terminal and Agent Grid agents")
  .action(() => {
    const a = readAccess();
    const explain: Record<AccessMode, string> = {
      off: "not at all",
      ask: "looks around freely; anything that changes something waits for your OK",
      auto: "does it; deletes, force pushes and the like still ask; sudo and disk erasing never run",
    };
    console.log(`${bold("terminal")}  ${a.terminal}  ${dim(explain[a.terminal])}`);
    console.log(`${bold("agents")}    ${a.agents}  ${dim(a.agents === "ask" ? "can list and read agents; starting or messaging one waits for your OK" : explain[a.agents])}`);
    console.log(`${bold("screen")}    ${a.screen}  ${dim(a.screen === "off" ? "never looks at your screen" : "looks when you say \"look at this\" or point at something on screen")}`);
    console.log(`${bold("links")}     ${a.links}  ${dim(a.links === "auto" ? "web pages it finds or builds open straight away" : a.links === "ask" ? "web pages it finds or builds wait for your OK" : "it never opens web pages it came up with")}`);
    console.log(dim("An OK can be spoken: \"yeah, send it\" or \"no\" works as well as the button."));
    console.log(dim(`Change: cos access terminal auto | cos access agents ask   (saved in ${accessFile()})`));
    console.log(dim(`Every command it runs is logged in ~/.cos/logs/terminal.log`));
  });

for (const what of ["terminal", "agents", "links", "screen"] as const) {
  accessCmd
    .command(what)
    .argument("<mode>", ACCESS_MODES.join(" | "))
    .description(`set ${what} access`)
    .action((mode: string) => {
      if (!isAccessMode(mode)) fail(`mode must be one of: ${ACCESS_MODES.join(", ")}`);
      saveAccess({ [what]: mode });
      console.log(`${what} access → ${mode}. Applies to the next thing it does.`);
    });
}

program
  .command("agents")
  .description("your Agent Grid sessions, as the assistant sees them")
  .action(async () => {
    try {
      console.log(formatSessions(await new AgentGrid().sessions()));
    } catch (err) {
      fail((err as Error).message);
    }
  });

// ---------- screen ----------

program
  .command("screen")
  .argument("[action]", "request: show macOS's permission prompt for the app")
  .description("whether the app may look at your screen (Screen & System Audio Recording)")
  .action(async (action?: string) => {
    const port = process.env.COS_UI_PORT ?? "4747";
    const url = `http://127.0.0.1:${port}/api/screen${action === "request" ? "/request" : ""}`;
    try {
      const r = (await (await fetch(url, { method: action === "request" ? "POST" : "GET" })).json()) as { permission: boolean; access?: string };
      console.log(r.permission ? "The app can see your screen." : "The app can't see your screen yet: turn on Chief of Staff in System Settings › Privacy & Security › Screen & System Audio Recording.");
      if (r.access === "off") console.log(dim("Looking is turned off here: cos access screen auto"));
    } catch {
      fail("The menubar app isn't running (cos menubar open). Permission belongs to the app, so it has to answer.");
    }
  });

// ---------- folders ----------

program
  .command("folders")
  .argument("<name...>", "a folder name as you'd say it, e.g. ml gorilla")
  .description("find folders by a loose or misheard name (what the assistant uses to find project paths)")
  .action(async (name: string[]) => {
    console.log(formatFolderSearch(await findFolders(name.join(" "), { roots: config().projectRoots })));
  });

// ---------- conversations ----------

const conversationsCmd = program
  .command("conversations")
  .description("earlier conversations from the pill, with their summaries")
  .option("--days <n>", "how many days back", "7")
  .action((o: { days: string }) => {
    const cfg = config();
    const store = new Conversations(conversationsDir(), cfg.conversationIdleMinutes);
    const days = Math.max(1, Number(o.days) || 7);
    const since = addDays(today(), -(days - 1));
    const { conversations, unreadable } = store.list();
    const active = store.current().id;
    const shown = conversations.filter((c) => c.turns.some((t) => t.role === "user") && todayISO(new Date(c.updatedAt)) >= since);
    if (!shown.length) console.log(`No conversations in the last ${days} day${days === 1 ? "" : "s"}.`);
    for (const c of shown) {
      const start = new Date(c.startedAt);
      const label = `${todayISO(start)} ${start.toTimeString().slice(0, 5)}`;
      const said = c.turns.filter((t) => t.role === "user").length;
      console.log(`${bold(label)}  ${dim(`${said} message${said === 1 ? "" : "s"}${c.id === active ? " · in progress" : c.summary ? ` · ${c.summary.model}` : " · not summarised yet"}`)}`);
      console.log(`  ${summaryText(c)}`);
    }
    if (unreadable) console.log(dim(`${unreadable} damaged file${unreadable === 1 ? "" : "s"} in ${store.dir} could not be read.`));
    console.log(dim(`${conversations.length} saved in ${store.dir}`));
  });

conversationsCmd
  .command("search")
  .argument("[words...]", "keywords; leave out to list by date")
  .option("--from <date>", "first day, YYYY-MM-DD")
  .option("--to <date>", "last day, YYYY-MM-DD")
  .option("--limit <n>", "results to show", "8")
  .description("search every saved conversation")
  .action((words: string[], o: { from?: string; to?: string; limit: string }) => {
    for (const d of [o.from, o.to]) if (d && !isISODate(d)) fail(`Dates are YYYY-MM-DD, got "${d}".`);
    const store = new Conversations(conversationsDir(), config().conversationIdleMinutes);
    console.log(searchConversations(store, { query: words.join(" ") || undefined, from: o.from, to: o.to, limit: Math.max(1, Number(o.limit) || 8) }));
  });

conversationsCmd
  .command("summarize")
  .description("write summaries for ended conversations now (the app does this after each message)")
  .option("--limit <n>", "most model calls to make", "10")
  .action(async (o: { limit: string }) => {
    const cfg = config();
    const store = new Conversations(conversationsDir(), cfg.conversationIdleMinutes);
    let llm = null;
    if (modelReady("ask")) llm = providerFor("ask", modelFlag());
    else console.log(dim("No model: only short conversations are summarised (from their own words)."));
    const r = await summarizeEnded(store, llm, { limit: Math.max(1, Number(o.limit) || 10) });
    console.log(`${r.summarized} summarised${r.failed ? `, ${r.failed} failed (retried in 6 hours)` : ""}${r.waiting ? `, ${r.waiting} still waiting` : ""}.`);
  });

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
  .description("your calendar as the assistant sees it")
  .option("--days <n>", "how many days starting today", "7")
  .option("--from <date>", "first day, YYYY-MM-DD")
  .option("--to <date>", "last day, YYYY-MM-DD (inclusive)")
  .action(async (o: { days: string; from?: string; to?: string }) => {
    const from = o.from ?? today();
    const to = o.to ?? addDays(from, Math.max(1, Number(o.days) || 7) - 1);
    const r = await eventsInRange(from, to);
    console.log(dim(`${from} to ${to} · source: ${r.provider}${r.error ? ` · error: ${r.error}` : ""}`));
    if (!r.error) console.log(formatAgenda(r.events, from, to));
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
    let runtime;
    try {
      // launchd cannot read a repo inside Desktop/Documents; run a copy from ~/.cos/app instead.
      runtime = await deployRuntime(root, (l) => console.log(dim(l)));
    } catch (err) {
      fail((err as Error).message);
    }
    const jobs = await launchd.install({ node: process.execPath, entry: runtime.entry, cwd: runtime.dir }, { morning: o.morning, evening: o.evening, silence: o.silence });
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
      rememberModel(formatSpec(spec)); // shows in the menubar's Model menu from now on
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

// ---------- opening things ----------

program
  .command("open")
  .argument("<target...>", 'slate, "slate board <name>", a shortcut, a project, an app, "search for …", or a web address')
  .option("--app <name>", "open a folder or file in this app, e.g. Cursor")
  .option("-y, --yes", "open web addresses without asking")
  .description("open something: Slate boards, shortcuts, projects, apps, searches, websites")
  .action(async (words: string[], o: { app?: string; yes?: boolean }) => {
    const cfg = config();
    const r = await openOrQueue({
      target: words.join(" "),
      app: o.app,
      shortcuts: await new Shortcuts(cfg.selfhubDir).list(),
      projects: await new Ledger(cfg.selfhubDir).read(),
      boards: () => slateBoards(),
    });
    if (r.status === "opened") return console.log(r.message);
    if (r.status === "failed") {
      console.error(`Couldn't open that: ${r.message}.`);
      if (r.candidates?.length) console.error(dim(`Known: ${r.candidates.slice(0, 12).join(", ")}`));
      process.exit(1);
    }
    if (!(await confirm(r.message, o.yes))) return console.log("Not opened.");
    console.log(await performOpen(r.pending.payload));
  });

const shortcutsCmd = program
  .command("shortcuts")
  .description("named places to open: websites, folders, documents")
  .action(async () => {
    const store = new Shortcuts(config().selfhubDir);
    const all = await store.list();
    if (!all.length) console.log(`No shortcuts yet. Add one: cos shortcuts add gmail https://mail.google.com`);
    const w = Math.max(0, ...all.map((x) => x.name.length));
    for (const x of all) console.log(`${x.name.padEnd(w)}  ${dim(x.target)}`);
    console.log(dim(`Built in: slate (${slateBaseUrl()}/app), "slate board <name>", your projects, installed apps, "search for …"`));
    console.log(dim(`saved in ${store.file}`));
  });

shortcutsCmd
  .command("add")
  .argument("<name>", 'e.g. gmail, or "drawcal repo" in quotes')
  .argument("<target>", "https://… or ~/path")
  .description("save or update a shortcut")
  .action(async (name: string, target: string) => {
    const { safeWebUrl, checkPath } = await import("../actions/open.js");
    if (!safeWebUrl(target)) {
      const checked = await checkPath(target);
      if ("error" in checked) fail(`Target must be an http(s) address or something in your home folder: ${checked.error}`);
    }
    const { created } = await new Shortcuts(config().selfhubDir).set(name, target);
    console.log(`${created ? "Saved" : "Updated"} "${name}" → ${target}`);
  });

shortcutsCmd
  .command("remove")
  .argument("<name>")
  .description("delete a shortcut")
  .action(async (name: string) => {
    console.log((await new Shortcuts(config().selfhubDir).remove(name)) ? `Removed "${name}".` : `No shortcut called "${name}".`);
  });

program
  .command("slate")
  .argument("[query...]", "filter boards by name")
  .description("list your Slate boards (the names `open slate board …` understands)")
  .action(async (words: string[]) => {
    const r = await slateBoards();
    console.log(dim(r.live ? "live from Slate" : `cached list (${r.reason})`));
    const q = words.join(" ").trim();
    const boards = q ? findBoards(r.boards, q) : r.boards.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    if (!boards.length) return console.log(q ? `No board matches "${q}".` : "No boards.");
    for (const b of boards.slice(0, 40)) console.log(`${b.name}${b.projectName ? dim(`  · ${b.projectName}`) : ""}  ${dim(slateBoardUrl(b.id))}`);
  });

// ---------- keys ----------

const projectRoot = () => resolve(new URL("../..", import.meta.url).pathname);

const envCmd = program
  .command("env")
  .description("where API keys are read from, and which providers have one")
  .action(() => {
    const file = homeEnvFile();
    const values = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : new Map<string, string>();
    console.log(`${bold("Keys file")}  ${file}${existsSync(file) ? "" : dim("  (not created yet)")}`);
    for (const id of PROVIDER_ORDER) {
      const p = PROVIDERS[id];
      const inFile = p.keyEnv.find((k) => values.has(k));
      const ready = providerConfigured(id);
      const where = inFile ? `${inFile} set` : ready ? "set in your shell" : dim(`${p.keyEnv[0]} missing`);
      console.log(`  ${ready ? "●" : dim("○")} ${p.label.padEnd(48)} ${where}`);
    }
    const projectEnv = join(projectRoot(), ".env");
    if (existsSync(projectEnv)) console.log(dim(`The project's ${projectEnv} is copied here automatically whenever it is newer.`));
    console.log(dim("The menubar app picks up key changes on its next request; no restart needed."));
  });

envCmd
  .command("sync")
  .description("copy the project's .env to ~/.cos/.env now")
  .action(() => {
    const r = syncProjectEnv(projectRoot());
    console.log(r === "copied" ? `Copied ${join(projectRoot(), ".env")} → ${homeEnvFile()}` : r === "unchanged" ? `Already up to date: ${homeEnvFile()}` : "No project .env found.");
  });

// ---------- the native shell ----------

const menubar = program.command("menubar").description("the native macOS shell: menubar icon, floating pill, double-tap Control, native listening");

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
      console.log("Chief of Staff is running. Double-tap Control anywhere to talk, or ⌥Space to type.");
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
  .command("refresh")
  .description("update the code the app runs and restart it; keeps permissions (use after code changes, unless Swift changed)")
  .action(async () => {
    try {
      const r = await deployRuntime(projectRoot(), (l) => console.log(dim(l)));
      await restartMenubar();
      console.log(`Restarted Chief of Staff with the latest code (${r.dir}).`);
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
      await speakAndReport(renderBriefSpeech(brief));
      return;
    }
    await speakAndReport(joined);
  });

async function speakAndReport(text: string): Promise<void> {
  const r = await speak(text, { onFallback: (why) => console.error(dim(`OpenAI voice failed (${why}); using the Mac voice.`)) });
  if (process.env.COS_DEBUG) console.error(dim(`spoke with ${r.engine} in ${r.pieces} piece(s)`));
}

const voiceCmd = program
  .command("voice")
  .description("how it sounds: OpenAI's natural voice, or the Mac voice")
  .action(() => {
    const s = readVoiceSettings();
    const engine = activeTts(s);
    console.log(`${bold("Speaking with")}  ${engine === "openai" ? `OpenAI ${s.model}, voice ${s.voice}` : `the Mac voice${s.sayVoice ? ` (${s.sayVoice})` : ""}`}`);
    if (engine === "say" && s.provider === "auto") console.log(dim("  Add OPENAI_API_KEY to .env for the natural voice."));
    console.log(`  provider  ${s.provider}${s.provider === "auto" ? dim("  (OpenAI when a key is set, otherwise the Mac voice)") : ""}`);
    console.log(`  speed     ${s.speed}`);
    console.log(`  pause     ${s.listenPause}s of quiet ends what you say ${dim("(cos voice pause <seconds>)")}`);
    console.log(`  style     ${dim(s.instructions)}`);
    console.log("");
    console.log(`${bold("Voices")}  ${OPENAI_VOICES.map((v) => (v === s.voice ? `[${v}]` : v)).join("  ")}`);
    console.log(dim("  Hear one: cos voice test --voice cedar      Keep one: cos voice use cedar"));
    console.log(dim(`  saved in ${voiceSettingsFile()}`));
  });

voiceCmd
  .command("use")
  .argument("<voice>", `one of: ${OPENAI_VOICES.join(", ")} (or a custom voice_… id)`)
  .description("choose the OpenAI voice")
  .action((voice: string) => {
    if (!isKnownVoice(voice)) fail(`Unknown voice "${voice}". Choose from: ${OPENAI_VOICES.join(", ")}`);
    saveVoiceSettings({ voice });
    console.log(`Voice → ${voice}`);
  });

voiceCmd
  .command("provider")
  .argument("<provider>", "auto | openai | say")
  .description("force OpenAI or the Mac voice, or let it pick (auto)")
  .action((provider: string) => {
    if (!["auto", "openai", "say"].includes(provider)) fail("provider must be auto, openai or say");
    saveVoiceSettings({ provider: provider as TtsProvider });
    console.log(`Provider → ${provider} (now speaking with ${activeTts()})`);
  });

voiceCmd
  .command("style")
  .argument("<instructions...>", 'how it should sound, e.g. "upbeat and quick, like a coach"')
  .description("steer tone, pace and emotion (OpenAI voice)")
  .action((words: string[]) => {
    saveVoiceSettings({ instructions: words.join(" ") });
    console.log("Style saved.");
  });

voiceCmd
  .command("speed")
  .argument("<n>", "0.25 to 4; 1 is normal")
  .description("speaking speed (OpenAI voice)")
  .action((n: string) => {
    const speed = Number(n);
    if (!(speed >= 0.25 && speed <= 4)) fail("speed must be between 0.25 and 4");
    saveVoiceSettings({ speed });
    console.log(`Speed → ${speed}`);
  });

voiceCmd
  .command("pause")
  .argument("<seconds>", `${LISTEN_PAUSE.min} to ${LISTEN_PAUSE.max}; default ${DEFAULT_VOICE.listenPause}`)
  .description("how long a pause ends what you're saying when you talk to the menubar app")
  .action((n: string) => {
    const seconds = Number(n);
    if (!(seconds >= LISTEN_PAUSE.min && seconds <= LISTEN_PAUSE.max)) fail(`pause must be between ${LISTEN_PAUSE.min} and ${LISTEN_PAUSE.max} seconds`);
    saveVoiceSettings({ listenPause: seconds });
    console.log(`Pause → ${seconds}s. Applies the next time you talk; it waits 1.5s longer when you trail off ("and…", "um").`);
  });

voiceCmd
  .command("test")
  .argument("[text...]", "what to say")
  .option("--voice <voice>", "try a voice without saving it")
  .description("hear the current voice")
  .action(async (words: string[], o: { voice?: string }) => {
    if (o.voice && !isKnownVoice(o.voice)) fail(`Unknown voice "${o.voice}". Choose from: ${OPENAI_VOICES.join(", ")}`);
    const settings = { ...readVoiceSettings(), ...(o.voice ? { voice: o.voice } : {}) };
    const text = words.join(" ").trim() || `Good morning${loadConfig().name ? `, ${loadConfig().name}` : ""}. Three things today. First, record the intro video. Second, reply to the design review before lunch. Third, park anything you haven't touched in two weeks.`;
    console.log(dim(`Speaking with ${activeTts(settings) === "openai" ? `OpenAI voice ${settings.voice}` : "the Mac voice"}…`));
    const r = await speak(text, { settings, onFallback: (why) => console.error(dim(`OpenAI voice failed (${why}); used the Mac voice.`)) });
    if (!r.fellBack) console.log(dim("Done."));
  });

voiceCmd
  .command("reset")
  .description(`back to the defaults (voice ${DEFAULT_VOICE.voice}, auto provider)`)
  .action(() => {
    saveVoiceSettings(null);
    console.log("Voice settings reset.");
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
      const r = await runIntent({ config: cfg, intent: "ask", message: question, today: today(), modelFlag: modelFlag(), ...recallFor(cfg) });
      console.log(`${bold("Chief of staff:")} ${r.text}`);
      await speakAndReport(r.text);
    } catch (err) {
      await modelError(err);
    }
  });

program.parseAsync().catch((err) => fail(err instanceof Error ? err.message : String(err)));
