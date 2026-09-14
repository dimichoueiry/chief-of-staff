# Chief of Staff — Backlog (epics, stories, tasks)

Companion to `EPIC.md` (why), `epic.html` (readable), `BUILD.md` (modules & contracts).
This file is the execution plan. Sizes: S ~half day, M ~1-2 days, L ~3-5 days.

---

## Locked decisions (so nobody has to ask mid-build)

- **Stack:** TypeScript + Claude Agent SDK for core & CLI. Tauri (or Swift) for the
  menubar. Python is acceptable only if the module contracts stay identical.
- **Memory:** markdown + git in `~/selfhub`. NO database, NO vector store, NO queue.
- **Brain:** ONE Claude tool-use loop. The 6 "specialists" are prompt templates in
  `brain/prompts/*.md`, not running services.
- **Build vs read (final):** BUILD what only I feed (ledger, journal, reminders, notes,
  cadences, day-plan). READ what the world feeds (calendar, email) via the macOS layer —
  one source returns all providers, no per-provider OAuth.
- **Every memory write is a git commit** (audit + one-command undo).
- **Ledger schema (locked):** per project — `why · status(active|parked|done|killed) ·
  cadence · next · lastTouched · deadline · notes`.

**Definition of Ready:** the task names its module, its contract, and its acceptance test.
**Definition of Done:** acceptance test passes; a real command produces the stated output;
prompts are files (tunable without code changes).

---

## Sequencing (the efficient path)

```
Sprint 1:  E0 + E1                -> ships v0 (brief by hand)      [CRITICAL PATH]
  === GATE: use v0 for 2 weeks. Kill criteria in EPIC.md section 6. ===
Sprint 2:  E2 + E3                -> ships v1 (speaks first + holds commitments)
Sprint 3:  E4                     -> ships v2 (menubar + day plan)
Sprint 4:  E5                     -> ships v3 (voice / Jarvis)
Sprint 5:  E6                     -> ships v4 (autonomy)
```

Critical path: **E0 -> E1 -> E2**. Everything else hangs off E1.
Parallelizable within a sprint: sensors (E2) are independent of prompt tuning; the menubar
shell (E4) is independent of the day-plan logic; voice (E5) only needs `cos ask`.
**Do not build past the GATE until v0 has been used ~11 of 14 days.**

---

## EPIC 0 — Foundation: repo + memory contract   [M]
Goal: a git-backed markdown store with a typed library. Nothing user-facing; everything
depends on it. Dependencies: none.

User stories
- US0.1 As the system, I read all projects from `projects.md` into typed objects, tolerant
  of hand edits and missing fields.
- US0.2 As me, every write to memory is a git commit so I can see and undo what happened.
- US0.3 As me, I can hand-write my initial ledger and the parser accepts it as-is.

Tasks
- T0.1 Scaffold repo: TS, Agent SDK, test runner, lint, `.env` for API key.  [S]
- T0.2 `core/ledger`: `readLedger` `writeProject`(upsert) `touch` `appendJournal`
  `readJournal(nDays)`.  [M]
- T0.3 `Project` type + tolerant markdown parser/serializer (round-trip preserves
  unknown lines).  [M]
- T0.4 Git wrapper: commit-on-write with readable messages; init selfhub if absent.  [S]
- T0.5 (human) Seed `projects.md` by hand for every active project; park/kill anything
  without a `why`.  [S]
- T0.6 Unit tests: parser round-trip + commit-on-write.  [S]

DoD: `readLedger()` returns your real projects; `writeProject` produces a commit; parsing
is lossless for known fields.

---

## EPIC 1 — The brief, end to end (v0)   [L]   [CRITICAL PATH]
Goal: `cos brief`, `cos focus`, `cos capture`, `cos ask` work from the terminal, run by
hand. Prove you'll use it. Dependencies: E0.

User stories
- US1.1 (morning brief) Running `cos brief` gives today + 1-3 next actions, each citing its
  ledger reason, fitting one screen.
- US1.2 (what should I do) `cos ask "what should I do today"` returns ranked concrete next
  actions, not project names.
- US1.3 (top-3 ROI) `cos focus <project>` returns exactly 3 moves, each with a one-line why
  and a rough size; if the project has no `why`, it asks and saves the answer.
- US1.4 (capture) `cos capture "..."` creates or updates a ledger entry as a commit.

Tasks
- T1.1 `core/context`: `buildContext(intent, project?)` = identity + activeLedger +
  recentJournal(7d) + calendar (stub for now).  [M]
- T1.2 `brain/loop`: single Claude tool-use loop; tools = ledger fns; system = persona +
  context.  [M]
- T1.3 `brain/prompts`: `brief.md` `focus.md` `capture.md` `ask.md`.  [M]
- T1.4 `cli/cos`: subcommands wire to the loop.  [S]
- T1.5 `output/render` (terminal target): one-screen formatting.  [S]
- T1.6 Calendar stub returning "all free" so the brief works before E2.  [S]

DoD: brief reads memory and prints 1-3 cited actions; capture writes a commit; usable by
hand each morning. **This is the GATE checkpoint.**

---

## EPIC 2 — It speaks first (v1): scheduler + read-only sensors   [M]
Goal: the brief appears unprompted; last-touched maintained automatically. Dependencies:
E1. **Gated by v0 success.**

User stories
- US2.1 A morning brief appears at 7am / on wake with no action from me.
- US2.2 The assistant maintains `lastTouched` from git activity; I never set it by hand.
- US2.3 The brief respects my real calendar free/busy for the day.
- US2.4 At day's end I'm prompted for a two-line journal; skipping is allowed.

Tasks
- T2.1 `sensors/git`: `scanActivity(roots)` via `git log -1`; wire to `ledger.touch()`. [M]
- T2.2 `sensors/calendar`: `todayEvents()` via macOS EventKit or icalBuddy (one source =
  all providers). Replace the E1 stub.  [M]
- T2.3 `scheduler` plists: 07:00 `cos brief`, 18:00 `cos wrap`, daily `cos silence-check`;
  installer script.  [S]
- T2.4 `wrap.md` + `cos wrap` appends the journal.  [S]
- T2.5 Deliver the 7am brief: terminal-on-login or a macOS notification.  [S]

DoD: laptop open at 8am shows a brief you didn't ask for; last-touched reflects yesterday's
git work; no manual calendar entry.

---

## EPIC 3 — Private working surfaces: capture inbox, reminders, cadences, resurfacing   [M]
Goal: the components that stop things from silently dying, all local markdown.
Dependencies: E1 (loop + ledger); timing benefits from E2 scheduler.

User stories
- US3.1 I dump any sentence and the Scribe files it: project -> ledger, thought -> note,
  future thing -> reminder. It confirms what it did.
- US3.2 I set a one-off reminder ("remind me Friday to email X") and get nudged then.
- US3.3 Cadence nudges fire on the right day ("you said Thursdays") with days-since-touch;
  "not this week" skips one cycle without deleting the cadence.
- US3.4 Any active project untouched 14 days surfaces with keep/park/kill; the answer is
  recorded; parked items resurface monthly.

Tasks
- T3.1 `notes` + `reminders` markdown stores; ledger cadence/skip fields.  [S]
- T3.2 Scribe routing in capture: classify sentence -> destination; confirm write.  [M]
- T3.3 Cadence logic in the brief: due-today detection + skip-one-cycle.  [S]
- T3.4 Resurface (silence-check) logic + monthly re-ask for parked.  [S]
- T3.5 Reminders due-check wired into the daily scheduler run.  [S]

DoD: capture routes correctly across three destinations; cadence and resurface appear in
the brief on the right days; reminders fire.

---

## EPIC 4 — Surface it (v2): menubar + notifications + day plan   [L]
Goal: one click / on wake; the brief lives where you look. Dependencies: E1-E3.

User stories
- US4.1 A menubar app shows today's brief on wake and has a one-line capture box.
- US4.2 Nudges and questions arrive as native notifications I can answer.
- US4.3 (day plan) I see my ledger next-actions placed into today's free calendar slots
  and can accept/adjust. Build the plan; borrow the grid.

Tasks
- T4.1 `apps/menubar` (Tauri or Swift): render brief; capture box -> `cos capture`.  [L]
- T4.2 Render targets: notification formatting; wire nudges from E3.  [S]
- T4.3 Day-plan generator: place next-actions into free/busy gaps; render.  [M]

DoD: brief visible on wake without the terminal; capture from the menubar; a proposed
time-blocked plan for today.

---

## EPIC 5 — Jarvis voice (v3)   [M]
Goal: talk to it, hands-free. Dependencies: E1 (`cos ask`).

User stories
- US5.1 I press a hotkey (or say a wake word), speak, and it answers aloud.
- US5.2 It reads the morning brief aloud on request.

Tasks
- T5.1 `io/voice`: STT (Whisper / Deepgram / macOS) -> `cos ask`.  [M]
- T5.2 TTS out (macOS `say` / ElevenLabs).  [S]
- T5.3 Wake word (optional) with hotkey fallback.  [M]

DoD: full spoken round-trip; brief read aloud on request.

---

## EPIC 6 — Autonomy (v4)   [M]
Goal: it maintains itself; initiative becomes event-driven. Dependencies: all prior.

User stories
- US6.1 The assistant drafts my end-of-day journal from git activity for one-tap approval.
- US6.2 When a calendar event matches a project, I get a pre-work nudge with that project's
  next action.
- US6.3 last-touched and simple status transitions happen without me.

Tasks
- T6.1 Draft journal from git commits/diff -> approval flow.  [M]
- T6.2 Calendar-event <-> project matching -> event-driven nudge.  [M]
- T6.3 Auto status heuristics (e.g., no next action -> prompt to park).  [S]

DoD: a normal day needs near-zero manual ledger upkeep.

---

## What keeps this from turning into back-and-forth

1. Contracts and schema are locked above and in BUILD.md — the agent implements to them.
2. Every task has an explicit acceptance line; no "make it nice."
3. Build-vs-read is decided per component; no re-litigating integrations mid-build.
4. No new infrastructure without hitting a stated trigger (see EPIC.md "Not doing").
5. Prompts are files: behavior is tuned by editing markdown, not shipping code.
6. The GATE prevents building five sprints of features before knowing v0 earns its keep.
