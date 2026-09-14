import { describe, expect, it } from "vitest";
import type { Brief } from "../src/brain/schema.js";
import {
  renderBriefMarkdown,
  renderBriefNotification,
  renderBriefSpeech,
  renderBriefTerminal,
} from "../src/output/render.js";

const ESC = String.fromCharCode(27);

const brief: Brief = {
  greeting: "Good morning, Dimitri",
  date: "2026-09-17",
  headline: "Thursday, September 17 · 2 things today · 1 event · 1 decision",
  focus: [
    {
      title: "Record the intro video",
      project: "MLGuerrilla",
      why: "you said Thursdays · idle 15 days",
      size: "half day",
      when: "10:30–13:30",
    },
    { title: "Reply to the design review", project: "Autodesk design review", why: "due tomorrow", size: "1 hour", when: "" },
  ],
  schedule: [
    { start: "10:00", end: "10:30", title: "Standup", free: false, plan: "" },
    { start: "10:30", end: "13:30", title: "Free block", free: true, plan: "Record the intro video" },
  ],
  decisions: [
    {
      project: "nuonc_rag",
      question: "nuonc_rag untouched 24 days — keep, park, or kill?",
      options: ["keep", "park", "kill"],
      reason: "prove RAG on legal docs",
    },
  ],
  reminders: [{ date: "2026-09-19", text: "email the advisor", overdue: false }],
  nudges: ["It's Thursday. You said Thursdays are for MLGuerrilla."],
};

describe("render", () => {
  it("terminal: one screen with every section, no escape codes when not a TTY", () => {
    const out = renderBriefTerminal(brief);
    expect(out).not.toContain(ESC);
    expect(out).toContain("Good morning, Dimitri");
    expect(out).toContain("● Record the intro video  ~ half day");
    expect(out).toContain("MLGuerrilla · you said Thursdays · idle 15 days · 10:30–13:30");
    expect(out).toContain("▌10:30–13:30  Free block  → Record the intro video");
    expect(out).toContain('cos decide "nuonc_rag" keep|park|kill');
    expect(out).toContain("· 2026-09-19  email the advisor");
  });

  it("markdown: headings and numbered focus", () => {
    const md = renderBriefMarkdown(brief);
    expect(md).toContain("## Good morning, Dimitri");
    expect(md).toContain(
      "1. **Record the intro video** — MLGuerrilla · you said Thursdays · idle 15 days _(half day, 10:30–13:30)_",
    );
    expect(md).toContain("- **10:30–13:30 Free block** → Record the intro video");
  });

  it("speech: natural sentences, spoken times, single terminal periods", () => {
    const s = renderBriefSpeech(brief);
    expect(s).toContain(
      "Good morning, Dimitri. It's Thursday, September 17. It's Thursday. You said Thursdays are for MLGuerrilla. Two things today.",
    );
    expect(s).toContain(
      "First, Record the intro video, because you said Thursdays, idle 15 days. I'd do it 10:30 a.m. to 1:30 p.m.",
    );
    expect(s).not.toContain("..");
    expect(s).toContain("On the calendar: Standup at 10 a.m.");
    expect(s).toContain("One decision. nuonc_rag untouched 24 days — keep, park, or kill?");
  });

  it("notification: title and a one-line body", () => {
    expect(renderBriefNotification(brief)).toEqual({
      title: "Good morning, Dimitri",
      body: "Record the intro video · 10:30–13:30 (+1 more)",
    });
  });
});
