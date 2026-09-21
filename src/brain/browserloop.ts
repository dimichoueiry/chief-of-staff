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
import { step } from "../util/trace.js";

/** Jev picks from at most 255 labels, three of which are the ways out of the page. */
const MAX_TARGETS = 251;

/**
 * How sure Jev has to be of the element before it is acted on. A page offers two hundred choices
 * where a spoken command offers twenty, so the lead over the runner-up says more than the share
 * itself: on real pages the right answer and a genuinely ambiguous one both sit around 0.42, and
 * what separates them is that the right one leaves the next candidate far behind (0.42 against
 * 0.15) while the ambiguous one does not (0.44 against 0.39).
 */
const SURE_OF_TARGET = 0.6;
const CLEARLY_AHEAD = { atLeast: 0.25, times: 2 };
const SURE_ITS_DONE = 0.8;
/** How sure it has to be that this is the very thing named, before doing something irreversible. */
const SURE_ITS_THE_ONE = 0.7;

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
  // What it sits inside is usually what says which one it is: every listing has a "Delete listing".
  const within = el.within && el.within !== name ? `, in "${el.within.slice(0, 120)}"` : "";
  const nth = el.nth > 1 && !within ? ` (the ${ordinal(el.nth)} one like it on the page)` : "";
  return `${what}${within}${nth}`;
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

  for (let step0 = 0; step0 < maxSteps; step0++) {
    page = await browser.read();
    const elements = browser.elements().slice(0, MAX_TARGETS);
    if (!elements.length) return { kind: "handover", why: "the page has nothing to act on yet", page, steps };

    const labels = elements.map((_, i) => `a${i + 1}`);
    let answers: Awaited<ReturnType<typeof ask>>;
    const asked = Date.now();
    try {
      answers = await ask(jev, o, steps, labels, elements);
    } catch (err) {
      // A slow, unreachable or unreadable Jev costs one step, never the run: the model is holding
      // the page and everything done so far, so it carries on from here as it would have anyway.
      return { kind: "handover", why: `Jev couldn't answer (${(err as Error).message})`, page, steps };
    }
    const finished = answers.finished as NoulAnswer;
    if (finished.noul >= SURE_ITS_DONE) return { kind: "done", page, steps };

    const target = answers.target as ChoiceAnswer;
    const chance = target.probabilities[target.choice] ?? 0;
    const runnerUp = Object.values(target.probabilities).sort((a, b) => b - a)[1] ?? 0;
    const picked = labels.indexOf(target.choice);
    step("browser", `step ${step0 + 1}: ${picked >= 0 ? describeElement(elements[picked]) : target.choice}`, {
      p: chance, runnerUp, done: finished.noul, of: elements.length, ms: Date.now() - asked,
    });
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
    if (consequentialClick(el)) {
      // Picking the best of two hundred labels is not the same as being right about this one. Before
      // something that cannot be undone, ask plainly whether it belongs to what the goal named.
      const right = await isTheOne(jev, o.goal, el).catch(() => null);
      if (right !== null && right < SURE_ITS_THE_ONE) {
        return { kind: "handover", why: `${describeElement(el)} may not be the one “${o.goal}” means (${pct(right)})`, page, steps };
      }
      return { kind: "confirm", ask: { action: "click", element: el, url: browser.address }, page, steps };
    }

    page = await browser.click(el);
    steps.push(`clicked ${describeElement(el)}`);
  }
  return { kind: "handover", why: `it took ${maxSteps} steps without getting there`, page, steps };
}

/** One yes/no, about the thing itself: is this the one the goal names? */
async function isTheOne(jev: Jev, goal: string, el: Element): Promise<number> {
  const r = await jev({
    state: { goal, element: describeElement(el), within: el.within ?? null },
    questions: {
      right_one: {
        type: "noul",
        instructions:
          "`element` is about to be clicked, and it cannot be undone. Going by `within`, the thing it belongs to, " +
          "is this the very one `goal` names? Answer no if `goal` names something else, or if nothing here says which one this is.",
      },
    },
  });
  return (r.answers.right_one as NoulAnswer).noul;
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
