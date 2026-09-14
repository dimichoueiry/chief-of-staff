# Interface design

The assistant is voice-first and lives on the desktop. One entry point in every
state: a pill at the bottom-centre of the screen, summoned from any app by
double-tapping Fn. Everything else (the brief, capture, decisions) opens from it.

## Visual language

Dark glass surfaces, warm amber accent, off-white text. Tokens used by every surface:

| Token | Value | Use |
|---|---|---|
| surface | `#1E2129` | pill, cards |
| surface-raised | `#22262F` | focus cards, chips |
| surface-active | `#241F1A` | pill while listening |
| line | `#333845` | borders |
| text | `#ECEEF2` | primary |
| text-muted | `#8E94A0` | secondary |
| accent | `#E8A85C` | amber: active state, section labels, free blocks |
| attention | `#E0794F` | coral: first focus item, decisions, overdue |
| success | `#6FC79A` | green: speaking state, keep, done |
| rose | `#E091A8` | reminders |

## The pill and its four states

| State | Look | Trigger |
|---|---|---|
| Idle | quiet dark pill, muted mic, "Ask anything…", `fn fn` chip | default |
| Listening | amber glow, live waveform, words appear as you speak, red dot | double-tap Fn |
| Thinking | soft shimmer, three dots | after you stop speaking |
| Speaking | green waveform, "Reading it to you…", stop control | answer ready |

Esc or a tap anywhere dismisses. The pill floats above every app; you never switch windows.

## Surfaces

1. **Morning brief panel** (the money screen). Greeting and date. *Today's focus*:
   1–3 cards, each a concrete next action with a project, a reason from the ledger
   and a size chip. *Schedule*: today's events with free blocks highlighted and the
   planned item written into them. *Needs a decision*: stale projects with
   Keep / Park / Kill buttons. Reminders. A follow-up input at the bottom.
2. **Voice flow**. Double-tap Fn → speak → the transcript appears above the pill →
   the answer is spoken and shown as a card with actions ("Add to today").
3. **Capture**. Type into the pill instead of talking; the Scribe files the
   sentence and confirms where it went.
4. **Menubar menu**. Today's brief, Focus a project, Capture…, Reminders (badge),
   a three-line preview of today, Settings.

## How the code maps to it

- `cos ui` serves a local page that renders the pill and the brief panel from
  `~/.cos/last-brief.json` (written by the morning job) or a fresh brief, and posts
  decisions and captures back to the CLI. It is the same markup a Tauri or Swift
  shell would host later.
- `output/render.ts` is the single source for what a brief looks like on any surface:
  terminal, markdown, spoken, notification.
- `voice/tts.ts` speaks with macOS `say`; `voice/stt.ts` transcribes with whisper.cpp
  when installed, otherwise `cos talk` falls back to typing.
- `scheduler/launchd.ts` makes it speak first: the morning brief lands as a
  notification and is cached for the UI before you open anything.

Not built yet, by design: a native menubar shell, a wake word, phone notifications.
Each has a revisit trigger in `EPIC.md`.
