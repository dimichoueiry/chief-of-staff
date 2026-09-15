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

One tool-use loop, running on whichever model you choose, reads those stores plus your calendar and git activity,
and answers through a small set of intents. The "specialists" are prompt templates,
not services. Every write to memory is a git commit, so you can see and undo
anything it did.

Full rationale: [`docs/EPIC.md`](docs/EPIC.md). Modules and contracts:
[`docs/BUILD.md`](docs/BUILD.md). Execution plan: [`docs/BACKLOG.md`](docs/BACKLOG.md).
Interface design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Quick start

```bash
npm install
cp .env.example .env        # add a key: Anthropic, OpenAI or OpenRouter
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

## The desktop app

A native menubar app hosts the pill. It runs entirely on your Mac.

```bash
npm run build
npm run cos -- menubar install   # builds ~/Applications/Chief of Staff.app, opens it, starts at login
```

- **Double-tap Fn** anywhere: the pill appears and listens. Double-tap again when you're done talking.
- **⌥Space** anywhere: the pill appears for typing.
- **Esc** or clicking elsewhere dismisses it.
- The ✦ menubar icon opens today's brief, focus on a project, the model picker, read aloud, and rebuild.
  If macOS hides the icon beside the notch, press ⌥Space and click the ✦ inside the pill: same menu.

First run asks for three permissions: Accessibility (to see the Fn key), Microphone and
Speech Recognition (to listen, on-device). If double-tapping Fn also opens the emoji picker
or dictation, set System Settings › Keyboard › "Press 🌐 key to" to "Do Nothing".
Rebuilding the app changes its signature, so macOS may ask for these again.

`cos menubar open` relaunches it; `cos menubar uninstall` removes the app and the login item.
Logs live in `~/.cos/logs`.

The app and the scheduler run a copy of the CLI from `~/.cos/app`, not from this repo. macOS
won't let a background process read code in Desktop, Documents or Downloads without a
permission prompt it may never show. After changing code, run
`npm run build && npm run cos -- menubar build` to refresh the copy.

Keys for the app and the scheduler live in `~/.cos/.env`. Each build copies this repo's
`.env` there when the repo's copy is newer, or you can edit `~/.cos/.env` directly.

## Models and providers

The brain is model-agnostic. Add a key for any provider you use, then pick models whenever
you like. Nothing else needs a key: calendar, speech, and memory are all local.

| Provider | Key in `.env` | Model names look like |
|---|---|---|
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | `anthropic:claude-opus-5`, `anthropic:claude-haiku-4-5` |
| OpenAI | `OPENAI_API_KEY` | `openai:gpt-5.4`, `openai:gpt-5.2` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter:openai/gpt-5.2`, `openrouter:~anthropic/claude-sonnet-latest`, `openrouter:openrouter/auto` |
| Any OpenAI-compatible server (Ollama, LM Studio, …) | `COS_COMPATIBLE_BASE_URL` | `compatible:llama3.2` |

Pick a model three ways:

```bash
cos models                                         # what's configured and what each intent uses
cos models use openai:gpt-5.4                      # default for everything (saved)
cos models use anthropic:claude-haiku-4-5 --for capture   # a cheap model just for filing notes
cos --model openrouter:openai/gpt-5.2 ask "what should I do today?"   # one command only
cos models test openrouter:openrouter/auto         # check a key and model name work
```

The menubar's **Model** menu switches the default with one click; it applies to the next request.

Which model runs, highest priority first: the `--model` flag, a per-intent choice, the saved
default, `COS_MODEL` in `.env`, then the first provider that has a key. Choices are saved in
`~/.cos/models.json`; add your own entries under `"presets"` to show them in the menu.

Without any key, the rule-based brief, decisions, reminders and simple capture still work.
If a model fails while building the brief, you get the rule-based brief with the reason.

## Configuration

Everything is an environment variable (see `.env.example`):

- one or more provider keys — see Models and providers
- `COS_SELFHUB` — memory repo path, default `~/selfhub`
- `COS_MODEL` — fallback model as `provider:model`; `cos models use` overrides it
- `COS_EFFORT` — `low`, `medium` (default) or `high` reasoning depth, where the model supports it
- `COS_PROJECT_ROOTS` — folders scanned for git activity, default `~/Desktop`
- `COS_NAME` — your first name for greetings

## Layout

```
src/
  core/       ledger, journal, notes, reminders, git, context   (the memory contract)
  sensors/    calendar (read-only, via macOS), git activity
  brain/      the tool-use loop, tools, prompt templates, and llm/ provider adapters
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
| Brief: rule-based (offline) and model (structured output, lenient fallback) | done, tested; model path needs any provider key |
| Brain: one tool-use loop, prompt templates, write tools | done, tested with a scripted provider |
| Model-agnostic: Anthropic, OpenAI, OpenRouter, OpenAI-compatible; per-intent choice, `cos models`, menubar Model menu | done, adapters tested against recorded shapes; no live call made yet |
| CLI: brief, ask, focus, capture, wrap, silence-check, decide, remind, done, note, projects, calendar, context, init | done |
| Scheduler: launchd agents (07:00 brief, 12:00 silence check, 18:00 wrap nudge) | done; `npm run build && cos scheduler install` |
| UI: the pill + brief panel served locally, browser speech recognition | done; `cos ui` |
| Voice: `say` for speech, whisper.cpp for listening, typed fallback | done; `cos say brief`, `cos talk` |
| Native menubar shell: floating pill, double-tap Fn, ⌥Space, native on-device listening | done; `cos menubar install` |
| Wake word, phone notifications, autonomy epic | not yet |
