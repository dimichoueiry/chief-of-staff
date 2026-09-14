# Chief of Staff

A chief of staff for one person. It remembers every commitment you have made to
yourself, and every morning it tells you what matters today, before you ask.

Not a chatbot. Not a to-do app. Not a calendar. Those are inputs. The product is
the memory plus the initiative: it knows, and it speaks first.

> "It's Thursday. You told me Thursdays are for MLGuerrilla. You haven't touched it
> in 12 days. Last time you said the next step was recording the intro video. You
> have a free block 2 to 4 pm. Want to do it then?"

## How it works

Three memory stores, all plain markdown in a local git repo you own (`~/selfhub`):

| Store | Holds | File |
|---|---|---|
| Identity | who you are, how you work, how you write | the existing selfhub files |
| Commitments ledger | every project: why, status, cadence, next action, last touched | `goals/projects.md` |
| Journal | two lines a day: what happened, what's next | `journal/YYYY-MM-DD.md` |

One Claude tool-use loop reads those stores plus your calendar and git activity,
and answers through a small set of intents. The "specialists" are prompt templates,
not services. Every write to memory is a git commit, so you can see and undo
anything it did.

Full rationale: [`docs/EPIC.md`](docs/EPIC.md). Modules and contracts:
[`docs/BUILD.md`](docs/BUILD.md). Execution plan: [`docs/BACKLOG.md`](docs/BACKLOG.md).
Interface design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Quick start

```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY
npm run cos -- init         # scaffold the ledger + journal in ~/selfhub (asks first)
npm run cos -- brief        # the morning brief
```

Everyday commands:

```bash
cos brief                    # today: 1-3 next actions, calendar, nudges
cos ask "what should I do today?"
cos focus drawcal            # top 3 highest-leverage moves for one project
cos capture "starting a project: fampy academy course"
cos wrap                     # end-of-day two-line journal
cos silence-check            # projects untouched 14+ days: keep / park / kill
cos ui                       # the pill + brief in a local window
cos say brief                # read the brief aloud
```

Install the morning trigger so it speaks first:

```bash
cos scheduler install        # launchd: 07:00 brief, 18:00 wrap, daily silence check
```

## Configuration

Everything is an environment variable (see `.env.example`):

- `ANTHROPIC_API_KEY` — required for model calls
- `COS_SELFHUB` — memory repo path, default `~/selfhub`
- `COS_MODEL` — default `claude-opus-5`
- `COS_PROJECT_ROOTS` — folders scanned for git activity, default `~/Desktop`
- `COS_NAME` — your first name for greetings

## Layout

```
src/
  core/       ledger, journal, notes, reminders, git, context   (the memory contract)
  sensors/    calendar (read-only, via macOS), git activity
  brain/      the single Claude tool-use loop, tools, prompt templates
  logic/      cadence, resurfacing, day plan (pure functions, fully tested)
  output/     render a brief for terminal | notification | speech
  cli/        cos
  scheduler/  launchd plists + installer
  ui/         the pill + brief web UI
  voice/      text-to-speech, speech-to-text adapters
tests/        vitest
examples/     a sample selfhub for demos and tests
```

## Principles

- Build what only you feed (ledger, journal, reminders). Read what the world feeds
  (calendar, email) through the OS, one source for all providers.
- No database, no vector store, no queue. Markdown and git.
- One loop, many prompts. Not many agents.
- Every memory write is a commit.

## Status

| Piece | State |
|---|---|
| Memory contract: ledger, journal, reminders, notes, git-commit-on-write | done, tested |
| Context assembler with cadence / silence / parked-review flags | done, tested |
| Sensors: calendar via EventKit or icalBuddy, git activity → last touched | done, tested (EventKit needs one-time Calendar permission) |
| Brief: rule-based (offline) and model (structured output) | done, tested; model path needs `ANTHROPIC_API_KEY` |
| Brain: one tool-use loop, prompt templates, write tools | done, tested with a scripted model |
| CLI: brief, ask, focus, capture, wrap, silence-check, decide, remind, done, note, projects, calendar, context, init | done |
| Scheduler: launchd agents (07:00 brief, 12:00 silence check, 18:00 wrap nudge) | done; `npm run build && cos scheduler install` |
| UI: the pill + brief panel served locally, browser speech recognition | done; `cos ui` |
| Voice: `say` for speech, whisper.cpp for listening, typed fallback | done; `cos say brief`, `cos talk` |
| Native menubar shell, Fn double-tap system-wide, wake word | not yet: the web page is built to be hosted by a Tauri or Swift shell |
