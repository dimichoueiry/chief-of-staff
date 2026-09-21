/**
 * One goal, many steps on a page, with no language model in between. The model says what it wants
 * done ("find what's due this week"); Jev picks which element to act on, step after step, until the
 * goal is met, something needs the user's OK, or it stops being sure and hands the page back.
 *
 * Jev only ever chooses. It cannot write, so any text to type comes with the goal, from the model
 * that set it; Jev picks which of those to put where.
 *
 * Handing back is the ordinary outcome, not a failure: the model already has the page and every
 * guardrail still sits in tools.ts, so the worst this can do is cost a step and defer to the model.
 */
import { consequentialClick, type AssistantBrowser, type Element } from "../actions/browser.js";
import type { ChoiceAnswer, Jev, NoulAnswer } from "./jev.js";

/** Jev picks from at most 255 labels, three of which are the ways out of the page. */
const MAX_TARGETS = 251;

/**
 * How sure Jev has to be of the element before it is acted on. A page offers two hundred choices
 * where a spoken command offers twenty, and the same certainty spread over ten times the labels is
 * a much smaller number, so a clear lead over the runner-up counts as well as a high share on its
 * own. Both of these are the first numbers to tune once there are real pages to tune them against.
 */
const SURE_OF_TARGET = 0.6;
const CLEARLY_AHEAD = { atLeast: 0.25, times: 3 };
const SURE_ITS_DONE = 0.8;

const WAYS_OUT = {
  scroll: "None of the elements above is the next step, but the page continues below.",
  back: "This is the wrong page; the next step is to go back to the previous one.",
  none: "None of these is the next step, and scrolling or going back would not help either.",
};

export interface GoalRequest {
  goal: string;
  /** Text the model supplied up front for fields the loop fills in. Jev chooses among these, never writes one. */
  values?: string[];
  maxSteps?: number;
}

/** What needs the user's OK before it happens. tools.ts owns the asking; this only describes it. */
export interface Consequential {
  action: "click" | "type";
  element: Element;
  url: string;
  text?: string;
}

export type GoalOutcome =
  | { kind: "done"; page: string; steps: string[] }
  | { kind: "handover"; why: string; page: string; steps: string[] }
  | { kind: "confirm"; ask: Consequential; page: string; steps: string[] };

/** What Jev reads about one element: enough to tell it from the others that share its name. */
export function describeElement(el: Element): string {
  const name = el.name.trim();
  const what = name ? `${el.role} "${name.slice(0, 120)}"` : `${el.role} with no label`;
  return el.nth > 1 ? `${what} (the ${ordinal(el.nth)} one like it on the page)` : what;
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${tail}`;
}

/** How an element is acted on, from its role. Nothing here is a judgement, so Jev is never asked. */
function verbFor(el: Element): "click" | "type" | "select" {
  if (el.role === "textbox" || el.role === "searchbox" || el.role === "spinbutton") return "type";
  if (el.role === "combobox") return "select";
  return "click";
}

export async function runGoal(jev: Jev, browser: AssistantBrowser, o: GoalRequest): Promise<GoalOutcome> {
  const steps: string[] = [];
  const maxSteps = o.maxSteps ?? 15;
  let page = "";
  let previous = "";

  for (let step = 0; step < maxSteps; step++) {
    page = await browser.read();
    const elements = browser.elements().slice(0, MAX_TARGETS);
    if (!elements.length) return { kind: "handover", why: "the page has nothing to act on yet", page, steps };

    const labels = elements.map((_, i) => `a${i + 1}`);
    const answers = await ask(jev, o, steps, labels, elements);
    const finished = answers.finished as NoulAnswer;
    if (finished.noul >= SURE_ITS_DONE) return { kind: "done", page, steps };

    const target = answers.target as ChoiceAnswer;
    const chance = target.probabilities[target.choice] ?? 0;
    const runnerUp = Object.values(target.probabilities).sort((a, b) => b - a)[1] ?? 0;
    if (chance < SURE_OF_TARGET && !(chance >= CLEARLY_AHEAD.atLeast && chance >= CLEARLY_AHEAD.times * runnerUp)) {
      return { kind: "handover", why: `not sure what to do next (${pct(chance)})`, page, steps };
    }

    if (target.choice === "none") return { kind: "handover", why: "nothing on the page is the next step", page, steps };
    if (target.choice === "scroll") {
      await browser.scroll({ to: "down" });
      steps.push("scrolled down");
      continue;
    }
    if (target.choice === "back") {
      page = await browser.back();
      steps.push("went back");
      continue;
    }

    const el = elements[labels.indexOf(target.choice)];
    const verb = verbFor(el);
    // The same element twice running means the click did nothing: the model can see what this can't.
    const here = `${verb} ${el.ref}`;
    if (here === previous) return { kind: "handover", why: `${describeElement(el)} did not do anything`, page, steps };
    previous = here;

    if (verb === "type") {
      const text = chooseValue(o.values ?? [], answers.value as ChoiceAnswer | undefined);
      if (text === null) return { kind: "handover", why: "the next step is to type something the goal doesn't say", page, steps };
      // Typing changes nothing until it is sent, so a form fills in freely and only the Enter that
      // sends it waits for an OK. A search box is the one field where typing and sending are one act.
      if (el.role === "searchbox") return { kind: "confirm", ask: { action: "type", element: el, url: browser.address, text }, page, steps };
      page = await browser.type(el, text, false);
      steps.push(`typed into ${describeElement(el)}`);
      continue;
    }
    if (verb === "select") return { kind: "handover", why: `${describeElement(el)} is a dropdown, which needs the model to know the options`, page, steps };
    if (consequentialClick(el)) return { kind: "confirm", ask: { action: "click", element: el, url: browser.address }, page, steps };

    page = await browser.click(el);
    steps.push(`clicked ${describeElement(el)}`);
  }
  return { kind: "handover", why: `it took ${maxSteps} steps without getting there`, page, steps };
}

/** One request: whether the goal is met, what to do next, and which of the given values to type. */
function ask(jev: Jev, o: GoalRequest, steps: string[], labels: string[], elements: Element[]) {
  const values = o.values ?? [];
  return jev({
    state: { goal: o.goal, done_so_far: steps, values },
    questions: {
      finished: {
        type: "noul",
        instructions: "Going by `done_so_far` and what the page now shows, has `goal` already been reached, with nothing left to do?",
      },
      target: {
        type: "choice",
        instructions: "Which one of these is the next thing to act on to reach `goal`?",
        criteria: { ...Object.fromEntries(labels.map((l, i) => [l, describeElement(elements[i])])), ...WAYS_OUT },
      },
      ...(values.length > 1
        ? {
            value: {
              type: "choice" as const,
              instructions: "If the next step is to type into a field, which of `values` belongs in it?",
              criteria: Object.fromEntries(values.map((v, i) => [`v${i + 1}`, v.slice(0, 200)])),
            },
          }
        : {}),
    },
  }).then((r) => r.answers);
}

/** The one value given, or the one Jev picked from several, or null when the goal supplied none. */
function chooseValue(values: string[], answer: ChoiceAnswer | undefined): string | null {
  if (values.length === 1) return values[0];
  if (!values.length || !answer) return null;
  const picked = values[Number(answer.choice.slice(1)) - 1];
  return picked ?? null;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
