# Chief of Staff — Build Spec (handoff for the coding agent)

A personal "Jarvis": an assistant that lives on the laptop, remembers every commitment
I've made to myself, and speaks first every morning. See `EPIC.md` for the product
rationale and `epic.html` for the readable version. This file is the engineering plan.

## The one rule that shapes the whole build

**The "6 agents" are not 6 services.** v1 is ONE Claude tool-use loop + the ledger
functions exposed as tools + 6 prompt templates. Do not build a multi-agent system,
a queue, a database, or a vector store. Build the ledger contract first; every other
module plugs into it.

Value lives in the **data contract (the ledger)** and the **loop**, not in agent count.

## Repo layout

```
chief-of-staff/
  core/
    ledger.ts        # read/write the git-backed markdown store  ★ BUILD FIRST
    context.ts       # assemble the right memory slice per request
  sensors/
    calendar.ts      # today's free/busy
    git.ts           # activity across ~/Desktop/* -> last touched
  brain/
    loop.ts          # the single Claude tool-use loop (the orchestrator)
    prompts/
      brief.md focus.md capture.md wrap.md resurface.md cadence.md
  output/
    render.ts        # format one brief for terminal | notification | speech
  cli/
    cos.ts           # `cos brief|focus|capture|wrap|ask` — wraps brain/loop
  scheduler/
    *.plist          # launchd: 07:00 brief, 18:00 wrap, daily silence-check
  apps/menubar/      # v2 — Tauri or Swift; calls `cos`
  io/voice/          # v3 — STT in, TTS out
```

Memory lives OUTSIDE this repo, in `~/selfhub` (already a git repo):
`~/selfhub/goals/projects.md` (ledger) and `~/selfhub/journal/YYYY-MM-DD.md`.

## Module contracts

### core/ledger  ★ start here
```
readLedger(): Project[]
writeProject(name, patch): void        // upsert an entry, then git commit
touch(name, dateISO): void             // update lastTouched
appendJournal(dateISO, text): void     // append + git commit
readJournal(nDays): string
```
Project schema (one markdown block per project in projects.md):
`why · status(active|parked|done|killed) · cadence · next · lastTouched · deadline · notes`
Every write is a git commit in the selfhub repo (audit + one-command undo).
Parser must tolerate hand edits and missing fields.

### core/context
```
buildContext(intent, project?):
  { identity, activeLedger, recentJournal(7d), todayCalendar }
```
`identity` = the selfhub markdown files. Return one prompt-ready bundle.

### sensors/calendar
```
todayEvents(): Event[]   // free/busy blocks for today
```
Impl: Google Calendar API (OAuth) OR macOS EventKit / `icalBuddy`. Start with whichever
is fastest to wire; keep it behind this interface so it's swappable.

### sensors/git
```
scanActivity(roots[]): Map<projectPath, lastCommitISO>
```
Impl: for each dir, `git -C <dir> log -1 --format=%cI`. Output feeds `ledger.touch()`
so lastTouched is maintained automatically, not by hand.

### brain/loop  (the orchestrator)
- Input: a user message OR a scheduled intent (`brief` | `wrap` | `silence-check`).
- System prompt: the Chief-of-Staff persona + `buildContext(intent)`.
- Tools (function calling): all ledger functions + both sensors.
- The model decides which tool(s) to call and which prompt template applies.
- Model-agnostic: the loop talks to a neutral provider contract (`brain/llm/`). Adapters: Anthropic SDK for Claude; the OpenAI SDK for OpenAI, OpenRouter and any OpenAI-compatible server. Model chosen per intent as `provider:model`.

### brain/prompts/*.md
Six markdown instruction files, loaded per intent. They ARE the "specialists":
`brief` (morning one-screen), `focus <project>` (top-3 ROI), `capture` (sentence -> ledger
write), `wrap` (end-of-day two-liner), `resurface` (14-day silence -> keep/park/kill),
`cadence` ("you said Thursdays").

### cli/cos
```
cos brief
cos focus <project>
cos capture "<sentence>"
cos wrap
cos ask "<free-form question>"
```
Thin wrapper over brain/loop. Every other surface (menubar, voice) calls this — no
business logic anywhere but core/ and brain/.

### scheduler
launchd plists that shell out to the CLI: `07:00 -> cos brief`, `18:00 -> cos wrap`,
`daily -> cos silence-check`. This is what makes it "speak first."

### output/render
```
renderBrief(data, target): string   // target: terminal | notification | speech
```
One brief, formatted for whatever surface asks. Must fit one screen.

## Build order (each phase ships something usable)

- **v0 Foundation (the 2-week test):** core/ledger + core/context + `cos brief`, run by
  hand each morning. Goal: prove I'll actually use it before writing more. Kill criteria
  in EPIC.md section 6.
- **v1 It speaks first:** scheduler (launchd) + sensors/calendar + sensors/git. Brief now
  appears unprompted; lastTouched maintained automatically.
- **v2 Surface it:** apps/menubar + notifications + output/render per surface.
- **v3 Jarvis (voice):** io/voice — STT (Whisper/Deepgram/macOS) -> `cos ask` ->
  TTS (macOS `say`/ElevenLabs); optional wake word.
- **v4 Autonomy:** git auto-touch, drafted journal entries for approval, event-driven
  nudges when a calendar event matches a project.

## Stack
TypeScript + Claude Agent SDK for core & CLI · Tauri or Swift for the menubar ·
markdown + git for memory. Python is fine if preferred; keep the contracts identical.

## Definition of done for v0
Running `cos brief` reads selfhub + projects.md + last 7 journal days + today's calendar
and prints a one-screen brief with 1-3 concrete next actions, each citing its reason from
the ledger. `cos capture "..."` creates/updates a ledger entry as a git commit.
