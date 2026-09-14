# Epic: A chief of staff that lives on my laptop

*Draft 1 — 2026-09-14*

---

## 1. The problem (no solution in this sentence)

I run many parallel things: a job, a master's, side projects, a class I teach, people I advise. My working memory is the bottleneck, not my ability. Projects go quiet not because I decided to stop but because I forgot they existed. When I do sit down to work, I spend the first twenty minutes reconstructing "where was I, what matters, what did I promise myself."

**What I do about it today:** nothing systematic. Scattered notes, calendar, whatever is on top of the Desktop. That is the real competitor: doing nothing.

**Problem statement:** I have no single place that remembers what I am working on, why, how often I said I'd touch it, and what the next move is, and nothing that puts that in front of me without being asked.

---

## 2. The one-line product

> **A chief of staff for one person.** It remembers every commitment I've made to myself, and every morning it tells me what matters today, before I ask.

Not a chatbot. Not a to-do app. Not a calendar. Those are inputs. The product is the *memory plus the initiative*: it knows, and it speaks first.

---

## 3. The core insight: this is a memory problem, not an AI problem

Every scenario I described ("what should I do today", "top 3 ROI moves on project X", "you said Thursdays") is trivial for a model **if the model has the right context**. The whole difficulty is getting that context to exist, stay current, and load automatically.

Three memory stores, in order of how much they already exist:

| Store | What it holds | Status |
|---|---|---|
| **Identity** | Who I am, how I work, what I value, how I write | Exists: `~/selfhub` (87 lines, 17 files, git-tracked) |
| **Commitments** | Projects, why each matters, cadence, status, next action, last touched | **Missing.** `goals/short-term.md` and `goals/long-term.md` are empty |
| **Journal** | What actually happened each day, what I said I'd do, what I chose | **Missing** |

The assistant is a thin loop over these three files plus the calendar. Build the ledger first. Everything else is prompt engineering on top of a ledger that exists.

---

## 4. Working backwards: the press release quote

> "I open my laptop Thursday morning and it says: *It's Thursday. You told me Thursdays are for MLGuerrilla. You haven't touched it in 12 days. Last time you said the next step was recording the intro video. You have a free block 2 to 4 pm. Want to do it then?* I didn't have to remember any of that. Now I can finally trust that nothing I care about silently dies."
> — Dimitri, Montreal

If that sentence ever feels boring, the product is wrong.

---

## 5. User stories

Persona: **me**, a builder with too many threads. Each story has acceptance criteria that can be checked in a day, not a quarter.

### US-1 · The morning brief (it's there when I open the laptop)
**As** someone who loses the thread overnight, **I want** a brief waiting for me when I open my laptop, **so that** I start the day oriented instead of reconstructing.

Acceptance:
- Appears without me typing anything, within 10 seconds of login or of the first unlock after 6 am.
- Contains: today's date and weekday, calendar for the day, the 1 to 3 things it recommends, and any cadence nudges due today.
- Fits on one screen. If it scrolls, it failed.

### US-2 · "What should I do today?"
**As** someone with a full plate, **I want** to ask the assistant what to do today and get a ranked, opinionated answer, **so that** I stop deciding by whatever is loudest.

Acceptance:
- Answer names concrete next actions, not projects ("record intro video" not "work on MLGuerrilla").
- Every recommendation cites its reason from the ledger ("because you said this ships Sept 30").
- Respects free time on the calendar. Never suggests 4 hours of work into a day with 1 free hour.

### US-3 · "I want to work on X. Highest ROI three things?"
**As** someone sitting down to a project, **I want** the three highest-leverage moves for that project, **so that** the first twenty minutes are work, not orientation.

Acceptance:
- Reads the project's ledger entry, its git log if it has one, and the last journal mentions.
- Returns exactly three items, each with a one-line why and a rough size (30 min / half day / multi-day).
- If the ledger has no "why" for the project, it asks me for it before answering, and saves the answer.

### US-4 · The cadence nudge ("you said Thursdays")
**As** someone who makes promises to myself and forgets them, **I want** the assistant to hold me to stated cadences, **so that** the promise survives my memory.

Acceptance:
- When I say "I want to work on X every Thursday", it is written to the ledger as a cadence with no further action from me.
- On the matching day the brief opens with the nudge, including days since last touch.
- I can say "not this week" and it stops for one cycle without deleting the cadence.

### US-5 · Capture is one sentence, not a form
**As** someone who won't maintain a system that costs effort, **I want** to tell the assistant things in plain sentences, **so that** the ledger stays current without discipline.

Acceptance:
- "I'm starting a project called Y, it's for Z" creates a ledger entry.
- "I finished the landing page" updates last-touched and next action.
- "Park drawcal for now" changes status to parked, and it stops appearing in briefs until I say otherwise.
- Every write is a git commit in the selfhub repo, so I can see and undo what it did.

### US-6 · Resurfacing the forgotten
**As** someone who drops projects by accident, **I want** the assistant to notice silence, **so that** dropping a project becomes a decision I make rather than a thing that happens to me.

Acceptance:
- Any active project untouched for 14 days appears in the brief with one question: keep, park, or kill.
- The answer is recorded. Parked projects resurface once a month with the same question.

### US-7 · End-of-day close (writes the journal for tomorrow)
**As** tomorrow's version of me, **I want** today's me to leave a two-line note, **so that** the morning brief has something true to work from.

Acceptance:
- One prompt at a set time or on "wrap up": "What did you touch today? What's the next move?"
- Answer is appended to the journal with the date. Under 60 seconds to complete.
- Skipping it is allowed. The assistant infers from git activity what it can.

---

## 6. The riskiest assumption, and the smallest test

**Riskiest assumption:** that I will actually read the brief and feed the ledger, every day, for more than a week. Every personal-productivity system dies here. The AI is not the risk. My own compliance is.

**The test (two weeks, zero app code):**
1. Create `~/selfhub/goals/projects.md` as the commitments ledger, with one entry per active project (see schema below). Filling this in by hand *is* the first real deliverable. It will take an hour and it will hurt, because it forces the list to be finite.
2. Create `~/selfhub/journal/` with one file per day.
3. Write one prompt file, `brief.md`, that tells Claude Code: read selfhub, read the ledger, read the last 7 journal days, read today's calendar, produce the one-screen brief.
4. Run it automatically at login (a launchd agent that opens a terminal running `claude -p "$(cat brief.md)"`) or as a scheduled Claude Code routine every morning at 7.
5. Close the day by hand: two lines in the journal file.

**Success threshold, decided now:** on day 14, I have read at least 11 of 14 briefs, and the ledger has been updated at least 8 times. If yes, build the real thing. If no, the problem is not "I need a better app", and I should look at *why* I didn't engage before writing any more code.

---

## 7. Ledger schema (the whole product is this file)

```markdown
## MLGuerrilla
- why: teach ML the way I wish I'd been taught; audience I already have
- status: active          # active | parked | done | killed
- cadence: Thursday       # or "weekly", "daily", "none"
- next: record the intro video for lesson 3
- last touched: 2026-09-02
- deadline: none
- notes: video setup lives in ~/Desktop/mlguerrilla-teach
```

Rules that make it work:
- **One `next` per project.** If I can't name the next physical action, the project is parked, not active.
- **`why` is mandatory.** The assistant uses it to rank. A project without a why cannot be ranked and cannot be defended.
- **`last touched` is updated by the assistant**, from git activity and journal mentions, so I don't have to.

---

## 8. Where to start: the first week

| Day | Do | Output |
|---|---|---|
| 1 | Write `projects.md` by hand. Every active thread. Kill or park anything without a why. | A finite list. Probably shorter than expected. |
| 1 | Write `brief.md` prompt. Test it once manually in Claude Code. | A brief that is roughly right. |
| 2 | Wire it to login (launchd) or to a 7 am scheduled routine. | It shows up without asking. |
| 2 to 7 | Live with it. Two-line journal each night. Fix the prompt when it's wrong. | Evidence about assumption in section 6. |
| 8 | Add US-3 as a second prompt file: `focus.md <project>`. | "Top 3 ROI" works from the terminal. |
| 14 | Judge against the threshold. | Build / rethink decision. |

What this deliberately does not include: a UI, a database, a vector store, an agent framework, voice, notifications on the phone. Every one of those is a "not yet" with a trigger: **when the file-based version has survived a month of real use.**

---

## 9. Architecture, by version

**v0 (weeks 1 to 2): files plus Claude Code.**
selfhub markdown as memory. Two prompt files. launchd or a scheduled routine for initiative. Git for undo. Cost: near zero. Ceiling: no persistent conversation, no push to phone.

**v1 (month 2): a menubar app.**
Small macOS menubar app (Swift or Tauri) whose only job is: show the brief on wake, accept one line of capture, call the same prompts. Calendar and Gmail via the connectors that already exist in claude.ai, or via Google APIs directly. Memory stays as markdown in selfhub. That is the point: the app is disposable, the ledger is not.

**v2 (when v1 is boring): the assistant writes the ledger itself.**
Watches git activity across `~/Desktop/*`, infers last-touched, drafts journal entries for approval, notices when a calendar event matches a project. Initiative moves from "scheduled" to "event-driven."

**Never, until a real reason appears:** a database, a vector store, a fine-tuned model, multi-user anything.

---

## 10. Hostile FAQ

**How is this different from a to-do app with reminders?**
A to-do app stores what I typed. This stores *why*, ranks by it, and speaks first. The difference is who carries the memory. Also, to-do apps have never once asked me "do you still want this?"

**How is this different from opening Claude and asking?**
Context. Bare Claude doesn't know I said Thursdays. This one does because the ledger and journal are loaded every time, and it is scheduled to talk to me, not the other way around.

**Won't the ledger rot like every other system I've tried?**
Yes, if capture costs more than a sentence. That's why US-5 exists and why the assistant, not me, owns `last touched`. Section 6 is the honest test of whether it rots anyway.

**What about privacy?**
Everything lives in a local git repo I own. The model sees it at request time. Same exposure as any Claude Code session today.

**Why markdown and not a database?**
I can read it, edit it in any editor, diff it, and undo it. The assistant can read it with `cat`. A database earns its place when files stop working, and 20 projects in one file will not stop working.

---

## 11. Not doing (and the trigger to revisit)

| Not doing | Revisit when |
|---|---|
| Phone notifications | The laptop brief has been read 25 of 30 days |
| Voice interface | I catch myself wanting to talk to it while walking, three times |
| Auto-reading email | The brief is consistently right about everything *except* things that arrived by email |
| Sharing with anyone else | Never planned. This is for one person. |
