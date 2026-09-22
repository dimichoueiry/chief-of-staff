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
Sprint 6:  E7                     -> ships v5 (someone else can install it)
Sprint 7:  E8                     -> connections (only after E7; decide the scope change first)
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

## EPIC 7 — Give it to someone else (v5): the installer holds up   [L]

Goal: a friend double-clicks a .dmg and has a working assistant; a customer sees no warning.
Dependencies: the packager and the keys/memory windows (done, `docs/DISTRIBUTION.md`).
Everything below was found by auditing the built bundle on 2026-09-15, not guessed.

User stories
- US7.1 A friend on any recent Mac gets an app whose calendar, screen and voice all work.
- US7.2 It is running tomorrow morning without being reopened, and it speaks first.
- US7.3 When something is wrong, the app says something true about *their* machine.
- US7.4 They can remove it as easily as they installed it.

Tasks — correctness (do these first; each is small and self-contained)
Done 2026-09-15: T7.1-T7.8 and T7.11. Verified on the built bundle: every binary reports
`minos 14.0`, packaging refuses a build stamped newer, the app takes a free port when the
usual one is busy, and nothing in the binary names npm or the repo.
- [x] T7.1 Compile the three Swift helpers with `-target arm64-apple-macosx14.0` and set
  `LSMinimumSystemVersion` to 14.0. They ship stamped `minos 18.0` today while the app
  claims 13.0, so on an older Mac the app opens and the helpers refuse to load. 14.0 is the
  true floor: `cos-screen` uses `SCScreenshotManager`, which is macOS 14+.  [S]
- [x] T7.2 Pick a free port instead of hardcoding 4747, and write it where the shell reads it.
  Today a taken port means `EADDRINUSE`, and the app then says "Is the repo built
  (npm run build)?" to someone with no repo.  [S]
- [x] T7.3 Replace every message that names the repo, npm or a CLI command with something a
  recipient can act on (`AppDelegate.swift` lines ~29 and ~70, `server.ts` no-model text).  [S]
- [x] T7.4 Default the wake word to off. An app handed to someone should not listen until asked.  [S]
- [x] T7.5 Cap and rotate `~/.cos/logs`.  [S]
- [x] T7.6 Stop defaulting the project scan to `~/Desktop`: ask, or default to nothing. It
  triggers a Files-and-Folders prompt and reads folders that aren't ours.  [S]
- [x] T7.7 Take Full Disk Access out of the first-run walk. It has no prompt, must be done by
  dragging the app into System Settings, and only powers browser bookmarks. Ask when that
  feature is first used.  [S]

Tasks — the product promise
- [x] T7.8 Start at login, from the app: `SMAppService.mainApp.register()` (macOS 13+), with a
  menu toggle. No launch agent exists on this machine today, so nothing starts at login.  [S]
- T7.9 Schedule the brief, the wrap nudge and the silence check **inside the running app**,
  not through launchd. Verified 2026-09-15: `~/.cos/bin/cos-calendar` returns "calendar
  access denied" outside the app, because macOS grants calendar access to the bundle, not to
  a launchd job. A scheduled CLI brief would report an empty calendar every morning. The
  existing `scheduler/launchd.ts` stays for developer installs.  [M]
  The heartbeat (logic/heartbeat.ts) is the in-app timer this needs: moving the brief, wrap and
  silence check onto it is what's left.
- T7.10 Post notifications from the app (UNUserNotificationCenter) instead of
  `osascript display notification`, which is attributed to Script Editor and can be
  suppressed. Needs a server-to-app channel; the agent-finished path wants the same thing.  [M]
  Done for the heartbeat: the app polls GET /api/notices and posts its own (Notices.swift), and
  osascript stays the fallback when the app isn't running or wasn't allowed. Agent-finished
  still uses osascript.
- [x] T7.11 An uninstall menu item: quit, remove the login item, offer to delete `~/.cos`, leave
  `~/selfhub` unless they say otherwise, and name the Privacy entries it can't remove.  [S]
- T7.12 An app icon. Currently the generic one in Finder, the Dock and Notification Centre.  [S]
- T7.13 First-run identity: the memory works but starts empty, so day one reads "Nothing is
  ranked yet". Either interview them briefly and write `selfhub/*.md`, or point at the folder
  and say what to put there. Product decision before code.  [M]

Tasks — reach and trust
- T7.14 Universal build. Proven possible from this Mac: the helpers compile for
  `x86_64-apple-macosx14.0` and `lipo` merges both slices; SPM takes `--arch` twice. Needs
  the x86_64 Node tarball once, and Rosetta or an Intel Mac to smoke-test.  [M]
- T7.15 Developer ID, hardened runtime, notarize, staple; then `--notarize` on
  `cos menubar package`. Blocked on the Apple Developer Program (99 USD/year). Steps and
  entitlements are already written down in `docs/DISTRIBUTION.md`.  [M, blocked]
- T7.16 Updates: a version check against a URL, then Sparkle once there is somewhere to host
  and a notarized build to serve.  [M, blocked on T7.15]
- T7.17 Menu parity for what only the CLI can do today: voice pause and speed, the
  access/consent modes, silence-check now, status. Use the server-described action items the
  Model and Memory menus already render.  [S each]

Unverified without a second physical Mac (write down the answers when one exists):
whether the permission prompts for the seeded helpers are attributed to the app on a fresh
install; whether speech recognition downloads assets on first use; whether notifications
actually appear.

DoD: a .dmg installed on a Mac that has never seen this project gives a working brief, at
login, with no message that mentions a repo, and an uninstall that leaves nothing behind.

---

## EPIC 8 — Connections: other people's tools, without writing an integration each   [L]

Goal: "add Gmail / Notion / GitHub / Stripe / my own thing" from a menu, and the assistant can
use it in the same tool-use loop. Dependencies: E1 (the loop), E7.3 (the settings-window pattern).

Why this is cheaper than it looks: an MCP client is already in the tree. `actions/browser.ts`
spawns `@playwright/mcp` over `StdioClientTransport`, lists its tools and calls them. A
connection is that, generalised: a command or a URL, its tools merged into the loop.

Why it needs a decision first: `EPIC.md` locks "no per-provider OAuth" (build what only I
feed, read what the world feeds). MCP keeps that promise — each server owns its own auth, we
store a token or shell out to theirs — but a Connections menu is still a change of scope from
"one person's memory" to "a hub". Decide that on purpose, not by accident.

User stories
- US8.1 I add a connection from the menu, see whether it is alive, and turn it off again.
- US8.2 I add my own MCP server by command or URL, with its own environment values.
- US8.3 The assistant uses a connection's tools when they're relevant, and asks before
  anything that changes something elsewhere.
- US8.4 A broken or slow connection never breaks a conversation.

Done 2026-09-15: T8.1, T8.2, T8.6, T8.7, T8.8 — a connection can be added, checked against the
real server, turned on and off and removed, with its secrets in the keys file. What remains is the
half that lets the assistant *use* them: T8.3, T8.4, T8.5. Until then the window says so itself.

Tasks
- [x] T8.1 A connection registry in `~/.cos/connections.json`: id, label, transport
  (`stdio` command+args, or `http`/`sse` URL), env value names, enabled, plus a small
  built-in catalogue (Gmail, Google Drive/Docs, Notion, GitHub, Airtable, Stripe, Zapier,
  Hugging Face, Canva) that is only a prefilled command and a link to its docs.  [M]
- [x] T8.2 A client pool: connect lazily, list tools once, cache, reconnect on failure, hard
  timeout per call, and never let one server's failure escape into the loop.  [M]
- T8.3 Expose the tools: namespace them (`notion__search`), merge into `toolsFor(intent)`,
  and dispatch unknown names through the pool in `ToolRuntime`. Both are single seams today
  (`brain/tools.ts` lines ~349 and ~375).  [M]
- T8.4 **The hard part, and the next thing to do: context budget.** There are about thirty built-in tools now; ten
  servers with twenty tools each will not fit in a request, and a long tool list makes the
  model worse, not better. Needs a selection strategy — per-connection enable, per-intent
  scoping, or a first pass that picks the connection before the tools are shown. Prototype
  and measure before T8.3 ships.  [M]
- T8.5 Consent: connections join `actions/access.ts` (off / ask / auto) with a per-connection
  override, and every write through a connection lands in the existing pending-confirmation
  flow. A tool that sends an email is not the same as one that reads a page.  [M]
- [x] T8.6 Secrets: per-connection values in `~/.cos/.env` (or a 0600 file beside it) through the
  same code that already writes keys, masked in the UI, never logged.  [S]
- [x] T8.7 A Connections window, built like the keys one: a row per connection with its state, a
  "Get a token" link, an Add-your-own sheet (command or URL), and a live check on save.  [M]
- [x] T8.8 A trust note in the UI: an MCP server is code someone else wrote, running as you. Say
  that once, plainly, where they add one.  [S]

DoD: Notion and one hand-written MCP server are added from the menu on a machine with no
repo, the assistant answers a question that needs each of them, a disabled connection costs
nothing in context, and a server that hangs loses only its own call.

---

## EPIC 9 — Agent Grid's work areas and tickets   [M]   (done 2026-09-16)

Goal: the assistant sees Agent Grid's work areas, the agents in each and the tickets they hold, and
can do everything to a ticket that a person on the board can.

Done: the client (areas.py and tickets.py shapes, every ticket route), the join (area -> agents ->
tickets), three tools (`get_work_areas`, `get_tickets`, `change_ticket`), area and ticket on
`start_agent`, the ✦ › Agent Grid menu, and a round trip against the live board.

Deliberately not done:
- Creating, renaming and deleting work areas, or moving an agent between them. Asked for was
  visibility into the hierarchy; the calls exist (`POST /api/areas`) when it's wanted.
- A link straight to the ticket board. Agent Grid's page reads only `?t=`; the board is a toggle.
- Tickets in the morning brief. "In review: waiting on you" is the obvious line; it belongs with E7.9,
  since the brief should be scheduled inside the app first.

---

## EPIC 10 — Agents on the model you name   [S]   (done 2026-09-16, AG-1)

Goal: "start an agent on Opus 5" starts Claude Code on claude-opus-5, and the model is known
before the OK and visible after.

Done, here: `model` on `start_agent` (said any way, matched against Agent Grid's list, the engine
following from it), the model in the confirmation, `get_agent_models`, and the model each session
runs on in `get_agents`, `get_work_areas` and `cos agents`. Done, in Agent Grid (same branch name,
`feat/agent-model`): readable names in `GET /api/models`, no `<synthetic>` or hidden Codex models,
models a session used remembered in `~/.agentgrid/models.json`, a malformed ID refused before
anything runs, and a model the CLI refuses reported at launch rather than as a session that does
nothing. `claude --bg` exits 0 whatever the model, so Agent Grid reads the session's screen for up
to ten seconds when the model isn't one it lists.

Deliberately not done:
- A New agent… item in the ✦ menu. Starting agents stays a sentence; Agent Grid's own sheet has a
  model picker for when a form is wanted.
- An entitlement check. The list is what this Mac has used; the CLI decides what the account may run.

---

## EPIC 11 — It can look things up   [S]   (done 2026-09-17, COS-3)

Goal: "what's the news", "how's NVDA doing", "did they announce it yet" get a straight answer from
the web, without a Chrome window opening to go and read one.

Done, here: the provider does the searching. `ServerTools` in the model contract
(`brain/llm/types.ts`) names tools the provider runs on its own servers; `serverToolsFor(intent)`
offers web search to the two intents that answer a question (`ask`, `focus`) and to no others, so
the brief, the wrap and capture cost nothing extra. OpenRouter takes it as the
`openrouter:web_search` server tool alongside our function tools; Claude takes it as
`web_search_20260209` (`web_search_20250305` on models before Opus 4.6). Both report how many
searches ran, added up per run as `webSearches`. The persona draws the line: look it up to find out
what is true, use the browser only when something has to happen on a page or the answer is behind a
sign-in. `markdownToSpeech` already turns a citation into its source name, so a spoken answer says
"apnews.com", never an address.

Deliberately not done:
- OpenAI's own endpoint and local servers get nothing: that would need the Responses API, or our own
  search-API key. If the default model ever moves off OpenRouter, that is the work.
- A stock quote tool. A search returns a snippet price a few minutes old, which is right for "how's
  NVDA doing" and wrong for anything that needs the real number.
- A search MCP connection. Blocked on T8.3-T8.5 either way, and slower than the provider doing it.

Untested: the Claude path. No `ANTHROPIC_API_KEY` is set on this machine, so it is covered by
adapter tests on the request it builds, not by a live call.

## What keeps this from turning into back-and-forth

1. Contracts and schema are locked above and in BUILD.md — the agent implements to them.
2. Every task has an explicit acceptance line; no "make it nice."
3. Build-vs-read is decided per component; no re-litigating integrations mid-build.
4. No new infrastructure without hitting a stated trigger (see EPIC.md "Not doing").
5. Prompts are files: behavior is tuned by editing markdown, not shipping code.
6. The GATE prevents building five sprints of features before knowing v0 earns its keep.
