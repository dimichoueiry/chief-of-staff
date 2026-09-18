/**
 * The fast lane for commands: when what they said only asks to open something the assistant already
 * knows about ("Darius, open the browser for me", "get Cursor up", "take me to my email"), Jev picks it
 * from a list and it opens in a fraction of a second, with no language model in the way.
 *
 * Jev only chooses; it never writes. So the lane covers what can be picked from a list: installed apps,
 * the default browser, shortcuts, project folders, Slate and the privacy settings pages. Everything else
 * returns a reason and goes to the language model as before, which answers out loud: a question, a note,
 * an agent to start (its task has to be written), "open it" about something said earlier, or
 * "open X and search for Y".
 *
 * Wrong is worse than slow here, since the model gets a second look at anything this lets go.
 */
import type { Project } from "../core/ledger.js";
import { defaultBrowser, installedApps, safeWebUrl, type OpenAction } from "../actions/open.js";
import { PRIVACY_PANES } from "../actions/permissions.js";
import type { Shortcut } from "../actions/shortcuts.js";
import { slateHomeUrl } from "../actions/slate.js";
import type { ChoiceAnswer, Jev, NoulAnswer } from "./jev.js";

export interface OpenTarget {
  /** What Jev reads about it. */
  describe: string;
  /** What opens when it's chosen. "browser" is looked up at that point, since the default can change. */
  action: OpenAction | "browser";
}

/** Jev picks from at most 255 labels and one of them is "none". Apps past that are left to the model. */
const MAX_TARGETS = 254;

/** How sure Jev has to be. Below any of these, the model decides. */
const SURE_WANTS_OPEN = 0.8;
const SURE_OF_TARGET = 0.75;
const MAX_ASKS_MORE = 0.3;

/** What there is to open, most personal first, so a cut only ever drops installed apps. */
export function openTargets(o: {
  shortcuts: Shortcut[];
  projects: Project[];
  apps?: { name: string; path: string }[];
}): OpenTarget[] {
  const targets: OpenTarget[] = [{ describe: "Their web browser, when they don't say which one", action: "browser" }];
  for (const s of o.shortcuts) {
    const url = safeWebUrl(s.target);
    targets.push({
      describe: `${s.name}: their saved shortcut to ${s.target}`,
      action: url ? { kind: "url", url, label: s.name, trusted: true } : { kind: "path", path: s.target, label: s.name },
    });
  }
  for (const p of o.projects) {
    if (p.path) targets.push({ describe: `${p.name}: the folder of their project ${p.name}`, action: { kind: "path", path: p.path, label: p.name } });
  }
  targets.push({ describe: "Slate, their canvas app (its home, not one board)", action: { kind: "url", url: slateHomeUrl(), label: "Slate", trusted: true } });
  for (const pane of PRIVACY_PANES) {
    const label = `System Settings › Privacy & Security › ${pane.name}`;
    targets.push({ describe: label, action: { kind: "settings", anchor: pane.anchor, label } });
  }
  for (const app of o.apps ?? installedApps()) {
    targets.push({ describe: `${app.name} (app)`, action: { kind: "app", app: app.path, label: app.name } });
  }
  return targets.slice(0, MAX_TARGETS);
}

export type FastDecision =
  | { open: OpenAction; model: string; sure: number }
  | { skip: string };

/**
 * Ask Jev, in one call, whether this only asks to open something, which listed thing it is, and whether
 * it asks for anything beyond that. Opens only when all three answers are clear.
 */
export async function decideOpen(
  jev: Jev,
  said: string,
  targets: OpenTarget[],
  browser: () => Promise<{ name: string; path: string } | null> = () => defaultBrowser(),
): Promise<FastDecision> {
  const labels = targets.map((_, i) => `t${i + 1}`);
  // The default browser is looked up while Jev decides, so it costs nothing when it's the answer.
  const [result, browserApp] = await Promise.all([
    jev({
      state: { said },
      questions: {
        wants: {
          type: "choice",
          instructions: "What does the person want from their assistant, going by `said`?",
          criteria: {
            open: "Only to open, launch, switch to or bring up something on their computer: an app, their browser, a saved website, a project folder or a settings page.",
            other: "Anything else: a question to answer, advice, a plan, something to remember, a message, starting or talking to an agent, running a command, searching for something, or several things at once.",
          },
        },
        target: {
          type: "choice",
          instructions: "Which one of these does `said` ask to open?",
          criteria: { ...Object.fromEntries(labels.map((l, i) => [l, targets[i].describe])), none: "None of these, or it doesn't say which." },
        },
        more: {
          type: "noul",
          instructions:
            "Does `said` ask for more than opening one thing: which app to open it in, a page, address or search inside it, " +
            "what to do once it's open, a second thing, or something from earlier in the conversation (\"it\", \"that one\", \"the second one\")?",
        },
      },
    }),
    targets.some((t) => t.action === "browser") ? browser().catch(() => null) : Promise.resolve(null),
  ]);

  const wants = result.answers.wants as ChoiceAnswer;
  const target = result.answers.target as ChoiceAnswer;
  const more = result.answers.more as NoulAnswer;
  const pOpen = wants.probabilities?.open ?? (wants.choice === "open" ? wants.confidence : 1 - wants.confidence);
  if (pOpen < SURE_WANTS_OPEN) return { skip: `wants open ${pct(pOpen)}` };
  if (more.noul > MAX_ASKS_MORE) return { skip: `asks for more ${pct(more.noul)}` };

  // Two labels can open the same thing ("the browser" and "Microsoft Edge"): their chances add up.
  const actions = targets.map((t): OpenAction | null =>
    t.action !== "browser" ? t.action : browserApp ? { kind: "app", app: browserApp.path, label: browserApp.name } : null,
  );
  const picked = labels.indexOf(target.choice);
  if (picked >= 0 && !actions[picked]) return { skip: "no default browser found" };
  const chance = (i: number) => target.probabilities?.[labels[i]] ?? (target.choice === labels[i] ? target.confidence : 0);
  const byAction = new Map<string, { action: OpenAction; p: number }>();
  actions.forEach((a, i) => {
    if (!a) return;
    const key = actionKey(a);
    const seen = byAction.get(key);
    byAction.set(key, { action: seen?.action ?? a, p: (seen?.p ?? 0) + chance(i) });
  });
  const best = [...byAction.values()].sort((a, b) => b.p - a.p)[0];
  if (target.choice === "none") return { skip: `target none ${pct(target.confidence)}` };
  if (!best || best.p < SURE_OF_TARGET) return { skip: `target ${pct(best?.p ?? 0)}` };
  return { open: best.action, model: result.model, sure: best.p };
}

function actionKey(a: OpenAction): string {
  switch (a.kind) {
    case "url":
      return `url ${a.url}`;
    case "path":
      return `path ${a.path}`;
    case "app":
      return `app ${a.app}`;
    case "settings":
      return `settings ${a.anchor}`;
  }
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
