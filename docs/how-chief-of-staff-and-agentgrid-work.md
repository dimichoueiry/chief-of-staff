# How Chief of Staff and Agent Grid work (and work together)

A guided tour of two local programs: **Chief of Staff** (the assistant you talk to) and **Agent Grid**
(the dashboard that runs your Claude Code and Codex agents). It explains what each one is made of, how
Chief of Staff drives Agent Grid, and where the edges are.

Written against Chief of Staff `6fc6e92` and Agent Grid `3ecd6f8` (September 2026). File paths are
relative to each repo root: `~/Desktop/chief-of-staff` and `~/AgentGrid`. When the code and this
document disagree, the code wins.

---

## The one-minute version

- **Chief of Staff (CoS)** is a personal assistant for your Mac. You talk to it (or type) in a small
  floating "pill". A local Node.js server sends what you said to a language model, which can call
  **tools**: read your calendar, run a terminal command, or work with your coding agents.
- **Agent Grid (AG)** is a local Python dashboard over every Claude Code and Codex session on the Mac.
  It finds sessions, starts new ones, chats with them, and keeps a ticket board. Its **orchestrators**
  are standing managers that start agents on their own.
- **CoS is a client of AG's HTTP API.** CoS never runs `claude` or `codex` itself. When you say "have
  an agent add a quiz to module 6", CoS asks AG to start that agent.
- **They find each other through one file**: `~/.agentgrid/web.json`. AG writes its address and a
  secret token there, and CoS reads it.
- **Traffic goes both ways.** CoS sends requests to AG (JSON over HTTP). AG pushes status changes back
  over a live stream (`GET /api/events`), which is how CoS can tell you when an agent is done.
- **Everything stays on this Mac.** Both servers listen on `127.0.0.1` only.

---

## Words used in this document

| Word | Meaning |
|---|---|
| **Session** / **agent** | One Claude Code or Codex conversation doing work in a folder. AG shows each as a card. |
| **Engine** | Which CLI runs the agent: `claude` (Claude Code) or `codex`. |
| **Background / interactive** | Background agents run detached (`claude --bg`, `codex exec`). Interactive ones open in a Terminal tab you can type into. |
| **Orchestrator** | An AG "manager": a model on OpenRouter that can start and supervise real agents toward a goal. |
| **Persona / posting** | An orchestrator's identity (persona) placed on one team (posting). |
| **Work area** | A department-like group of agents in AG (Engineering, Marketing, …). |
| **Ticket** | A unit of work on AG's board, with an id like `APP-12`. |
| **Tool-use loop** | The model answers, asks to call a tool, gets the result, and repeats until it has a final answer. |
| **Tool** | A function the model may ask CoS to run, like `start_agent`. The model only asks. CoS code does the work. |
| **Pending action** | Something the model wants to do that waits for your OK first. |
| **Access mode** | How much CoS may do by itself for a capability: `off`, `ask` (default) or `auto`. |
| **SSE** | Server-sent events: one long HTTP response the server keeps writing events into. |
| **Loopback** | `127.0.0.1`, an address only programs on the same machine can reach. |
| **Token** | A random secret AG creates each time it starts. Every request must carry it. |

---

## 1. The big picture

```mermaid
flowchart LR
  you(["You: voice or keyboard"])

  subgraph COS["Chief of Staff (Swift + Node.js)"]
    app["Menubar app<br/>apps/menubar"]
    page["Pill page<br/>src/ui/web"]
    srv["Local server<br/>src/ui/server.ts<br/>127.0.0.1:4747"]
    loop["Tool-use loop<br/>src/brain/loop.ts"]
    tools["ToolRuntime<br/>src/brain/tools.ts"]
    client["Agent Grid client<br/>src/actions/agentgrid.ts"]
    watch["Agent watcher<br/>src/actions/agentwatch.ts"]
  end

  llm[("Model provider<br/>Anthropic, OpenAI, OpenRouter")]
  file[/"~/.agentgrid/web.json<br/>url, port, token, pid"/]

  subgraph AG["Agent Grid (Python, standard library only)"]
    http["HTTP API<br/>agentgrid/web.py<br/>127.0.0.1:8787"]
    fleet["Fleet poller + EventHub<br/>every 2 s"]
    spawn["launch_agent / spawn_agent"]
    chat["ChatManager<br/>agentgrid/chat.py"]
    orch["Orchestrator runs<br/>agentgrid/orchestrator_run.py"]
    board["Work areas + tickets<br/>areas.py, tickets.py"]
  end

  clis[["claude / codex CLIs<br/>the real agents"]]
  openrouter[("OpenRouter")]

  you --> app
  app <--> page
  page -- "POST /api/pill" --> srv
  srv --> loop
  loop <--> llm
  loop --> tools
  tools --> client
  client -- "HTTP + X-Agentgrid-Token" --> http
  http -- "SSE: GET /api/events" --> watch
  watch --> srv
  client -. reads .-> file
  http -. writes .-> file
  http --> spawn
  http --> chat
  http --> orch
  http --> board
  fleet --> http
  fleet -. "claude agents, transcripts, Codex rollouts" .-> clis
  spawn --> clis
  chat --> clis
  orch <--> openrouter
  orch --> spawn
```

How to read it: you talk to the **menubar app**. It shows the **pill page**, which sends your words to
the **local server**. The server runs the **tool-use loop** against your chosen model. When the model
asks for an Agent Grid tool, the **client** calls AG's HTTP API. AG does the work: it starts CLI
processes, sends chat turns, runs orchestrators, and edits tickets. Separately, AG's poller notices
status changes and streams them back to CoS's **watcher**.

---

## 2. Chief of Staff, layer by layer

### 2.1 What runs

| Piece | Language | Where | What it does |
|---|---|---|---|
| Menubar app | Swift (AppKit + WebKit) | `apps/menubar/Sources/ChiefOfStaff/` | The ✦ icon, hotkeys, on-device speech recognition, the floating pill window. Starts the local server. |
| Local server | TypeScript on Node.js | `src/ui/server.ts` (started by `cos ui`) | JSON API for the page, the tool-use loop, speech output, the Agent Grid watcher. |
| Pill page | Plain JS/HTML/CSS | `src/ui/web/` (`app.js`, `index.html`) | The chat UI. Runs inside the menubar app's web view, or in a normal browser with `cos ui`. |
| CLI | TypeScript | `src/cli/cos.ts` | `cos brief`, `cos ask`, `cos agents`, `cos orchestrators`, `cos access`, … Same functions the server uses. |
| Scheduler | launchd plists | `src/scheduler/launchd.ts` | Morning brief, evening wrap, silence check. Not involved with Agent Grid. |

The app and scheduler run a **copy** of the built CLI from `~/.cos/app` (or from inside a packaged
`.app`), not from the repo. macOS won't let a background process read code in `~/Desktop` without a
permission prompt. After code changes: `npm run build && npm run cos -- menubar refresh`.

### 2.2 The menubar app (Swift)

- `AppDelegate.swift` wires everything up. It builds the ✦ menu, including the **Agent Grid** submenu
  (drawn from `GET /api/grid`), and relays messages between the page and native code.
- `ServerManager.swift` starts `node <runtime>/dist/cli/cos.js ui --port <port> --no-open` if nothing
  answers yet. It pings `GET /api/projects` until the server is up. Port 4747 is the default, or the
  next free one (`ShellConfig.swift`). Server output goes to `~/.cos/logs/menubar-server.log`.
- `PillPanel.swift` is a borderless floating window with a `WKWebView` that loads
  `http://127.0.0.1:<port>/?shell=1&mode=pill`.
- `HotkeyMonitor.swift` handles double-tap Control (talk) and ⌥Space (type).
- `SpeechListener.swift` runs Apple's on-device speech recognition. `WakeListener.swift` and
  `WakePhrase.swift` listen for the wake name.

**The bridge between Swift and the page** works in both directions:

- Page → Swift: `window.webkit.messageHandlers.shell.postMessage({type: "listen" | "hide" | "height" | …})`.
- Swift → page: `panel.eval("cosShell.transcript(text, isFinal)")`, `cosShell.status(...)`, `cosShell.dismiss()`.
  `window.cosShell` is defined in `src/ui/web/app.js`.

### 2.3 The local server (Node.js)

`src/ui/server.ts` uses plain `node:http`, with no framework. `cos ui` binds it to `127.0.0.1` on port
4747 (`COS_UI_PORT` or `--port` change that). The endpoints that matter here:

| Endpoint | Purpose |
|---|---|
| `POST /api/pill` | One message from you. With `stream: true` the reply streams back as NDJSON (one JSON object per line): `start`, `status` ("Checking your agents…"), `text` deltas, then `done`. Messages are handled one at a time (`pillQueue`). |
| `POST /api/actions/confirm` | You tapped the button on a confirmation card (or Cancel). Runs the pending action. |
| `POST /api/speak`, `POST /api/speak/stop` | Say a reply out loud, or stop talking. |
| `GET /api/grid` | What the ✦ › Agent Grid menu shows: areas, agents, the ticket board in one line. Never throws. "Agent Grid is closed" is reported as a state. |
| `POST /api/grid/tickets/new` | File a ticket straight from the menu. Typing the title and pressing the button counts as your OK. |
| `GET/POST /api/conversation…` | The chat thread: current, new, aside, switch, rename, delete. |

When the server starts listening, it also starts the **Agent Grid watcher** (section 5.4), because
`cos ui` passes the `agentWatch` option.

### 2.4 Voice in and voice out

```mermaid
sequenceDiagram
  autonumber
  participant Mic as Mic and speakers
  participant Swift as Menubar app
  participant Page as Pill page
  participant Srv as Local server
  participant TTS as src/voice/tts.ts

  Mic->>Swift: audio
  Swift->>Swift: SpeechListener, Apple on-device recognition
  Swift->>Page: cosShell.transcript(text, final)
  Page->>Srv: POST /api/pill with stream true
  Srv-->>Page: NDJSON status, text, done
  Page->>Srv: POST /api/speak
  Srv->>TTS: speak(reply)
  TTS->>TTS: OpenAI gpt-4o-mini-tts, or the macOS say voice
  TTS-->>Mic: plays through the cos-play helper, then the mic reopens
```

- Hearing: Apple's on-device recognizer in the menubar app. In a plain browser (`cos ui`), the page
  uses the browser's Web Speech API instead. No API key is needed for either.
- Speaking: `src/voice/tts.ts`. It uses OpenAI's TTS when `OPENAI_API_KEY` is set, otherwise the Mac's
  `say`. Audio plays through a small native player, `src/voice/player/cos-play.swift`.

### 2.5 The brain: one tool-use loop

`runIntent()` in `src/brain/loop.ts` is the heart of CoS. For each message it:

1. Builds **memory context**: the ledger, journal, calendar and git activity (`src/core/context.ts`),
   plus summaries of recent conversations (`src/brain/recall.ts`).
2. Picks a **prompt template** for the intent (`src/brain/prompts/*.md`): `ask`, `focus`, `capture`,
   `wrap` or `brief`.
3. Picks the **tools** that intent may use (`toolsFor()` in `src/brain/tools.ts`). Agent Grid tools
   are only available to `ask` and `focus`.
4. Calls the model through a provider-neutral interface (`src/brain/llm/types.ts`). Adapters live in
   `src/brain/llm/anthropic.ts` and `openai.ts`. OpenRouter and OpenAI-compatible servers use the OpenAI
   adapter. `registry.ts` chooses which one to use.
5. If the model asks for tools, it runs each one through `ToolRuntime.execute()`, appends the results,
   and asks again. It stops at a final answer or after 12 turns.

The conversation is saved in `~/.cos/conversations` (`src/brain/conversation.ts`). Besides `user` and
`assistant` turns there are **`event` turns**: things that happened outside the chat, like "you tapped
Start agent" or "agent X finished". The next message to the model starts with
`(Since your last reply: …)`, so the model knows about those events.

### 2.6 The tool layer: CoS's Agent Grid tools

All tool definitions (name, description, JSON schema) and their implementations are in
`src/brain/tools.ts`. The HTTP calls are in `src/actions/agentgrid.ts`, class `AgentGrid`.

| Tool the model calls | What it does | Agent Grid endpoints used | Needs your OK? |
|---|---|---|---|
| `get_agents` | Lists sessions, those that need you first | `GET /api/sessions` | No, read-only |
| `get_agent_output` | Reads the end of one transcript (about the last 10,000 characters) | `GET /api/sessions`, `GET /api/transcript?id=` | No |
| `get_agent_models` | Lists the models each engine can use | `GET /api/models` | No |
| `start_agent` | Starts a Claude Code or Codex agent | `GET /api/models`, `/api/areas`, `/api/tickets` (to resolve names), `GET /api/projects`, `POST /api/projects/add`, `POST /api/spawn` | In `ask` mode |
| `message_agent` | Sends a follow-up to a session | `POST /api/chat` | In `ask` mode |
| `get_work_areas` | Areas → agents in each → the tickets they hold | `GET /api/areas`, `/api/sessions`, `/api/tickets` | No |
| `get_tickets` | The board, filtered, or one ticket in full | `GET /api/tickets` | No |
| `change_ticket` | Create, edit, move, assign, comment on or delete a ticket | `POST /api/tickets/{create,update,move,assign,comment,delete}` | In `ask` mode. **Delete always asks.** |
| `get_orchestrators` | Every orchestrator's status, or one in full | `GET /api/orchestrators` | No |
| `start_orchestrator` | Starts an existing orchestrator on a goal | `POST /api/orchestrators/start` | In `ask` mode |
| `stop_orchestrator` | Stops one | `POST /api/orchestrators/stop` | In `ask` mode |
| `message_orchestrator` | Adds a message it reads on its next step | `POST /api/orchestrators/send` | In `ask` mode |
| `respond_orchestrator_approval` | Approves or declines the one tool call an orchestrator is holding | `POST /api/orchestrators/approve` or `/decline` | **Always**, whatever the mode |

Helpers that turn AG's raw data into text the model can read:

- `src/actions/agentgrid.ts`: `formatSessions`, `formatTranscript`, `findSession` (match by id prefix or
  title words), `resolveModel` ("Opus 5" → `claude-opus-5`), `formatOrchestrator(s)`, `findOrchestrator`.
- `src/actions/gridboard.ts`: joins areas, sessions and tickets into one tree. Also parses spoken
  statuses ("in review" → `review`) and ticket ids ("dc12" → `DC-12`). It makes no network calls, so it
  is easy to test.
- `src/actions/tickets.ts`: `planTicketChange` resolves every reference (a title → an id, "the MLG
  agent" → a session id) **before** you're asked. `performTicketChange` then runs exactly the plan you
  approved.

### 2.7 Guard rails: access modes and pending actions

CoS decides what it may do on its own. The model doesn't get to decide.

**Access modes** (`src/actions/access.ts`, saved in `~/.cos/access.json`, changed with `cos access`):

| Capability | Default | `off` | `ask` | `auto` |
|---|---|---|---|---|
| `agents` (all of Agent Grid) | `ask` | Every AG tool fails with "Agent Grid access is off". The watcher hangs up. | Reads run freely. Anything that changes something waits for your OK. | Changes run straight away, except ticket deletes and orchestrator approvals. |

**Pending actions** (`src/actions/pending.ts`): when a change needs your OK, the tool doesn't run it.
It queues a `Pending` with a random id, a one-line label, the exact details, and a button word
("Start agent"). The tool then returns an instruction to the model, like *"Not started yet. Ask them in
one short sentence…"*. The reply carries a confirmation card.

There are three ways to answer:

1. **Tap the button**: `POST /api/actions/confirm {id}` → `performPending()` (`src/actions/perform.ts`).
2. **Say a clear yes or no**: before the model even runs, `settlePending()` in `server.ts` uses
   `readConsent()` (`src/actions/consent.ts`) to recognize "yeah, send it" or "no, leave it", and acts on it.
3. **Give a mixed answer** ("yes, but make it shorter"): this goes to the model, which may call
   `confirm_pending`. That tool must be the model's first call in its reply.

Pending actions are **single-use**, **expire after 5 minutes**, and live **in the server's memory**.
The model can't confirm its own request: only a button tap or your words can. `repeated()` in
`tools.ts` also refuses to queue the same action twice, or to redo one that ran in the last 15 minutes.

### 2.8 CoS state on disk (for reference)

| Path | Holds |
|---|---|
| `~/selfhub/` (`COS_SELFHUB`) | Long-term memory: ledger, journal, reminders, notes. Plain markdown in git. |
| `~/.cos/conversations/` | Saved chats, including the `event` lines about agents. |
| `~/.cos/access.json` | Access modes. |
| `~/.cos/.env` | API keys (owner-only). Never sent to Agent Grid. |
| `~/.cos/logs/` | `menubar-server.log`, `terminal.log`, … |

---

## 3. Agent Grid, layer by layer

### 3.1 What runs

`python3 -m agentgrid --web` from `~/AgentGrid` (or `ag --web` through `bin/ag`) calls `serve()` in
`agentgrid/web.py`. It uses only Python's standard library: no pip, no build step. It starts:

- a **`Fleet`** poller thread that refreshes the list of sessions every 2 seconds (`POLL_SECONDS`);
- a **`ThreadingHTTPServer`** on `127.0.0.1:8787`, or on a free port if 8787 is taken;
- a **`ChatManager`** (`agentgrid/chat.py`) for chat turns with sessions;
- a **`RunManager`** (`agentgrid/orchestrator_run.py`) for orchestrators. On startup it resumes any run
  the last shutdown interrupted;
- a small thread that keeps `~/.agentgrid/web.json` pointing at this run (section 4.1).

Plain `ag` shows the same data as a curses grid in the terminal (`agentgrid/ui.py`). CoS only talks
to the web server.

### 3.2 The security gate

Every request must carry the per-run token, either as `?t=<token>` or in the `X-Agentgrid-Token`
header. `Handler._authorized()` compares it with `secrets.compare_digest`. Anything else gets
`403 {"error": "Bad or missing token."}`. Responses also send `X-Frame-Options: DENY` and
`Referrer-Policy: no-referrer`. The token is new every time AG starts.

### 3.3 Finding sessions: `discovery.py`

AG doesn't scrape screens. `discovery.collect()` combines:

| Source | Gives |
|---|---|
| `claude agents --json --all` | Which Claude sessions exist, and their state or status, cwd, pid, job id |
| Transcripts on disk (`~/.claude/projects/…/*.jsonl`, read incrementally) | Title, model, last prompt, tool counts, last activity |
| `~/.claude/jobs/<id>/state.json` → `tempo` | Whether a background job is really working right now |
| `~/.codex/sessions/` rollouts + `session_index.jsonl` | Codex sessions, titles, models, and "working" inferred from open tasks |
| `~/.agentgrid/state.json` (written by `hooks/agentgrid_notify.py`, a Claude Code Notification hook) | Which interactive sessions are stuck at a prompt, so they show as "Needs you" |
| `names.json`, `overrides.json`, `read.json`, `tags.json` in `~/.agentgrid/` | Your names, manual card moves, unread positions, tags |

`normalize_status()` merges the CLI's two vocabularies into one. Background sessions report
`working/blocked/done/failed/stopped`; interactive ones report `busy/idle/waiting`, which become
`working/idle/blocked`. `Fleet._as_json()` is the session shape CoS receives from `/api/sessions`:
`sessionId, title, customName, status, engine, model, cwd, project, prompt, idleSeconds, …`.

### 3.4 Starting agents: `launch_agent()` and `spawn_agent()`

Both the New agent sheet (`POST /api/spawn`) and an orchestrator's `start_agent` tool go through
`launch_agent()` in `web.py`. That's why an agent an orchestrator started looks exactly like one you
started by hand.

`launch_agent()`:

1. Checks the work area exists (`areaId`).
2. If `ticketKey` is set, puts the ticket's handoff brief (`tickets.handoff_prompt`) in front of the
   task. The brief includes the `ag ticket` commands the agent should use to report back.
3. Resolves the folder. `noProject: true` means `~/Desktop` (or `~` if there's no Desktop); otherwise it
   uses `cwd`.
4. Calls `spawn_agent()`. That **refuses any folder that isn't a known project** (discovered git repos,
   folders the fleet already works in, or folders added by hand). It also refuses a model id that isn't
   well-formed.
5. Registers the area membership, assigns the ticket (moving it to In progress), and names the session
   once it appears.

`spawn_agent()` has three shapes:

| Shape | Command | Notes |
|---|---|---|
| Claude, background (default) | `claude --bg [--model M] <prompt>` in the folder | Prints a job id, which AG uses to name the session later. |
| Codex, background | `codex exec --cd <dir> -s workspace-write --skip-git-repo-check [-m M] <prompt>`, detached | Prints no job id, so the name is matched by folder and start time. |
| Interactive (macOS) | A Terminal.app tab running `claude <prompt>` or `codex <prompt>` | Every argument is shell-quoted. Opened through AppleScript. |

A model AG hasn't seen on this Mac is checked for up to 10 seconds. If the CLI refuses it, AG says so
and starts nothing. Spawned agents get `AGENTGRID_AGENT=<name>` in their environment, and
`OPENROUTER_API_KEY` is removed from it (`agent_env()`).

### 3.5 Talking to a session: `POST /api/chat` → `chat.py`

A message to an existing session is a **new headless turn** of the CLI, resumed on that session:

- Claude: `claude -p <message> --output-format stream-json --verbose --permission-mode <posture> --resume <sessionId>`
- Codex: `codex exec -s workspace-write -c approval_policy="never" resume --json … <sessionId> <message>`

`cwd` always comes from the session AG tracks, never from the caller. The default posture is `auto`,
which maps to `--permission-mode bypassPermissions`. CoS sends no posture, so it gets this default.
One turn runs per session at a time. Messages sent during a turn wait in a queue.

### 3.6 Transcripts: `GET /api/transcript?id=`

`transcript.render_blocks()` turns the session's JSONL file into typed blocks:
`{kind: user|assistant|tool|result|thinking, text, name, gist, error}`. The file is opened read-only,
so reading a live session is safe. CoS uses these blocks for `get_agent_output` and to quote an
agent's last words when it finishes.

### 3.7 The event stream: `EventHub` and `GET /api/events`

`EventHub` in `web.py` is the push side of the integration.

- After every 2-second poll, `Fleet._announce()` shows the snapshot to `EventHub.observe()`. The
  snapshot includes live chat turns, so a session AG is chatting with counts as `working`.
- For each session whose status changed since the last poll, it creates an event:

  ```
  id: 3f9a2c1d-7
  data: {"type":"status","sessionId":"…","title":"Refactor auth","engine":"claude",
         "cwd":"/Users/you/Desktop/my-app","project":"my-app",
         "from":"working","to":"done","finished":true,"at":"2026-09-15T18:40:12"}
  ```

- `finished` is true when the session was `working` and settled into `done`, `failed`, `blocked`,
  `idle`, `stopped` or `complete`.
- Ids look like `<run>-<n>`. The run prefix changes on every AG restart. The last 200 events are kept.
  A client that reconnects with `Last-Event-ID` from the same run gets every event it missed, and no
  event twice.
- A `: ping` comment is sent every 15 seconds as a heartbeat.

### 3.8 Work areas and tickets

- **Areas** (`agentgrid/areas.py`, `~/.agentgrid/areas.json`) hold the list of areas and a `members`
  map from session id to area. An area doesn't list its agents directly. That's why CoS's
  `gridboard.ts` does the join.
- **Tickets** (`agentgrid/tickets.py`, one JSON file per ticket under `~/.agentgrid/tickets/`) have a
  per-project key and number (`APP-12`), five statuses, type, priority, assignee, labels and an
  activity log. Agents use the `ag ticket …` CLI (`agentgrid/ticket_cli.py`) to take, comment on and
  move tickets from their own shell.
- **Assigning to a live session** (`/api/tickets/assign`) also sends the ticket's handoff brief into
  that agent's chat (through `ChatManager`). An assignment to a bare name is just a label.

### 3.9 Orchestrators

An orchestrator is **not a session**. It's a manager that starts sessions. Its code is split up:

| File | Role |
|---|---|
| `agentgrid/personas.py` | Who it is: guidelines, the OpenRouter model it thinks with, agent defaults, allowed models, team, skills, lessons. |
| `agentgrid/orchestrator.py` | Where it works (a *posting*): scope (a work area, or `""` for all), project, mode `ask`/`auto`, limits. Data and files only: no network, no threads. |
| `agentgrid/orchestrator_brief.py` | What the model is told: the system prompt and the **tool menu**. |
| `agentgrid/orchestrator_run.py` | How it behaves: the loop, gates, limits, persistence, watching its agents. |
| `agentgrid/openrouter.py` | The one network call: `tool_turn()` to OpenRouter. The key comes from the macOS Keychain (`credentials.py`), or from `OPENROUTER_API_KEY` on other systems. |
| `ServerHost` in `web.py` | The orchestrator's **only door** to the machine. Each method is something the UI can already do. |

**The tool menu** the orchestrator's model gets: `list_projects`, `list_work_areas`,
`create_work_area`, `start_agent`, `list_agents`, `read_agent_output`, `send_to_agent`,
`wait_for_agents`, `list_tickets`, `create_ticket`, `move_ticket`, `comment_ticket`, `set_plan`,
`remember`, `message_user`, `read_skill`, `read_prompt`, `finish`. There's no shell, no filesystem
access and no editor.

**The run loop** (`Run._step()`):

```mermaid
flowchart TD
  start(["POST /api/orchestrators/start with a goal"]) --> limits{"Step or spend limit hit?"}
  limits -- yes --> failed["status: failed"]
  limits -- no --> think["Ask the OpenRouter model: tool_turn()"]
  think --> calls{"Did it call tools?"}
  calls -- "no, but its agents are still busy" --> watchKids["Watch its agents at no cost, no model calls"]
  watchKids -- "an agent finished, blocked or left" --> think
  calls -- "no, and nothing is running" --> waitReply["status: waiting, it asked you something"]
  calls -- yes --> gate{"Needs approval?"}
  gate -- yes --> pending["status: waiting with a pending approval saved to disk. The worker thread exits."]
  pending -- "approve or decline" --> invoke
  gate -- no --> invoke["Run the tool through ServerHost"]
  invoke --> persist["Write state.json and journal.jsonl"]
  persist --> fin{"finish tool?"}
  fin -- yes --> done["status: done"]
  fin -- no --> limits
```

Key rules, all enforced in code (none of this is left to the model):

- **Approval gates** (`_gate_reason`): in `ask` mode, `start_agent` and `create_work_area` wait for you.
  In `auto` mode, opening an **interactive** Terminal tab still asks, unless the persona's default is
  interactive. A request that would be refused anyway (a model outside the allowed list, say) is
  refused outright, without asking you.
- **Limits** (defaults): 3 agents at once, 20 agents per run, 200 steps, $5 of the orchestrator's own
  OpenRouter spend. The agents it starts run on your normal Claude Code and Codex logins.
- **Durability**: after every step the state is written to `~/.agentgrid/orchestrators/<id>/state.json`,
  with an append-only `journal.jsonl` beside it. A pending approval survives a restart. A run interrupted
  mid-step resumes, and the model is told to check `list_agents` and `list_tickets` before starting
  anything, so it doesn't start the same agent twice.
- **Statuses**: `idle`, `running`, `waiting` (needs you), `done`, `failed`, `stopped`.

### 3.10 Agent Grid state on disk

```
~/.agentgrid/
├── web.json            # where to reach this run: url, port, token, pid (owner-only)
├── state.json          # the Notification hook's record of who is waiting
├── names.json, tags.json, overrides.json, read.json
├── areas.json          # work areas + which session sits where
├── projects.json       # folders added by hand, favorites, hidden
├── agents.json         # the saved agent library
├── models.json         # models this Mac has actually used
├── tickets/            # one JSON per ticket + _meta.json (keys and counters)
├── orchestrators/<id>/ # definition, state.json, journal.jsonl, memory
├── personas/           # one JSON per persona
└── notes/              # the daily notepad
```

---

## 4. How the two connect

### 4.1 Finding each other: `~/.agentgrid/web.json`

```mermaid
sequenceDiagram
  autonumber
  participant AG as Agent Grid serve()
  participant F as web.json file
  participant CoS as CoS findConnection()

  AG->>AG: mint token, bind 127.0.0.1 on 8787 or a free port
  AG->>F: claim_connection_file() writes url, port, token, pid, started (mode 0600)
  loop every 5 s while running
    AG->>F: keep_connection_file() re-claims it unless another live run holds it
  end
  CoS->>F: read on every request
  CoS->>CoS: check the pid is alive and the address is loopback
  CoS->>AG: request with header X-Agentgrid-Token
  AG->>F: on a clean stop, remove the file only if it is still this run's
```

Details that matter:

- **The override.** `AGENTGRID_URL=http://127.0.0.1:8787/?t=…` in CoS's environment replaces the file
  (`findConnection()` in `src/actions/agentgrid.ts`).
- **Loopback only.** CoS refuses any base URL other than `http://127.0.0.1` or `http://localhost`.
- **Read every time.** CoS calls `findConnection()` per request (and per event-stream connection), so
  an AG restart with a new token is picked up without restarting CoS.
- **Two AG instances.** A second `ag --web` (a test run on a spare port, say) won't take the file from
  a run that still answers `GET /api/ping` with its own token. CoS keeps talking to the first run.

### 4.2 The request contract

`AgentGrid.call()` in `src/actions/agentgrid.ts`:

- `GET` when there is no body, otherwise `POST` with a JSON body.
- Headers: `X-Agentgrid-Token: <token>`, plus `content-type: application/json` on POSTs.
- Timeout: 15 s, or 90 s for `/api/spawn`, because starting an agent (and checking its model) can take
  a while.
- Errors come back in plain words:

| What happened | What CoS says |
|---|---|
| Connection refused | "Agent Grid isn't running. Start it with `python3 -m agentgrid --web` from ~/AgentGrid." |
| No `web.json` | "Agent Grid hasn't shared its connection yet…" |
| `403` | "Agent Grid rejected the key: it was probably restarted…" |
| `404` on `/api/events` or `/api/orchestrators` | "This Agent Grid can't … yet: update it from ~/AgentGrid and restart it." |
| Other non-2xx | AG's own `{"error": "…"}` text, e.g. "That directory is not one of the known projects." |

### 4.3 Endpoint map

| CoS `AgentGrid` method | HTTP | AG handler | Effect |
|---|---|---|---|
| `sessions()` | `GET /api/sessions` | `_sessions_snapshot()` | Fleet snapshot with live chat overlaid |
| `projects()` | `GET /api/projects` | `discover_projects()` | Folders agents may run in |
| `start(o)` | `POST /api/projects/add` then `POST /api/spawn` | `add_project()`, `_spawn()` → `launch_agent()` | New agent |
| `models()` | `GET /api/models` | `models.py` | Model catalog per engine |
| `transcript(id)` | `GET /api/transcript?id=` | `_get_transcript()` | Transcript blocks |
| `message(id, text)` | `POST /api/chat` | `_chat_send()` → `ChatManager.send()` | A headless resumed turn |
| `areas()` | `GET /api/areas` | `areas.load()` | Areas + members |
| `board()` | `GET /api/tickets` | `tickets.py` | All tickets + facets |
| `createTicket/updateTicket/moveTicket/assignTicket/commentTicket/deleteTicket` | `POST /api/tickets/{create,update,move,assign,comment,delete}` | `_tickets_*` | Ticket changes. Assigning to a live session also messages it. |
| `events()` | `GET /api/events` (SSE) | `_events_stream()` | Status changes |
| `orchestrators()` | `GET /api/orchestrators` | `_orchestrators()` → `Run.snapshot()` | Definitions + run state |
| `startOrchestrator / stopOrchestrator / sendOrchestrator` | `POST /api/orchestrators/{start,stop,send}` | `_orchestrator_action()` → `Run.start/stop/submit` | Run control |
| `answerOrchestrator` | `POST /api/orchestrators/{approve,decline}` | `Run.approve/decline` | Resolves the pending approval |
| `pageUrl()` | (none) | (none) | Builds the signed-in board URL for the menu |

---

## 5. End-to-end flows

### 5.1 "Do any of my agents need me?"

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant Srv as CoS server
  participant LLM as Model
  participant TR as ToolRuntime
  participant AG as Agent Grid

  You->>Srv: POST /api/pill "do any of my agents need me?"
  Srv->>LLM: memory + history + tools (intent ask)
  LLM-->>Srv: tool call get_agents
  Srv-->>You: status "Checking your agents…"
  Srv->>TR: execute get_agents
  TR->>TR: agentsAllowed() checks access is not off
  TR->>AG: GET /api/sessions
  AG-->>TR: sessions JSON
  TR-->>LLM: formatSessions(): needs-you first, then working
  LLM-->>Srv: maybe get_agent_output for the blocked one
  Srv->>AG: GET /api/transcript?id=…
  LLM-->>Srv: final answer
  Srv-->>You: text streamed, then spoken
```

Nothing changes, so nothing waits for your OK.

### 5.2 "Start an agent on Opus 5 to review the export code" (ask mode)

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant Srv as CoS server
  participant LLM as Model
  participant TR as ToolRuntime
  participant P as pending.ts
  participant AG as Agent Grid
  participant CLI as claude CLI

  You->>Srv: the request
  Srv->>LLM: ask intent
  LLM-->>TR: start_agent task, folder, model "Opus 5"
  TR->>AG: GET /api/models
  TR->>TR: resolveModel gives claude and claude-opus-5
  TR->>P: queue agent-start with the resolved job
  TR-->>LLM: Not started yet. Ask them in one short sentence.
  LLM-->>You: "Should I start a Claude agent on Opus 5 to …?" plus a card
  You->>Srv: "yes" or a tap on Start agent
  Srv->>P: take(id), single use
  Srv->>AG: GET /api/projects
  Srv->>AG: POST /api/projects/add with create true, only if the folder is new
  Srv->>AG: POST /api/spawn prompt, engine, model, cwd, name, interactive
  AG->>AG: launch_agent checks the project boundary and model id
  AG->>CLI: claude --bg --model claude-opus-5 "task"
  CLI-->>AG: job id
  AG-->>Srv: message "Started in my-app on claude-opus-5."
  Srv->>Srv: add event turn "They said yes and it is already done…"
  Srv-->>You: confirmation
```

Variations:

- **`auto` mode**: steps 5 to 9 are skipped, and the tool calls `grid.start()` directly.
- **`area` / `ticket`**: the tool resolves the name to an `areaId` or `ticketKey` first. AG then puts
  the ticket's brief in the prompt, registers the area and moves the ticket to In progress.
- **`visible: true`**: AG opens a Terminal tab instead of a background agent.
- **No folder**: `noProject: true`, and AG runs the agent in `~/Desktop`.

### 5.3 "Tell the auth agent to also update the tests"

1. `message_agent` → `GET /api/sessions` → `findSession()` matches by id prefix, or by title, custom
   name or project words. If several match, it prefers the one that is working or needs you. Otherwise
   it asks you for the id.
2. In `ask` mode the message is queued, and CoS reads it back to you ("Should I send this to …?").
3. On yes: `POST /api/chat {sessionId, message}`. AG's `ChatManager` runs
   `claude -p <message> --resume <sessionId> …` in that session's folder. The turn is queued if one is
   already running.
4. While that turn runs, the session shows as `working`. When it ends, the event stream reports a
   finish (5.4).

### 5.4 An agent finishes, and you hear about it

```mermaid
sequenceDiagram
  autonumber
  participant CLI as claude or codex
  participant Fleet as AG Fleet poller
  participant Hub as AG EventHub
  participant W as CoS watchAgents()
  participant AG as AG HTTP API
  participant Srv as CoS server
  actor You

  W->>Hub: GET /api/events with Last-Event-ID if any
  loop every 2 s
    Fleet->>CLI: claude agents --json, transcripts, rollouts
    Fleet->>Hub: observe(snapshot)
  end
  Hub-->>W: id run-n, data status working to done, finished true
  W->>W: ignore unless type status, finished, known word, id not seen
  W->>AG: GET /api/transcript?id=… for its last words
  W->>Srv: onFinished(title, body, speech, line)
  Srv->>Srv: add an event turn to the current conversation, between messages
  Srv->>You: macOS notification "Refactor auth: done"
  Srv->>You: spoken "Refactor auth is done."
  Note over Srv,You: Next message: "(Since your last reply: Agent Refactor auth … finished: done. It last said: …)"
```

Reliability details (`src/actions/agentwatch.ts`):

- **Reconnects**: waits 3 s, doubling up to 60 s. Silence longer than 45 s counts as a dropped
  connection, since AG sends a heartbeat every 15 s.
- **Nothing twice**: it remembers the last 500 event ids it announced. AG replays what was missed after
  `Last-Event-ID`, but only within the same AG run.
- **Respects access**: with `cos access agents off` it doesn't connect, and it hangs up within about 5 s
  if access is switched off while connected.
- **Terminal version**: `cos agents --follow` prints the same stream.

### 5.5 Orchestrators: start, then approve from CoS

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant CoS as CoS tools
  participant AG as AG HTTP API
  participant Run as AG Run worker
  participant OR as OpenRouter
  participant Host as ServerHost

  You->>CoS: "Start the Product Manager on clearing the backlog"
  CoS->>AG: GET /api/orchestrators, then findOrchestrator by name
  CoS-->>You: "Should I start Product Manager on this goal?"
  You->>CoS: "yes"
  CoS->>AG: POST /api/orchestrators/start id, goal
  AG->>AG: refuses if no OpenRouter key or already running
  AG->>Run: start(goal) and spin a worker thread
  Run->>OR: tool_turn(messages, model, tool menu)
  OR-->>Run: start_agent call
  Run->>Run: ask mode means gated. Save pending, status waiting, worker exits
  Note over You,CoS: later
  You->>CoS: "Is the Product Manager waiting on me?"
  CoS->>AG: GET /api/orchestrators
  CoS-->>You: "Waiting for your OK on start_agent …"
  You->>CoS: "approve it"
  CoS->>CoS: respond_orchestrator_approval always queues a confirmation
  CoS-->>You: plain-language question
  You->>CoS: "yes"
  CoS->>AG: POST /api/orchestrators/approve id, approvalId
  AG->>Run: approve, then the worker resumes
  Run->>Host: start_agent(request) goes to launch_agent, same path as /api/spawn
  Run->>Run: watch the child agent, then wake the model when it settles
```

Two things to notice:

- An orchestrator's `waiting` status means one of two things. If `pending` is set, it's holding a tool
  call for your approval: answer with `respond_orchestrator_approval`. If `pending` is `null`, it ended
  its turn in plain text and wants a reply: answer with `message_orchestrator`. `formatOrchestrator()`
  shows which one it is.
- Agents an orchestrator starts are ordinary sessions. Their finishes come through `/api/events` and
  get announced by CoS like any other agent's.

---

## 6. Status words across the stack

**Sessions** (from `discovery.normalize_status`; CoS words from `STATUS_WORDS` and `FINISHED_WORDS`):

| AG status | Comes from | AG board column | CoS says | Counts as a finish when leaving `working` |
|---|---|---|---|---|
| `working` | `state: working`, `status: busy`, or a chat turn AG is running | Working | working | (none) |
| `blocked` | `state: blocked`, `status: waiting`, or the Notification hook | Needs you | needs you | yes |
| `failed` | `state: failed` | Needs you | failed | yes |
| `done` | `state: done` (the turn ended, not necessarily the work) | Replied | done | yes |
| `stopped` | `state: stopped` | Replied | stopped | yes |
| `idle` | Interactive `idle` | Idle, or Replied if unread | idle | yes |
| `complete` | Set by a person in AG | Done | done | yes |

**Orchestrators**: `idle` · `running` (CoS says "working") · `waiting` ("needs you") · `done` ·
`failed` · `stopped`.

**Tickets**: `backlog` · `todo` · `in_progress` · `review` · `done`. CoS also accepts spoken
versions like "doing", "in review" or "closed" (`STATUS_ALIASES` in `gridboard.ts`, mirrored from
`tickets.py`).

---

## 7. Boundaries and limitations

### Trust and safety boundaries

- **Same Mac only.** Both servers bind `127.0.0.1`. CoS refuses a non-loopback AG address. To reach an
  AG running on another machine, use an SSH tunnel to a local port and set `AGENTGRID_URL`.
- **The token is AG's lock.** It's minted per run and stored owner-only in `web.json`. CoS only uses
  it in request headers and in the signed-in board link that the ✦ › Agent Grid menu opens. **CoS's own server has no token and doesn't check the request's `Origin`.**
  It relies only on the loopback bind. That is a weaker posture than AG's, and worth knowing if the
  CoS server ever does more.
- **CoS never runs the agents.** Every start, message or ticket change goes through AG's API and AG's
  checks.
- **Your OK is enforced in code, not asked of the model.** Access modes plus single-use, expiring
  pending actions. The model can't confirm its own request. Orchestrator approvals and ticket deletes
  always ask.
- **The project boundary is wider from CoS.** AG only spawns in known projects. But CoS's
  `start_agent` first adds any folder inside your home folder as a project, creating it if needed.
  From CoS, the effective boundary is "anywhere under `~`". CoS refuses folders outside home.
- **Agents run with broad permissions.** A background spawn passes no permission flag, so the CLI's own
  settings apply. **Follow-up messages** through `/api/chat`, which `message_agent` and ticket
  assignment both use, run with posture `auto` → `--permission-mode bypassPermissions` for Claude, and
  `approval_policy="never"` for Codex. Once sent, a message's tools run without asking.
- **Orchestrators never get a shell.** They get a fixed tool menu executed by AG, limits enforced by
  AG before each call, and the same spawn path as a human.
- **Secrets stay put.** CoS keeps its model keys in `~/.cos/.env` and doesn't send them to AG. AG's
  OpenRouter key lives in the Keychain, is never sent to the browser, and is removed from every spawned
  agent's environment.

### Functional limitations

- **Missed finishes across restarts.** Replay after a dropped stream only works within the same AG run,
  and for the last 200 events. If AG restarts, anything that finished while CoS wasn't listening isn't
  announced. You can still ask ("did the auth refactor finish?").
- **Events come from a 2-second poll.** A status that changes and changes back within one poll isn't
  seen. The watcher only runs while CoS's server runs and agent access isn't `off`.
- **Orchestrators aren't pushed to CoS.** CoS doesn't subscribe to `/api/orchestrators/stream`, so an
  orchestrator that starts waiting for approval won't notify you through CoS. You find out by asking,
  or from AG's own badge.
- **CoS can operate orchestrators, not configure them.** Creating or editing orchestrators, personas,
  models, limits or mode happens in AG's UI. CoS also can't edit a pending approval's arguments before
  approving. AG's UI can.
- **Pending confirmations are short-lived.** They're held in the CoS server's memory: they expire after
  5 minutes and are lost if the server restarts. Just ask again.
- **Messaging a Claude agent mid-turn is risky.** AG's own code notes that resuming a Claude session
  that is still running starts a *copy* the real agent never sees. AG blocks this for orchestrators
  (`follow_up_block`) but not yet on `/api/chat`, which is what CoS uses. It's safest to message agents
  that are idle, done or need you.
- **Codex quirks.** No job id, so names are matched by folder and start time. No attach. A chat is
  refused while a terminal or another run holds the Codex thread (HTTP 409).
- **Interactive agents need macOS Terminal.app.** On other hosts, AG only offers background agents.
- **Model names.** AG's model list only includes models this Mac has used, plus aliases. An exact id it
  hasn't seen goes through, and AG checks it for up to 10 seconds when starting.
- **Size limits.** CoS shows the model the first 15 sessions (the ones that need you and the working
  ones come first) and about the last 10,000 characters of a transcript, and says when it has left
  something out.
- **Test coverage.** Per the CoS README, the orchestrator read path was checked against a live AG. The
  write path (start, stop, send, approve) is unit-tested against a mocked server only.

---

## 8. Running and checking it locally

```bash
# 1. Agent Grid (prints a URL with the token, and writes ~/.agentgrid/web.json)
cd ~/AgentGrid && python3 -m agentgrid --web        # or: ag --web

# 2. Chief of Staff: the menubar app starts its own server, or run it in a browser:
cd ~/Desktop/chief-of-staff && npm run cos -- ui

# 3. Check the connection from a terminal
npm run cos -- agents            # sessions, as the assistant sees them
npm run cos -- agents --follow   # live status changes from /api/events
npm run cos -- orchestrators     # orchestrators and their status
npm run cos -- access            # what it may do by itself
```

**When something goes wrong:**

| Symptom | Likely cause | Fix |
|---|---|---|
| "Agent Grid hasn't shared its connection yet" | No `~/.agentgrid/web.json` | Start AG. Restart it once after updating, so it writes the file. |
| "Agent Grid rejected the key" | AG restarted, and the file names an old token | Restart AG, or check `web.json` names the running instance. |
| "…can't do orchestrators yet" / "…has no event stream" | AG is older than CoS expects | `git pull` in `~/AgentGrid` and restart it. |
| "Agent Grid access is off" | `cos access agents off` | `cos access agents ask`. |
| "That directory is not one of the known projects" | AG's spawn boundary | Add the folder in AG, or let CoS pass the folder so it adds it. |
| "Connect OpenRouter in Providers…" | No OpenRouter key in AG | Add it in AG's Providers. |
| No finish announcements | Watcher paused | Look in `~/.cos/logs/menubar-server.log` for "agent watch paused: …". |

**Tests that cover the integration:**

- CoS (Vitest, fake `fetch`, no real AG needed): `tests/agentgrid.test.ts`, `tests/agentwatch.test.ts`,
  `tests/gridboard.test.ts`. Run with `npm test`.
- AG (`python3 -m unittest discover -s tests -v`): `tests/test_events.py`,
  `tests/test_connection_file.py`, `tests/test_orchestrator.py`, `tests/test_personas.py`,
  `tests/test_tickets.py`, `tests/test_areas.py`.

---

## 9. File index

**Chief of Staff** (`~/Desktop/chief-of-staff`)

| File | Read it for |
|---|---|
| `src/actions/agentgrid.ts` | The whole AG client: connection, HTTP calls, SSE parser, formatters, model matching |
| `src/actions/agentwatch.ts` | Listening for finishes, reconnects, dedupe |
| `src/actions/gridboard.ts` | Joining areas, agents and tickets, and parsing spoken statuses and ids |
| `src/actions/tickets.ts` | Planning, then performing, ticket changes |
| `src/actions/pending.ts`, `perform.ts`, `access.ts`, `consent.ts` | The OK machinery |
| `src/brain/tools.ts` | Tool definitions and what each one does |
| `src/brain/loop.ts` | The tool-use loop |
| `src/brain/conversation.ts` | Chat storage and `event` turns |
| `src/ui/server.ts` | The local API, `/api/pill`, `/api/grid`, and starting the watcher |
| `src/ui/web/app.js` | The pill page and `window.cosShell` |
| `apps/menubar/Sources/ChiefOfStaff/AppDelegate.swift`, `ServerManager.swift`, `PillPanel.swift` | The native shell |
| `src/cli/cos.ts` | `cos agents`, `cos orchestrators`, `cos access`, `cos ui` |

**Agent Grid** (`~/AgentGrid`)

| File | Read it for |
|---|---|
| `agentgrid/web.py` | HTTP server, token check, routes, `Fleet`, `EventHub`, `launch_agent`, `spawn_agent`, `ServerHost`, `web.json` |
| `agentgrid/discovery.py` | Finding sessions and the status model |
| `agentgrid/chat.py` | Headless chat turns with `claude -p --resume` / `codex exec resume` |
| `agentgrid/transcript.py` | Turning transcripts into blocks |
| `agentgrid/areas.py`, `tickets.py`, `ticket_cli.py` | Work areas, the ticket board, and the agents' `ag ticket` CLI |
| `agentgrid/orchestrator.py`, `personas.py` | Orchestrator and persona data |
| `agentgrid/orchestrator_run.py`, `orchestrator_brief.py`, `openrouter.py` | The orchestrator loop, its prompt and menu, and the model call |
| `hooks/agentgrid_notify.py` | The Claude Code hook that flags sessions waiting on you |
| `README.md` ("Events for another program", "Orchestrators", "Security") | AG's own explanations of these designs |
