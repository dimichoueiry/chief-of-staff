# Chief of Staff

A chief of staff for one person. It remembers every commitment you have made to
yourself, and every morning it tells you what matters today, before you ask.

Not a chatbot. Not a to-do app. Not a calendar. Those are inputs. The product is
the memory plus the initiative: it knows, and it speaks first.

> "It's Thursday. You told me Thursdays are for MLGuerrilla. You haven't touched it
> in 12 days. Last time you said the next step was recording the intro video. You
> have a free block 2 to 4 pm. Want to do it then?"

**Got the app as a `.dmg`?** Follow [`docs/INSTALL.md`](docs/INSTALL.md): install, first launch,
permissions, your API key, and removal. No Terminal needed. The rest of this README is the developer setup.

## How it works

Three memory stores, all plain markdown in a local git repo you own (`~/selfhub`, made for you
the first time the app runs):

| Store | Holds | File |
|---|---|---|
| Identity | who you are, how you work, how you write | the existing selfhub files |
| Commitments ledger | every project: why, status, cadence, next action, last touched | `goals/projects.md` |
| Journal | two lines a day: what happened, what's next | `journal/YYYY-MM-DD.md` |

Identity is every markdown file in selfhub that isn't one of the stores, and all of it is in the
prompt on every message, so it has a size budget (`COS_IDENTITY_CHARS`, 32,000 characters by
default). The short files — profile, preferences, voice — always fit and are always there; the files
a question is about are loaded on top of them; and anything left over is named in the prompt, with
its size, so the assistant tells you it doesn't have a file instead of guessing at it. Nothing is
ever cut in the middle. `cos context --about "…"` prints exactly what a message would carry, and its
size. Keeping a long working document inside selfhub is what the budget is for: without one, it
never comes up.

One tool-use loop, running on whichever model you choose, reads those stores plus your calendar and git activity,
and answers through a small set of intents. The "specialists" are prompt templates,
not services. Every write to memory is a git commit, so you can see and undo
anything it did. On a Mac without Apple's command line developer tools there is no git, so the
memory is written and the history waits: ✦ › Memory says so and offers to install them.

Full rationale: [`docs/EPIC.md`](docs/EPIC.md). Modules and contracts:
[`docs/BUILD.md`](docs/BUILD.md). Execution plan: [`docs/BACKLOG.md`](docs/BACKLOG.md).
Interface design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Quick start

Needs Node 22.12 or newer (commander and vitest require it) and macOS for the
scheduler, calendar and menubar app.

```bash
npm install
cp .env.example .env        # add a key: Anthropic, OpenAI or OpenRouter
npm run cos -- doctor       # what's ready and what to fix; keys shown by name only
npm run cos -- init         # scaffold the ledger + journal in ~/selfhub (asks first)
npm run cos -- brief        # the morning brief
```

`cos doctor` checks Node, the install and build, `~/.cos`, model keys, the
memory repo, the launchd jobs, the calendar reader and the browser. It exits 1
when something must be fixed; warnings alone exit 0.

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

## It writes first: the heartbeat

While the app (or `cos ui`) runs, it looks every half hour at what's coming up in the next two days
(reminders, now with a time: "2026-09-23 09:00 · Module 2 posts go out"; calendar events; project
cadence days) and at what you said in recent chats. When it can do real work on something before
you ask, it writes to you: a message in the chat, like *"Want Wednesday's Module 2 post tuned for
shares and saves?"* with **Yes, do it** / **Not now**, and a notification that opens that chat. A
yes does the work and hands back a document in the chat. Most looks end in silence, and cost no
model call unless something changed.

- **✦ › Proactive** switches it: **Off**, **Proactive** (offers, waits for your yes) or **Proactive+**
  (anything that only needs a document or page written, it does first and shows you; anything that
  would send, post, schedule or change your memory still waits for a yes). Or `cos heartbeat off|proactive|plus`.
- It never speaks aloud unasked, writes at most 3 times a day, 90 minutes apart, not between 22:00
  and 08:00 (`COS_QUIET_HOURS`, e.g. `23-7` or `off`), and never offers the same thing twice.
- Your standing rules for it go in `selfhub/goals/heartbeat.md` ("nothing about drawcal until October").
- Why it spoke, or didn't: `~/.cos/heartbeat.md`, or ✦ › Proactive › What it's been doing…
- `cos heartbeat now` (or ✦ › Proactive › Look now) looks right away.
- **Activity** (the chip in the chat's header, or ✦ › Activity…) shows what it's running for you: the
  heartbeat and its mode, your reminders (tick one off there), your projects' rhythm, and every action
  that waited for your OK, how you answered, and what your settings let it do on its own.
- **The dashboard** (✦ › Open Chief of Staff, ⌘O in the menu) is a full window: **Chat** (the same
  conversation as the pill, with your chats down the side, dictation, and everything a reply carries:
  offers, answer buttons, documents, approvals), Activity, Goals, Memory, Artifacts and Soul.
- **Goals & memory** (✦ › Goals & memory…, or the link on the Activity page): your projects as goals
  (tick one done, park it, change its next action in place), and your memory as files to open and
  edit: **Soul** (your instructions for how it behaves), the heartbeat's rules, who you are, the
  stores and the journal. Every save is a commit; a file the assistant changed since you opened it
  isn't overwritten.
- When a reply ends on a question with a few obvious answers, they appear under it as buttons; tapping
  one sends it as your reply.

## The desktop app

A native menubar app hosts the pill. It runs entirely on your Mac.

```bash
npm run build
npm run cos -- menubar install   # builds ~/Applications/Chief of Staff.app, opens it, starts at login
npm run package                  # a self-contained .app + .dmg to hand to someone: docs/DISTRIBUTION.md
```

- **Hold Control** anywhere: push-to-talk. The pill appears after a brief hold, listens while
  you hold it, and sends when you release. A short double-tap still opens a normal listen.
  When the pill is already open, a short Control tap starts listening and the next tap stops it.
  (Fn is left alone for Wispr Flow. Control used in a shortcut, like ⌃C, never triggers it.)
  What you say ends after 2.5 seconds of real quiet: the microphone level decides, not the recogniser,
  so thinking pauses mid-sentence don't cut you off. It waits 1.5 s longer when you trail off
  ("and…", "so um"), and a talk can run two minutes. `cos voice pause 3.5` changes the pause (1 to 10 seconds).
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
- **Say its name to give an order.** "Darius, start a new chat" (or "Darius, new chat") starts one without
  touching the ＋ new button; it says "New chat" and listens. The name in front is what makes it a command:
  the same words without it still work as before, and anything else said to Darius by name is asked as usual.
  Mishearings of the name ("Darias", "Marius", "dare us") count, as with the wake phrase.
- **"Darius, by the way…"** steps out for a quick unrelated exchange without losing your place. Ask in the
  same breath ("Darius, by the way, how tall is the Eiffel Tower?") or on its own (it says "Go ahead" and
  listens). "Darius, quick question", "side note" and "off topic" do the same. The header reads **Aside** while
  it lasts; what's said there is answered on its own, and the chat you were in doesn't see any of it.
  "Darius, back on topic" (or "back to what we were saying", "where were we?") picks the chat up where it was
  and throws the aside away: it isn't listed, remembered or searched. Inside an aside the name is optional for
  the way back. A new chat or switching chats also ends it. If it's asleep, "Darius wake up" first, as always.
- Picking up an old chat counts as activity, so it doesn't start over right away. Its old summary is
  dropped and rewritten when it ends again.
- Conversations are saved in `~/.cos/conversations`, so restarting the app doesn't lose the thread.
  Only the most recent exchanges that fit a size budget are sent to the model.
- What each chat is *about* — its name, its summary, how many messages — is kept in a small index
  (`~/.cos/conversations/.index`) beside them, so listing your chats and remembering earlier ones
  costs one small read and not a pass over everything you have ever said. It is only a cache: delete
  it and it rebuilds itself on the next message.

### And earlier conversations

When a conversation ends, the model writes a few lines about it: what you talked about, what was
decided, what it filed or opened, and what was left open. Short conversations are kept in their own
words instead, with no model call. Every new message carries the summaries from the last 7 days,
so "what did we decide about pricing yesterday?" just works.

Those summaries come from the index, so a message costs the same whether ten conversations were
saved before it or a thousand.

For anything a summary leaves out, or anything older, the model searches every saved conversation
by keywords and dates (`get_conversations`), and quotes what was actually said. That search, and
only that search, reads the conversations themselves — and only the ones the dates leave in. When
there is more than fits, it is told how much it isn't seeing, never a silent cut.

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

Keys are read from `~/.cos/.env` by everything. Two ways in:

- **✦ › API keys** in the menubar app: a field per provider, checked with one live request as
  you save, written to `~/.cos/.env` owner-only. The only way someone you handed the app to can
  do it, since they have no repo and no Terminal.
- **The file**, or the project's `.env`: copied there whenever it's newer, the next time any
  `cos` command runs from the project folder (or right away with `cos env sync`).

Either way the running app picks up the change on its next request, no restart. `cos env` shows
which file is used and which providers have a key.

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

With `TYPESAFE_API_KEY` set, anything the rules don't catch goes to Jev, TypeSafe's "System One"
model, before the language model. Jev doesn't write; it picks from a list in about a tenth of a
second. So "Darius, open the browser for me", "get Cursor up" or "take me to my email" open your
default browser, an app, a shortcut, a project folder, Slate or a privacy settings page without a
model call. Anything else (a question, a note, an agent to start, "open it", "open X and search
for Y") goes to the model as before and is answered out loud. It only acts when it's sure: below
80% that you only want something opened, or 75% on which thing, the model decides. A slow or
failing Jev falls back to the model after 1.5 s. The server log says what Jev did or why it passed.

The desktop pill's **Live** toggle keeps the microphone open for successive Jev commands.
Say “open Cursor”, pause briefly, then “open Slate”: it checks each stable phrase after about
0.7 seconds of quiet, plus the Jev request time, without stopping the microphone between commands.
This first version handles the same apps, saved sites, folders and settings as the fast lane;
questions, ambiguous phrases and multi-step requests show a hint to use normal mic mode.
Results appear silently in the chat, so the microphone does not hear spoken replies.
Live requires `TYPESAFE_API_KEY` and starts off each time. Click Live or the mic, press Escape,
double-tap Control, or say “stop listening” to stop. It also ends after 30 minutes.
Stopping cancels queued commands and ignores late decisions; repeated delivery of a phrase cannot
execute it twice. An action already dispatched to macOS cannot be undone by stopping.

Live changes the native speech listener, so installing this version requires
`npm run build && npm run cos -- menubar build`, then restarting the app. A server-only refresh
is not enough. Plain-browser mic mode is unchanged; Live is available in the desktop app.

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
- **Putting a picture on a site:** it clicks what adds a photo and answers the file chooser that opens
  with a picture or page it made, or a file of yours under your home folder — nothing else on the disk.
  Attaching is not posting: whatever publishes it still waits for your OK.
- **When a page stops answering** something is in front of it: it answers the browser's own "Are you
  sure?" box, presses Escape on an overlay with no close, and looks in the other windows for what a
  click opened somewhere else. Enter waits for your OK, because Enter sends.
- **Uploading a file yourself in its window doesn't work.** Playwright holds back every file chooser
  in the window it drives, so the Mac's picker never opens. Tell it instead: "attach
  ~/Downloads/clip.mp4". A chooser you opened by hand is closed the next time it uploads.
- **Asking first** is set per kind on the Activity page (Approvals → Asking first): Off, Ask or
  Don't Ask, for its browser, commands, agents and web pages. "Stop asking me" works by voice and
  needs one tap; "ask me again" applies at once.
- The window closes after 30 quiet minutes and opens again when needed. Sign-ins stay.
- Chrome is used if installed, otherwise Edge (`COS_BROWSER=msedge` to choose).

With `TYPESAFE_API_KEY` set, Jev does the clicking, not the language model. A page cannot be opened
without saying what it is for, and saying it starts Jev working towards that goal: it picks the next
element from what the page offers, a step at a time, for a fraction of the cost of asking the model
each time. The page is read fresh at every step, so it never works from a stale picture of it.

The model does not choose whether to use it. It says what it wants done and gets the result; the
clicking only comes back to it when Jev hands the page over.

It only picks, so any text to type comes from the model with the goal. It hands the page straight
back the moment it isn't sure what to do next, when nothing on the page fits, when it would need to
make text up, or after fifteen steps. Everything that waits for your OK still waits for it, and a
page read earlier in the same run is dropped from what the model is sent, since only the newest one
is still true.

```bash
cos browser                          # the sites it may use
cos browser allow canvas.illinois.edu
cos browser forget canvas.illinois.edu
cos access browser auto              # off | ask (default) | auto: auto also sends and submits on its own
```

## Seeing what it did

Every time you say something, what it did with it is written to `~/.cos/traces/YYYY-MM-DD.jsonl`:
one line per turn, holding what you said, every step on the way and how long each took.

```bash
cos trace                            # the last 5 turns, step by step
cos trace 20                         # more of them
cos trace --json | jq                # the raw lines
```

```
20:22:53  "open the article about Microsoft"  3990ms
       0ms  tool    browser_open {"url":"https://en.wikipedia.org/wiki/Playwright_(software)"}
    1887ms  browser step 1: link "Microsoft"  p=0.46 runnerUp=0.19 done=0.03 of=192 ms=399
    3990ms  browser step 2: none  p=0.62 runnerUp=0.11 done=0.57 of=251 ms=191
    3990ms  reply   handover: clicked link "Microsoft"  kind=handover
```

A step says who took it: `jev` for the fast lane, `model` for a turn of the language model, `tool`
and `result` for what it ran, `browser` for a step of the page loop (with the numbers its thresholds
are judged on), `reply` for what you got back, and `error` when a turn threw.

`COS_TRACE=off` turns it off. Deleting the traces directory is safe at any time, and `src/util/trace.ts`
says at the top exactly what to delete to take the whole thing back out.

## Making things: pictures and pages

Ask for something to look at and it appears on your screen, instead of a description of itself.

- **Pictures** (`make_image`): "make me an Instagram post for the launch", "a thumbnail for the
  module 6 video", "a logo idea for drawcal". Say the shape and it uses it — 1:1 feed,
  4:5 Instagram portrait, 9:16 story, 16:9 thumbnail, 1.91:1 LinkedIn link.
- **Changing one**: "make the words bigger", "same but at night". The picture you are looking at
  goes back with the change, so it keeps what was already right.
- **Pages** (`make_page`): the assistant writes the HTML itself — a post exactly as it would look in
  a feed, a landing page, a content calendar, a mock-up, a table of options. A page opens full size
  as soon as it exists; a picture appears in the reply and opens when you click it.

Each one gets a window of its own with **save…** and **copy**, and is kept in `~/.cos/artifacts`.
They stay with the conversation, so reopening a chat shows them again, and ✦ › **Artifacts…** is
all of them at once: newest first, filtered by pages or pictures, each one to open, save or delete.
They are drafts, not memory: nothing reaches selfhub unless you ask for it.

Pictures are drawn through OpenRouter, so any image model there can draw them. The default is
`google/gemini-3.1-flash-image` (Nano Banana 2): quick, cheap, and the one that gets words inside a
picture right. Change it in ✦ › Model › **Images**, which lists a few worth having and takes any
other OpenRouter image model by name, or set `COS_IMAGE_MODEL` in `.env` — the full list is at
openrouter.ai/models?output_modalities=image.

- Each picture costs money on your OpenRouter account, and is drawn without asking first, like any
  other tool it can use. A page costs nothing beyond the reply that wrote it.
- A page is served with an origin of its own (`Content-Security-Policy: sandbox`), so HTML written
  from something read on the web can't turn around and call this app's own API.

## Your own instructions

✦ › **My instructions…** opens a box for what you want done differently, in every conversation:
what to call you, how long replies should be, your voice for posts, the shape your images take.

It is added to what the assistant already knows, and it wins where the two disagree — the default is
shown underneath, so you can see what you are adding to. Delete the text and the default stands on
its own again. One file, `~/.cos/instructions.md`, and it applies to your next message.

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

**On the model you name.** "Start an agent on Opus 5 to review the export code" starts Claude
Code on `claude-opus-5`; "use gpt 5.5" starts Codex, since the model decides the engine. Say it any
way: "Claude Opus 5", "opus 4.8", "the latest sonnet" (the `sonnet` alias), an exact ID. Names are
matched against the models Agent Grid lists (the ones this Mac has used, plus the aliases), and
the model is in the confirmation before anything starts. A name that fits several ("opus 4") gets
a question back; a Claude model asked of Codex is refused. An exact ID it hasn't seen goes through
as given, and if the CLI doesn't know it, Agent Grid says so instead of starting a session that
does nothing. Name no model and each CLI uses its own default. "Which models can agents use?"
lists them; `cos agents` shows the model each session runs on.

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

### Work areas and tickets

Agent Grid groups agents into **work areas** (Engineering, Marketing, …) and keeps a shared **ticket
board**. The assistant sees both, and joins them the way you think about them: an area, the agents
running in it, and the ticket each one holds.

- "What's engineering doing?" — the areas, who's running, who needs you, what they hold.
- "What's in review?", "what's unassigned in drawcal?", "show me DC-12" — the board, filtered, or
  one ticket in full with its history.
- "File a bug: the Safari export is broken, urgent, for the drawcal project" — a new ticket.
- "Move DC-12 to review", "give it to the exporter agent and start it", "comment that the fix
  landed", "delete DC-9" — every change to a ticket.
- "Start an agent in Engineering on DC-12" — Agent Grid hands it the ticket as its brief.

Changes follow the same rule as starting or messaging an agent (`cos access agents`): in the default
**ask** mode you get a one-line confirmation first; in **auto** it just does it. Deleting a ticket
always asks, because Agent Grid can't undo one. Giving a ticket to a running agent also tells that
agent, in its own chat.

The **✦ › Agent Grid** menu shows the same thing at a glance: each work area opens to its agents,
the title says when any need you, the board is summarised in a line with what's in review, and
**New ticket…** files one in a sentence.

### Orchestrators

Agent Grid also has **orchestrators**: standing agents (an OpenRouter model with its own tool menu)
that start real Claude Code / Codex agents toward a goal on their own, rather than you starting each
one — "the Product Manager orchestrator", say, working through a backlog. An orchestrator is set up
(its name, OpenRouter model, instructions, and how many agents/dollars/steps it may spend) in Agent
Grid's own UI, since that needs an OpenRouter connection; from here, the assistant only starts, stops,
messages and approves ones that already exist.

- "How are my orchestrators doing?", "is the Product Manager waiting on me?" — `get_orchestrators`,
  read-only: status, what it's started, its last words.
- "Start the Product Manager on clearing the backlog" — `start_orchestrator`, with the goal in full.
- "Stop it", "tell the release captain to also check staging" — `stop_orchestrator`,
  `message_orchestrator`.
- "Needs you" means one of two things, and `get_orchestrators` with its name says which: an orchestrator
  in its default **ask** mode pauses before each tool call (starting an agent, filing a ticket) and
  waits for your OK, or it's simply said something in plain text and is waiting for a reply, the same
  as a chat. The first shows a line saying exactly what it wants to do; answer it with
  `respond_orchestrator_approval`. Without that line, it just asked something — read its last words
  and reply with `message_orchestrator`. **Approving or declining always asks you first**, in a
  plain-language question, whatever `cos access agents` is set to: it's the one point where an
  orchestrator's own next move, not a step you asked for, is about to run and may itself start several
  more agents and spend real money.

Starting, stopping and messaging follow `cos access agents` like everything else in Agent Grid: a
one-line confirmation in **ask** mode, straight through in **auto**. `cos orchestrators` lists them
from the terminal (read-only, no confirmation needed) — handy for a quick check without going through
the assistant at all.

```bash
cos orchestrators              # every orchestrator and its status
```

## Connections

The other tools you use, added from **✦ › Connections** rather than written into the app. A
connection is an MCP server: a command on this Mac, or an address someone hosts.

- **Add one** from the pull-down of named services, or "Something else…" for your own, by command
  (`npx -y some-server`) or address (`https://mcp.example.com/mcp`).
- **It is checked as you save**, and the row says what came back: how many tools, from which
  server, how long it took, or what to try next.
- **Secrets stay in the keys file.** A connection names the variables it needs; the values live in
  `~/.cos/.env` with the API keys, and a server is handed only the ones it named.
- **Turn one off** and it costs nothing. **Remove** it and its token stays, so adding it back is quick.
- A connection is somebody else's program running with your access. The window says so.

Not wired into the assistant's tool loop yet: it can be added and checked, and the window is honest
about the difference. See E8 in [`docs/BACKLOG.md`](docs/BACKLOG.md); the open question is how many
tools can be in front of the model at once before it gets worse rather than better.

## Models and providers

The brain is model-agnostic. Add a key for any provider you use (✦ › API keys, or the file),
then pick models whenever you like. Nothing else needs a key: calendar, speech, and memory are
all local.

| Provider | Key in `.env` | Model names look like |
|---|---|---|
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | `anthropic:claude-opus-5`, `anthropic:claude-haiku-4-5` |
| OpenAI | `OPENAI_API_KEY` | `openai:gpt-5.4`, `openai:gpt-5.2` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter:anthropic/claude-sonnet-5`, `openrouter:openai/gpt-5.4`, `openrouter:openrouter/auto` (full list at openrouter.ai/models) |
| Any OpenAI-compatible server (Ollama, LM Studio, …) | `COS_COMPATIBLE_BASE_URL` | `compatible:llama3.2` |

Pictures are their own choice, and only OpenRouter draws them: see
[Making things](#making-things-pictures-and-pages).

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
- `COS_IMAGE_MODEL` — the OpenRouter model that draws, default `google/gemini-3.1-flash-image`
- `COS_EFFORT` — `low`, `medium` (default) or `high` reasoning depth, where the model supports it
- `COS_PROJECT_ROOTS` — folders scanned for git activity, default `~/Desktop`
- `COS_NAME` — your first name for greetings
- `COS_IDENTITY_CHARS` — how much of selfhub goes into every message, default `32000` (~8k tokens)

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
| Agent Grid orchestrators (list/status, start, stop, message, approve/decline) | done, tested; read path verified live against a running Agent Grid; write path unit-tested (mocked server) only — see COS2-10 |
| Its own browser (Playwright MCP, separate profile, site list, spoken OK before sending) | done, tested; checked end to end with headless Chrome on a local page, not yet on a real site |
| Wake word, phone notifications, autonomy epic | not yet |
