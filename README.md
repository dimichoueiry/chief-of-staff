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
cos calendar --days 14       # your calendar as the assistant sees it
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

- **Double-tap Control** anywhere: the pill appears and listens. (Fn is left alone for Wispr Flow. Control used
  in a shortcut, like ⌃C, never triggers it.) What you say ends after 2.5 seconds of real quiet: the microphone
  level decides, not the recogniser, so thinking pauses mid-sentence don't cut you off. It waits 1.5 s longer
  when you trail off ("and…", "so um"), and a talk can run two minutes. Double-tap again to send right away.
  `cos voice pause 3.5` changes the pause (1 to 10 seconds).
- **Hands-free follow-ups.** After a spoken reply a soft two-note chime plays and the mic opens again on
  its own ("Your turn…"), so you can just keep talking. The chime comes after the last word has played, never
  over it, and a quieter single note marks the start of a spoken reply. It closes after 8 quiet seconds, on Esc, or when you say "thanks" or "that's all"
  (which also hides the pill). Double-tapping Control while it talks cuts it off and listens. Replies to
  typed questions, and "open …" requests, don't reopen the mic.
- **Say its name.** "Darius wake up" (or "hey Darius") opens the pill and listens, after the "your turn" chime.
  "Darius listen" (or "stop", "wait", "hold on") cuts it off mid-reply and listens. "Darius sleep" (or "go to
  sleep", "that's all") stops and closes it. The name alone does nothing, so talking about someone called Darius
  is safe, and misheard versions ("Darias", "Marius") still count. While it waits, speech is recognised on this Mac
  only (it won't run where on-device recognition isn't available), and macOS shows the microphone as in use.
  ✦ › Listen for "Darius" turns it on or off; `cos voice wake on|off`, `cos voice name Nova` changes the name.
- **Move it anywhere.** Drag the bar (or the chat's header) to put the pill wherever it's out of your way; it
  comes back to that spot each time, stays on screen, and follows you to another display. A short press is still
  a click, so the mic and buttons work as before. Double-click the header or the bar's background, or use
  ✦ › Move the chat back to the bottom, to put it back.
- **⌥Space** anywhere: the pill appears for typing.
- **Compact mic.** The ⤡ button at the right of the bar shrinks it to a small, see-through mic (about 85 px
  wide instead of 640) that covers less of the screen; ⤢ opens it back up. It turns solid while it listens,
  thinks or speaks, and the choice is remembered. Typing still works when compact: press ⌥Space and start
  typing, and the full bar opens for that time. By voice: "compact mode" / "full mode".
- **Esc** or clicking elsewhere dismisses it.
- The ✦ menubar icon opens today's brief, focus on a project, the model picker, read aloud, and rebuild.
  If macOS hides the icon beside the notch, press ⌥Space and click the ✦ inside the pill: same menu.

When it opens, it checks five macOS permissions and walks you through any that are off, one at a time:

- **Accessibility**: double-tap Control from any app.
- **Microphone** and **Speech Recognition**: listening, on-device.
- **Screen & System Audio Recording**: "look at this".
- **Full Disk Access**: opening your browser favorites. macOS has no prompt for this one, so setup opens
  the list and shows the app in Finder to drag in.

✦ › **Permissions** shows each with a check; click one that's off to set it up. Saying "open Full Disk
Access" (or "Screen Recording", "Accessibility"…) opens that exact page.

macOS ties these to how the app is signed. `cos menubar build` signs it with a local certificate it makes
once (in `~/.cos/signing`, its own keychain file, not your login keychain), so rebuilds keep every
permission. Only when the signing changes (the first certificate build, or if it ever falls back to ad-hoc)
does the build clear the old switches, and the app asks again when it opens. If a switch is on and the
feature still says it's blocked, remove Chief of Staff from that list with −, add it back with +, and reopen the app.

### It remembers the conversation

The pill is one running conversation, not a series of one-off questions. Ask "what should I do
today?", then "and tomorrow?", "why the second one?" or "ok, save that as the next action": each
message goes to the model with the exchanges before it, including what it looked up, what it
filed, and what it opened (even the instant "open …" requests that never touch a model).

- The thread shows above the pill and is still there when you dismiss it and bring it back.
- While it works, the pill says what it's doing ("Checking your calendar…"); replies show lists, bold and links.
- **▾** in the chat's top-right corner hides the chat so it stops covering your screen (the window shrinks
  to just the pill). **▴ chat** on the pill brings it back; a dot on it means a reply came in while hidden.
  Saying "hide the chat" / "show the chat" works too. Hidden stays hidden across summons; a typed question
  brings it back (you'll want to read the answer), a spoken one doesn't (you'll hear it).
- **＋ new** (or ⌘N) starts a fresh conversation. After two quiet hours the next message starts one on its own
  (`COS_CONVERSATION_IDLE_MINUTES`).
- **chats** (or ⌘Y, or clicking the chat's name) lists every saved chat, most recent first, so you can keep
  different chats for different things. Click one to pick it up where it left off; ✎ renames it. Typing
  filters by name, and Enter searches everything said in every chat. When the card is closed, **▴ chats**
  on the pill opens the list.
- The bin beside ✎ deletes a chat. It asks in the row first (Keep is the default, Esc keeps it). A deleted chat
  leaves the list, the assistant's memory and search at once; deleting the one you're in starts a new chat.
  The file is set aside in `~/.cos/conversations/deleted` for 30 days (move it back to restore it), then removed.
- Chats name themselves: the model gives each a 2–5 word name from its first three messages ("Module 6
  review"). A name you give is never replaced.
- By voice: "new chat", "show my chats", "go back to the module 6 chat", "switch to the chat about
  Campuswire", "go back to the last chat". The name or anything said in the chat counts. If no chat
  matches, it's asked like any other message.
- Picking up an old chat counts as activity, so it doesn't start over right away. Its old summary is
  dropped and rewritten when it ends again.
- Conversations are saved in `~/.cos/conversations`, so restarting the app doesn't lose the thread.
  Only the most recent exchanges that fit a size budget are sent to the model.

### And earlier conversations

When a conversation ends, the model writes a few lines about it: what you talked about, what was
decided, what it filed or opened, and what was left open. Short conversations are kept in their own
words instead, with no model call. Every new message carries the summaries from the last 7 days,
so "what did we decide about pricing yesterday?" just works.

For anything a summary leaves out, or anything older, the model searches every saved conversation
by keywords and dates (`get_conversations`), and quotes what was actually said. When there is more
than fits, it is told how much it isn't seeing, never a silent cut.

```bash
cos conversations                     # the last 7 days, with summaries
cos conversations search tauri        # every saved conversation, any date
cos conversations search --from 2026-09-01 --to 2026-09-07
cos conversations summarize           # summarise ended conversations now (the app does it after each message)
```

"Search …" or "look up …" without "the web", "Google" or "online", and anything that refers back
("the board we talked about yesterday"), goes to the model, which can search memory or the web.

Anything worth keeping for good still goes into selfhub (ledger, reminders, notes) through the tools.

`cos menubar open` relaunches it; `cos menubar uninstall` removes the app and the login item.
Logs live in `~/.cos/logs`.

The app and the scheduler run a copy of the CLI from `~/.cos/app`, not from this repo. macOS
won't let a background process read code in Desktop, Documents or Downloads without a
permission prompt it may never show.

After code changes, `npm run build && npm run cos -- menubar refresh` updates that copy and
restarts the app without rebuilding it, so macOS permissions stay granted. Only Swift changes
need `npm run cos -- menubar build`, and that means going through the permissions again.

Keys are read from `~/.cos/.env` by everything. Edit the project's `.env` if you prefer: it's
copied there whenever it's newer, the next time any `cos` command runs from the project folder
(or right away with `cos env sync`). The running app picks up key changes on its next request.
`cos env` shows which file is used and which providers have a key.

## Voice

With `OPENAI_API_KEY` set, answers are spoken by OpenAI's `gpt-4o-mini-tts` in a natural voice
(`marin` by default) with a calm chief-of-staff delivery. Without it, the Mac voice speaks.
Long answers start playing after the first sentence instead of waiting for the whole text,
and if the OpenAI voice fails mid-answer it finishes with the Mac voice rather than going silent.
Audio plays through a small native player, built once in the background into `~/.cos/bin`: the Mac's `afplay`
waits about a second after every clip, which put dead air between sentences and delayed the chime and mic.

```bash
cos voice                         # what's speaking, and the voice list
cos voice test --voice cedar      # hear a voice without keeping it
cos voice use cedar               # keep it
cos voice style "upbeat and brisk, like a coach"
cos voice speed 1.1
cos voice provider say            # force the Mac voice (auto | openai | say)
cos voice cues turn               # chimes: both (start + your turn), turn, or off
cos voice wake off                # stop waiting for "Darius wake up" (on | off)
cos voice name Nova               # wake to a different name
```

Settings are saved in `~/.cos/voice.json` and apply to the next thing it says, including in the menubar app.
Listening still uses Apple's on-device recogniser; it needs no key.

## Opening things

Say or type "open …" in the pill (or run `cos open …`). These open instantly, with no model needed:

- `open slate`, `open slate board chief of staff ui`, `open the build blueprint board on slate`.
  Board names are looked up through Slate's local bridge and remembered for when no Slate tab is open.
  `cos slate` lists the names it knows.
- Your shortcuts: `open gmail`, `open drawcal repo` (`cos shortcuts add gmail https://mail.google.com`).
  They live in `~/selfhub/links/shortcuts.md`.
- Projects with a `path:` in the ledger: `open drawcal`, or `cos open drawcal --app Cursor`.
- Installed apps (`open calendar`) and searches (`search for tauri menubar`).

It finds project folders itself. Say "track ML gorilla, next step is the module 6 lesson" and it
searches Desktop, Documents, GitHub and the usual code folders for a close name (misspelled or
misheard is fine), picks the git repo that fits, and saves the project with its path in the same
reply. It never asks you to type a path. `cos folders ml gorilla` shows what it would find.

Your browser favorites work too: "open Campuswire from my UIUC favorites" finds it in Edge, Chrome,
Brave or Arc (any profile, misheard names included) and opens it in the browser it's saved in. Reading
Edge, Chrome and Brave needs Full Disk Access, which is part of the app's setup; without it, it says so
and can open that page for you.

Web pages open straight away, including ones the model looks up or builds the address for
(`cos access links ask` makes those wait for an OK). Only http(s) addresses open; files open only
from your home folder, and never scripts or installers. `COS_SLATE_URL` points at a different Slate
address if needed.

## Looking at your screen

Say "look at this", "what am I looking at?", "can you see my screen?" or "what does this say?" and
it takes one screenshot of the display you're on, sends it with your words, and answers about what's
visible. When you point at something without those words ("which button do I press?"), the model can
take one itself (`look_at_screen`). Follow-ups keep working by voice like any other reply.

- The pill and its cards are left out of the capture; it's shrunk to about 1600px.
- Screenshots are never saved: the image goes to the model with that one message and is deleted.
  The conversation only records that you shared your screen.
- Needs a model that takes images (gpt-5.4-mini, Claude Sonnet/Opus via OpenRouter do).
- macOS permission: **Screen & System Audio Recording** for Chief of Staff, part of the app's setup.
  `cos screen` says whether it's on. `cos access screen off` turns looking off.

## Its own browser

The assistant has its own browser, a separate Chrome window with its own profile, for doing things on
websites for you: "what's due this week on Canvas?", "check if my TA replied", "what's on
localhost:3000/modules/M6?". It reads pages as an outline of their text, links, buttons and fields
(through Playwright MCP, no screenshots), clicks and types by voice, and tells you what it found.
Your everyday browser is never touched.

It can scroll what's shown, too: "scroll down", "go to the chorus", or "scroll slowly while I play" (auto-scroll at a reading pace until you say stop). It scrolls the page's main scroller, which on some sites is a panel.

- **Signing in:** the first time a site needs it, sign in yourself in its window. It remembers
  (the profile is `~/.cos/browser/profile`). It never types passwords or codes. Google may refuse
  sign-ins in automated browsers.
- **Sites:** it only reads and acts on sites on its list. The first time it wants a new one, it asks
  ("Should I allow canvas.illinois.edu?"), and a yes covers that site's own domain, so its sign-in
  page works too. If a click leads to a site not on the list, that page's content is withheld from the
  model.
- **What waits for your OK:** clicking anything that sends, submits, buys, posts, deletes or saves, and
  pressing Enter in a field. It asks out loud and says what will be sent; "yeah, send it" works. If
  the page has changed by the time you say yes, nothing happens and it asks again.
- **Page text is information, never instructions.** Hidden text isn't in the outline, and the model is
  told with every page not to follow what pages say. It only acts on elements from the page as it last
  read it.
- Long pages are cut at about 24,000 characters, and it says how much it isn't seeing; it can then
  search the page for words instead.
- The window closes after 30 quiet minutes and opens again when needed. Sign-ins stay.
- Chrome is used if installed, otherwise Edge (`COS_BROWSER=msedge` to choose).

```bash
cos browser                          # the sites it may use
cos browser allow canvas.illinois.edu
cos browser forget canvas.illinois.edu
cos access browser auto              # off | ask (default) | auto: auto also sends and submits on its own
```

## Terminal and coding agents

The assistant can use your terminal and your Agent Grid agents, so "what are the last commits in
ML gorilla?", "install ffmpeg", "do any of my agents need me?" or "have an agent add a quiz to
module 6" all work from the pill.

**Terminal.** Commands run in your login shell (zsh), in a folder, with a timeout. What runs on
its own is decided by rules in the code, not by the model:

| Kind | Examples | In `ask` (default) | In `auto` |
|---|---|---|---|
| Looks or opens | `ls`, `find`, `cat`, `grep`, `git log`, `open -a Cursor ~/x` | runs | runs |
| Changes something | `mkdir`, `brew install`, `npm run build`, `curl`, writing files | waits for your OK | runs |
| Risky | `rm`, `git push --force`, `kill`, reading `.env` or `~/.ssh`, `curl … \| sh` | waits for your OK | waits for your OK |
| Never | `sudo`, erasing disks, deleting your home folder | refused | refused |

When something waits, it asks you out loud ("Should I send this to MLG-MAAC: …?") and the pill shows
the exact command or message with a button. Answer however you like: "yeah, you can send that" and
"no, leave it" are understood directly, and a mixed answer ("yes, but make it shorter") goes to the
model, which may only act on what you said and only before doing anything else. The same thing is
never queued twice or redone moments after it ran. API keys are stripped from the
environment commands see, long output is saved in full under `~/.cos/terminal`, and every command
is logged to `~/.cos/logs/terminal.log`. Long-running things (a dev server) open in a Terminal
window you can watch.

**Agent Grid.** It lists your Claude Code and Codex sessions (who needs you first), reads what an
agent did, starts new agents in a project folder (adding the folder to Agent Grid if it's new), and
messages them. Starting or messaging an agent waits for your OK in `ask` mode. When it needs a
capability it doesn't have, it can have an agent build a small script in `~/cos-tools` and then
run it.

Agent Grid mints a new key every time it starts; it now writes it to `~/.agentgrid/web.json`
(owner-only) so the assistant can connect. Restart Agent Grid once after updating it.

**When an agent finishes, you hear about it.** While the app runs, it listens to Agent Grid's
event stream (`GET /api/events`, no polling); an agent that was working and has settled (done,
failed, needs you, idle, stopped) gets a macOS notification naming it, how it ended and its last
words, a short spoken line ("Refactor auth is done", since you may not be looking), and the same
line goes into the conversation so the assistant knows on your next message
("did the auth refactor finish?"). Each finish is told once: if the stream drops (Agent Grid
restarted, a quiet spell) it reconnects with the last event id it saw and Agent Grid replays what
was missed, nothing twice. Off when `cos access agents off`. `cos agents --follow` prints the
same events in a terminal.

```bash
cos access                    # what it may do on its own
cos access terminal auto      # off | ask | auto
cos access agents ask
cos agents                    # your Agent Grid sessions, as the assistant sees them
```

## Models and providers

The brain is model-agnostic. Add a key for any provider you use, then pick models whenever
you like. Nothing else needs a key: calendar, speech, and memory are all local.

| Provider | Key in `.env` | Model names look like |
|---|---|---|
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | `anthropic:claude-opus-5`, `anthropic:claude-haiku-4-5` |
| OpenAI | `OPENAI_API_KEY` | `openai:gpt-5.4`, `openai:gpt-5.2` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter:anthropic/claude-sonnet-5`, `openrouter:openai/gpt-5.4`, `openrouter:openrouter/auto` (full list at openrouter.ai/models) |
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
| Sensors: calendar via EventKit or icalBuddy for any date range (today plus the next 7 days in memory, any other range on request), git activity → last touched | done, tested (EventKit needs one-time Calendar permission) |
| Brief: rule-based (offline) and model (structured output, lenient fallback) | done, tested; model path needs any provider key |
| Brain: one tool-use loop, prompt templates, write tools | done, tested with a scripted provider |
| Model-agnostic: Anthropic, OpenAI, OpenRouter, OpenAI-compatible; per-intent choice, `cos models`, menubar Model menu | done, adapters tested against recorded shapes; no live call made yet |
| CLI: brief, ask, focus, capture, wrap, silence-check, decide, remind, done, note, projects, calendar, context, init | done |
| Scheduler: launchd agents (07:00 brief, 12:00 silence check, 18:00 wrap nudge) | done; `npm run build && cos scheduler install` |
| UI: the pill + brief panel served locally, browser speech recognition | done; `cos ui` |
| Voice: `say` for speech, whisper.cpp for listening, typed fallback | done; `cos say brief`, `cos talk` |
| Native menubar shell: floating pill, double-tap Control, ⌥Space, native on-device listening | done; `cos menubar install` |
| Conversation memory in the pill: follow-ups, saved threads, live progress, formatted replies | done, tested (scripted model and headless browser) |
| Memory across conversations: summaries of the last 7 days in every request, search over all past conversations, `cos conversations` | done, tested; verified live on OpenRouter |
| Terminal (rules-based permissions, confirm by button or "yes") and Agent Grid agents (list, read, start, message) | done, tested; verified live with a second Agent Grid instance |
| Its own browser (Playwright MCP, separate profile, site list, spoken OK before sending) | done, tested; checked end to end with headless Chrome on a local page, not yet on a real site |
| Wake word, phone notifications, autonomy epic | not yet |
