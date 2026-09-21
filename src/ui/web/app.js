/* The pill + brief page. Plain JS, talks to the local server.
 * In a browser it is a full page. Hosted by the native shell (?shell=1) it is a
 * transparent strip anchored at the bottom of the screen, and the shell drives
 * it through window.cosShell (hotkeys, native listening). */
const { $, el, get, post } = window.cosDom;
const params = new URLSearchParams(location.search);
const SHELL = params.get("shell") === "1" && Boolean(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.shell);
const root = document.documentElement;
root.dataset.shell = SHELL ? "1" : "0";
root.dataset.view = params.get("mode") || (SHELL ? "pill" : "full"); // pill | brief | full

const pill = $("pill");
const input = $("pill-input");
const status = $("pill-status");
const mic = $("mic");
let brief = null;
let briefStale = false;
let offline = false;
let inputMode = "auto"; // auto | ask | capture

function toShell(msg) {
  if (SHELL) window.webkit.messageHandlers.shell.postMessage(msg);
}

// ---------- the pill's state machine: idle | listening | thinking | speaking ----------
/** `tone` marks the status text as a failure ("error") worth noticing, or "" for routine text. */
function setState(state, text = "", tone = "") {
  pill.dataset.state = state;
  pill.dataset.notice = tone;
  status.textContent = text;
  toShell({ type: "state", value: state });
  if (state === "idle") input.focus();
  const talking = state === "listening";
  mic.title = talking ? "Stop and send (or tap Control twice)" : "Talk (or tap Control twice)";
  mic.setAttribute("aria-label", talking ? "Stop and send" : "Talk");
}

/** A status message that clears itself after `ms`, without stepping on a state change made meanwhile. */
function noticeThenClear(text, tone, ms) {
  setState("idle", text, tone);
  setTimeout(() => {
    if (pill.dataset.state === "idle" && status.textContent === text) {
      status.textContent = "";
      pill.dataset.notice = "";
    }
  }, ms);
}

// ---------- render ----------
function renderBrief(data) {
  brief = data.brief;
  offline = Boolean(data.offline);
  briefStale = false;
  $("btn-refresh").classList.remove("chip-accent");
  $("greeting").textContent = brief.greeting;
  $("headline").textContent = brief.headline;

  const focus = $("focus");
  focus.replaceChildren();
  if (!brief.focus.length) focus.append(el("li", { class: "empty" }, "Nothing ranked yet. Give a project a next action."));
  for (const f of brief.focus) {
    const meta = [f.project, f.why, f.when].filter(Boolean).join(" · ");
    focus.append(
      el("li", {},
        el("span", { class: "dot" }),
        el("div", {}, el("div", { class: "title" }, f.title), el("div", { class: "why" }, meta)),
        el("span", { class: "size" }, `~ ${f.size}`)),
    );
  }

  const schedule = $("schedule");
  schedule.replaceChildren();
  if (!brief.schedule.length) schedule.append(el("li", { class: "empty" }, "Nothing on the calendar. The day is free."));
  for (const s of brief.schedule) {
    schedule.append(
      el("li", { class: s.free ? "free" : "" },
        el("span", { class: "time" }, `${s.start}–${s.end}`),
        el("span", {}, s.free ? "Free block" : s.title, s.free && s.plan ? el("span", { class: "plan" }, `  → ${s.plan}`) : "")),
    );
  }

  const upcoming = $("upcoming");
  upcoming.replaceChildren();
  const coming = brief.upcoming || [];
  $("upcoming-wrap").hidden = !coming.length;
  for (const u of coming) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(u.date)
      ? new Date(`${u.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : u.date;
    upcoming.append(el("li", {}, el("span", { class: "day" }, day), el("span", { class: "time" }, u.time), el("span", {}, u.title)));
  }

  const decisions = $("decisions");
  decisions.replaceChildren();
  $("decisions-wrap").hidden = !brief.decisions.length;
  for (const d of brief.decisions) {
    const opts = el("div", { class: "opts" });
    decisions.append(el("li", {}, el("div", { class: "q" }, d.question), el("div", { class: "reason" }, d.reason), opts));
    for (const o of d.options) {
      opts.append(el("button", {
        class: `chip ${o === "keep" ? "chip-keep" : o === "kill" ? "chip-kill" : ""}`,
        onclick: async () => {
          for (const b of opts.querySelectorAll("button")) b.disabled = true;
          const r = await post("/api/decide", { project: d.project, choice: o });
          opts.replaceWith(el("div", { class: "done" }, r.message || r.error));
          briefStale = true;
        },
      }, o[0].toUpperCase() + o.slice(1)));
    }
  }

  const reminders = $("reminders");
  reminders.replaceChildren();
  $("reminders-wrap").hidden = !brief.reminders.length;
  for (const r of brief.reminders) reminders.append(el("li", { class: r.overdue ? "overdue" : "" }, el("time", {}, r.date), r.text));

  const nudges = $("nudges");
  nudges.replaceChildren();
  $("nudges-wrap").hidden = !brief.nudges.length;
  for (const n of brief.nudges) nudges.append(el("li", {}, n));

  $("source").textContent = `${data.source}${offline ? " · no API key yet: add one under ✦ › API keys" : ""} · ${data.today}`;
  $("panel").dataset.speech = data.speech;
}

async function loadBrief(refresh = false) {
  $("headline").textContent = refresh ? "Rebuilding the brief…" : "Loading…";
  try {
    renderBrief(await get(`/api/brief${refresh ? "?refresh=1" : ""}`));
  } catch (err) {
    $("greeting").textContent = "Could not load the brief";
    $("headline").textContent = String(err);
  }
}

function markStale() {
  briefStale = true;
  $("btn-refresh").classList.add("chip-accent");
  // Rules are instant, so refresh right away when offline; a model rebuild waits for the button.
  if (offline && root.dataset.view !== "pill") loadBrief(true);
}

/**
 * Speak, and resolve { cued } only if it played to the end (not stopped, dismissed or talked over), else null.
 * In a conversation, cues.start asks for a quiet cue as the voice begins and cues.turn for a chime after
 * the last word. The server plays them in line with the voice, so this resolves after the chime has ended.
 */
async function speakText(text, cues = {}) {
  if (liveMode.active) liveMode.stop();
  if (!text) return null;
  setState("speaking", "Reading it to you…");
  let spoken = null;
  let result = null;
  try {
    result = await post("/api/speak", { text, cues });
    if (!result.stopped && !result.error && !result.muted && pill.dataset.state === "speaking") spoken = { cued: result.cued || [] };
  } catch {
    result = null; // couldn't even reach the app
  } finally {
    if (pill.dataset.state === "speaking") {
      const notice = cosVoiceStatus.forSpeakResult(result);
      if (notice) noticeThenClear(notice.text, notice.tone, 5000);
      else setState("idle");
    }
  }
  return spoken;
}

// ---------- hands-free follow-ups ----------
// After a spoken reply the mic opens again for the answer. It closes if nothing is said
// in FOLLOW_UP_WAIT_MS, on Esc, or when the reply is only "thanks" / "that's all".
const FOLLOW_UP_WAIT_MS = 8000;
// The whole reply must be a sign-off. A bare "ok" or "perfect" can mean yes, so those only count before one.
const CLOSER = String.raw`(?:(?:no,?\s*)?thanks?(?: you)?(?: so much)?|thank you|that(?:['’]?s| is) (?:all|it)|never ?mind|nothing(?: else)?|stop|bye|goodbye|all good|i['’]?m good|we['’]?re (?:done|good))`;
const DONE_TALKING = new RegExp(String.raw`^(?:(?:ok(?:ay)?|great|perfect|cool|got it)[,.!]?\s+)?${CLOSER}(?:[,.!]?\s*(?:and\s+)?${CLOSER})*(?:\s+for now)?[.!]*$`, "i");
let followUp = false;
let followUpTimer = null;

/** spoken: what speakText returned. After the turn chime the voice is long over, so the mic opens almost at once. */
function listenForReply(spoken) {
  followUp = true;
  // A short gap so the mic doesn't catch the end of the voice or chime; Esc or typing in the gap wins.
  const gap = spoken && spoken.cued.includes("turn") ? 120 : 300;
  followUpTimer = setTimeout(() => {
    if (!followUp || pill.dataset.state !== "idle" || input.value) return endFollowUp();
    if (SHELL) toShell({ type: "listen" });
    else browserListen();
  }, gap);
}

function endFollowUp() {
  followUp = false;
  clearTimeout(followUpTimer);
  followUpTimer = null;
}

async function stopSpeaking() {
  await post("/api/speak/stop", {});
  setState("idle");
}

// ---------- replies: a little markdown, built as DOM nodes (never innerHTML) ----------
function openLink(url) {
  if (!/^https?:\/\//i.test(url)) return;
  if (SHELL) toShell({ type: "open", url });
  else window.open(url, "_blank", "noopener");
}

function inline(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g;
  let last = 0;
  let m;
  const link = (label, url) => el("a", { href: url, onclick: (e) => { e.preventDefault(); openLink(url); } }, label);
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(el("strong", {}, ...inline(m[1])));
    else if (m[2] !== undefined) out.push(el("code", {}, m[2]));
    else if (m[3] !== undefined) out.push(link(m[3], m[4]));
    else if (m[5] !== undefined) out.push(link(m[5], m[5]));
    else out.push(m[6], el("em", {}, m[7]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let list = null;
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const p = el("p");
    para.forEach((l, i) => (i ? p.append(el("br"), ...inline(l)) : p.append(...inline(l))));
    frag.append(p);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      list = null;
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      frag.append(el("pre", {}, code.join("\n")));
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const num = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || num) {
      flush();
      const tag = bullet ? "UL" : "OL";
      if (!list || list.tagName !== tag) {
        list = el(tag.toLowerCase());
        if (num && num[1] !== "1") list.setAttribute("start", num[1]);
        frag.append(list);
      }
      list.append(el("li", {}, ...inline(bullet ? bullet[1] : num[2])));
      continue;
    }
    if (!line.trim()) {
      flush();
      list = null;
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.lastElementChild.append(el("br"), ...inline(line.trim()));
      continue;
    }
    list = null;
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      frag.append(el("p", {}, el("strong", {}, ...inline(heading[1]))));
    } else para.push(line);
  }
  flush();
  return frag;
}

// ---------- the conversation ----------
const thread = $("thread");

// Hiding the chat keeps it out of the way until you bring it back; it's remembered across summons.
const HIDE_CHAT = /^(?:please\s+)?(?:hide|close|collapse|minimi[sz]e|put away)\s+(?:the\s+|this\s+)?(?:chat|conversation|thread)[.!]*$/i;
const SHOW_CHAT = /^(?:please\s+)?(?:show|open|bring back|expand)\s+(?:the\s+|me the\s+)?(?:chat|conversation|thread)[.!]*$/i;
// Chats by voice: "new chat", "show my chats", "go back to the module 6 chat", "switch to the chat about Campuswire".
const NEW_CHAT = /^(?:please\s+)?(?:(?:start|open|begin|make|create|go to)\s+(?:a\s+|the\s+)?)?(?:new|fresh)\s+(?:chat|conversation|thread)[.!]*$/i;
const LIST_CHATS = /^(?:please\s+)?(?:show|open|list|see)\s+(?:me\s+)?(?:my\s+|the\s+|all\s+)?(?:(?:old|past|previous|other|earlier|saved)\s+)?(?:(?:my\s+)?chats|conversations|threads|chat history|conversation history)[.!?]*$/i;
const SWITCH_CHAT = /^(?:please\s+)?(?:(?:go|switch|jump|move|get)\s+(?:back\s+)?to|back to|open|continue|resume|pull up|bring up)\s+(?:the\s+|my\s+|our\s+)?(?:(?:chat|conversation|thread)\s+(?:about|on|for|called|named|where)\s+(.+?)|(.+?)\s+(?:chat|conversation|thread))[.!?]*$/i;
let chatHidden = localStorage.getItem("cos.chatHidden") === "1";

// ---------- compact: the pill as a small, see-through mic ----------
// Kept across summons. Typing still works: the text field keeps focus while compact, so starting to type
// (⌥Space, then type) opens the full bar for this time; it's compact again the next time the pill is summoned.
const COMPACT_PILL = /^(?:please\s+)?(?:(?:(?:switch to|go|use)\s+)?(?:compact|mic[ -]only)(?:\s+(?:mode|view|pill|bar))?|make (?:it|the (?:pill|bar)) (?:smaller|compact|mic[ -]only))[.!]*$/i;
const FULL_PILL = /^(?:please\s+)?(?:(?:(?:switch to|go|use)\s+)?(?:full|typing|expanded|big)\s+(?:mode|view|pill|bar)|expand(?:\s+(?:the\s+)?(?:pill|bar))?)[.!]*$/i;
let pillCompact = localStorage.getItem("cos.pillCompact") === "1";
let typingOpen = false;

function setPillCompact(compact) {
  pillCompact = compact;
  typingOpen = false;
  localStorage.setItem("cos.pillCompact", compact ? "1" : "0");
  applyPillSize();
}

function applyPillSize() {
  const compact = pillCompact && !typingOpen;
  root.dataset.pill = compact ? "compact" : "full";
  const size = $("pill-size");
  size.title = compact ? "Expand to type" : "Compact: just the mic";
  size.setAttribute("aria-label", size.title);
}

function setChatHidden(hidden) {
  chatHidden = hidden;
  localStorage.setItem("cos.chatHidden", hidden ? "1" : "0");
  root.dataset.chat = hidden ? "hidden" : "shown";
  if (!hidden) $("show-chat").classList.remove("unread");
  updateShowChat();
  if (!hidden) scrollThread();
}

/**
 * The pill's chat button: "chat" while the chat is hidden and has something in it; "chats" when
 * this chat is still empty but there are others to go back to (the card isn't showing, so it's the way in).
 */
function updateShowChat() {
  const btn = $("show-chat");
  const empty = !thread.children.length;
  if (chatHidden && !empty) {
    btn.hidden = false;
    btn.textContent = "▴ chat";
    btn.dataset.action = "show";
  } else if (empty && otherChats && !listOpen) {
    btn.hidden = false;
    btn.textContent = "▴ chats";
    btn.dataset.action = "list";
    btn.classList.remove("unread");
  } else btn.hidden = true;
}
let conversationId = null;
let otherChats = false;
let listOpen = false;
// An aside ("Darius, by the way…"): a quick side exchange the main chat never sees, thrown away on "back on topic".
let inAside = false;
let busy = false;
let lastReply = "";

function scrollThread() {
  thread.scrollTop = thread.scrollHeight;
  if (!SHELL) $("answer").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function confirmButtons(items, said = "") {
  const box = el("div", { class: "answer-actions" });
  for (const item of items) {
    const verb = item.verb || "Open";
    const detail = item.detail || item.url || "";
    // Always show exactly what will happen, once: the address, or the whole command or task.
    if (detail && !said.includes(detail.replace(/\/$/, ""))) box.append(el(item.kind === "open" || !item.kind ? "div" : "pre", { class: item.kind === "open" || !item.kind ? "url" : "detail" }, detail));
    const decide = async (cancel) => {
      for (const b of box.querySelectorAll("button")) b.disabled = true;
      if (!cancel && item.kind === "command") status.textContent = "Running it…";
      const r = await post("/api/actions/confirm", { id: item.id, cancel });
      if (pill.dataset.state === "idle") status.textContent = "";
      box.replaceChildren(el(item.kind === "command" ? "pre" : "div", { class: item.kind === "command" ? "detail" : "url" }, r.text || r.error || ""));
      scrollThread();
    };
    const label = verb === "Open" && !(item.label.length > 40 || /^https?:/i.test(item.label)) ? `Open ${item.label}` : verb;
    box.append(
      el("button", { class: "chip chip-keep", onclick: () => decide(false) }, label),
      el("button", { class: "chip", onclick: () => decide(true) }, "Cancel"),
    );
  }
  return box;
}

/** A small note under what they said: the screen went with it. */
function markLooked(node, screen) {
  if (node.querySelector(".looked")) return;
  node.append(el("span", { class: "looked" }, `looked at your screen${screen.app ? ` · ${screen.app}` : ""}`));
}

/** The window that shows one picture or page full size, with the buttons to save it. */
function openArtifact(id) {
  openLink(new URL(`/artifact.html?id=${encodeURIComponent(id)}`, location.href).href);
}

/**
 * What a reply made, shown under it: the picture itself, or the top of the page as it will look.
 * Both open full size; the preview is a picture of the page, so nothing in it can be clicked.
 */
function artifactCards(items) {
  const box = el("div", { class: "artifacts" });
  for (const a of items) {
    const open = () => openArtifact(a.id);
    const url = `/artifacts/${encodeURIComponent(a.id)}`;
    box.append(
      el("figure", { class: `artifact ${a.kind}` },
        a.kind === "image"
          ? el("img", { src: url, alt: a.title, onclick: open })
          : el("div", { class: "page-preview", onclick: open }, el("iframe", { src: url, sandbox: "allow-scripts", title: a.title, tabindex: "-1" })),
        el("figcaption", {}, el("span", { class: "name" }, a.title), el("button", { class: "chip", onclick: open }, "open"))),
    );
  }
  return box;
}

/** Put a reply (or the text streaming in so far) into an assistant turn. */
function fillTurn(node, turn) {
  node.dataset.kind = turn.kind || "answer";
  node.classList.toggle("pending", Boolean(turn.pending));
  const body = el("div", { class: "body" });
  if (turn.pending && !turn.text) body.append(el("span", { class: "typing" }, el("i"), el("i"), el("i")));
  else body.append(renderMarkdown(turn.text));
  node.replaceChildren(body);
  if (turn.confirm && turn.confirm.length) node.append(confirmButtons(turn.confirm, turn.text));
  if (turn.artifacts && turn.artifacts.length) node.append(artifactCards(turn.artifacts));
}

function addTurn(turn) {
  let node;
  if (turn.role === "user") {
    node = el("div", { class: "turn user" }, turn.text);
    if (turn.screen) markLooked(node, turn.screen);
  }
  else if (turn.role === "event") node = el("div", { class: "turn event" }, turn.text);
  else {
    node = el("div", { class: "turn assistant" });
    fillTurn(node, turn);
    if (!turn.pending) lastReply = turn.text;
  }
  thread.append(node);
  $("answer").hidden = false;
  updateShowChat();
  scrollThread();
  return node;
}

/** The chat's name in the header, whether there are other chats to go back to, and whether this is an aside. */
function showChatInfo(c) {
  currentTitle = c.title || "Chief of staff";
  $("answer-title").textContent = listOpen ? "Your chats" : currentTitle;
  if (typeof c.others === "number") otherChats = c.others > 0;
  if (typeof c.aside === "boolean") {
    inAside = c.aside;
    root.dataset.aside = c.aside ? "1" : "0";
  }
  updateShowChat();
}

function renderThread(c) {
  conversationId = c.id;
  thread.replaceChildren();
  lastReply = "";
  $("answer-model").textContent = "";
  for (const t of c.turns) addTurn(t);
  $("answer").hidden = !c.turns.length && !listOpen;
  showChatInfo(c);
}

/**
 * Show the conversation in progress: after a quiet spell the server has started a new one, and
 * something may have happened in this one since (an agent finished, an action was carried out).
 */
async function syncConversation() {
  if (busy) return;
  try {
    const c = await get("/api/conversation");
    if (busy) return;
    const grew = c.id === conversationId && c.turns.length > thread.childElementCount;
    if (c.id !== conversationId || c.turns.length !== thread.childElementCount) renderThread(c);
    else showChatInfo(c);
    if (grew && chatHidden) $("show-chat").classList.add("unread");
  } catch {
    /* the server is restarting; try again next time */
  }
}

async function newConversation() {
  if (liveMode.active) liveMode.stop();
  if (busy) return;
  closeChats();
  renderThread(await post("/api/conversation/new", {}));
  input.focus();
}

/**
 * "Darius, by the way…": step out of the chat for a quick unrelated exchange. The main chat waits as it
 * is; what's said here is answered on its own and thrown away on "back on topic". A question said in the
 * same breath is asked right away; otherwise, by voice, it says "go ahead" and listens.
 */
async function startAside(question, fromVoice) {
  if (busy) return;
  closeChats();
  let r;
  try {
    r = await post("/api/conversation/aside", {});
  } catch {
    return flash("Couldn't reach the app, so nothing changed.");
  }
  if (r.error) return flash(r.error);
  renderThread(r);
  if (!fromVoice && chatHidden) setChatHidden(false);
  if (question) {
    await send({ text: question, mode: inputMode }, `Aside · “${question}”`, fromVoice);
    return;
  }
  flash("Aside · say “back on topic” to return");
  const spoken = fromVoice && (await speakText("Go ahead.", { turn: true }));
  if (spoken) listenForReply(spoken);
  else if (!fromVoice) input.focus();
}

/** "Darius, back on topic": throw the aside away and pick the main chat up where it was. */
async function endAside(fromVoice) {
  if (busy) return;
  let r;
  try {
    r = await post("/api/conversation/resume", {});
  } catch {
    return flash("Couldn't reach the app, so nothing changed.");
  }
  if (r.error) {
    flash(r.error);
    syncConversation(); // the page thought it was in an aside; the server knows better
    return;
  }
  renderThread(r);
  if (!fromVoice && chatHidden) setChatHidden(false);
  flash(`Back on “${r.title || "topic"}”`);
  const spoken = fromVoice && (await speakText("Back on topic.", { turn: true }));
  if (spoken) listenForReply(spoken);
  else if (!fromVoice) input.focus();
}

// ---------- the list of chats ----------
let chats = [];

function when(iso) {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Every saved chat, most recent first, narrowed by what's typed in the filter (name and preview). */
function renderChats() {
  const list = $("chats-list");
  const q = $("chats-filter").value.trim().toLowerCase();
  const shown = q ? chats.filter((c) => `${c.title}\n${c.preview}`.toLowerCase().includes(q)) : chats;
  list.replaceChildren();
  if (!chats.length) list.append(el("li", { class: "chats-note" }, "No saved chats yet. Everything you say here is kept."));
  else if (!shown.length) list.append(el("li", { class: "chats-note" }, "No chat name matches. Press Enter to search everything said."));
  for (const c of shown) {
    const meta = `${when(c.updatedAt)} · ${c.messages} message${c.messages === 1 ? "" : "s"}${c.current ? " · this chat" : ""}`;
    const open = el("button", { class: "chat-open", type: "button", onclick: () => switchTo({ id: c.id }) },
      el("div", { class: "chat-name" }, c.title),
      el("div", { class: "chat-meta" }, meta),
      c.preview ? el("div", { class: "chat-preview" }, c.preview) : "");
    const row = el("li", { class: `chat-row${c.current ? " current" : ""}` }, open);
    row.append(
      el("button", { class: "chat-action chat-rename", type: "button", title: "Rename", "aria-label": `Rename ${c.title}`, onclick: () => renameChat(row, c) }, "✎"),
      el("button", { class: "chat-action chat-delete", type: "button", title: "Delete", "aria-label": `Delete ${c.title}`, onclick: () => confirmDelete(row, c) }, trashIcon()),
    );
    list.append(row);
  }
  const unreadable = $("chats").dataset.unreadable;
  if (Number(unreadable)) list.append(el("li", { class: "chats-note" }, `${unreadable} saved chat${unreadable === "1" ? "" : "s"} couldn't be read.`));
}

/** A small outline bin, drawn in the text color so it dims and lights like the pencil beside it. */
function trashIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.3");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

/** Ask in the row itself before deleting: Keep is focused, and Esc keeps it. */
function confirmDelete(row, c) {
  const back = () => {
    renderChats();
    $("chats-filter").focus();
  };
  const keep = el("button", { class: "chip", type: "button", onclick: back }, "Keep");
  const remove = el("button", { class: "chip chip-kill", type: "button", onclick: () => deleteChat(c, [keep, remove]) }, "Delete");
  const box = el("div", { class: "chat-confirm", role: "alertdialog", "aria-label": `Delete ${c.title}?` },
    el("div", { class: "chat-confirm-text" },
      el("div", { class: "chat-name" }, `Delete “${c.title}”?`),
      el("div", { class: "chat-meta" }, "It leaves your chats and what the assistant remembers.")),
    el("div", { class: "chat-confirm-buttons" }, keep, remove));
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation(); // Esc keeps the chat, it doesn't close the list or dismiss the pill
    back();
  });
  row.classList.add("confirming");
  row.replaceChildren(box);
  keep.focus();
}

async function deleteChat(c, buttons) {
  if (busy) return flash("Wait for the reply to finish, then delete.");
  for (const b of buttons) b.disabled = true;
  let r;
  try {
    r = await post("/api/conversation/delete", { id: c.id });
  } catch {
    r = { error: "Couldn't reach the app, so nothing was deleted. Try again." };
  }
  const gone = !r.error || r.error === "That chat isn't saved anymore.";
  if (!gone) {
    renderChats();
    return flash(r.error);
  }
  chats = chats.filter((x) => x.id !== c.id);
  // Deleting the chat in progress leaves a new, empty one behind the list.
  if (r.current) r.current.id === conversationId ? showChatInfo(r.current) : renderThread(r.current);
  renderChats();
  $("chats-filter").focus();
  flash(r.error ? "That chat was already deleted." : `Deleted “${c.title}”`);
}

function renameChat(row, c) {
  const field = el("input", { class: "chat-name-input", type: "text", value: c.title, "aria-label": "Chat name" });
  const done = async (save) => {
    if (!field.isConnected) return;
    if (save && field.value.trim() !== c.title) {
      const r = await post("/api/conversation/rename", { id: c.id, title: field.value });
      if (r.title) {
        c.title = r.title;
        if (c.id === conversationId && !listOpen) $("answer-title").textContent = r.title;
      }
    }
    renderChats();
  };
  field.addEventListener("keydown", (e) => {
    e.stopPropagation(); // Esc cancels the rename, it doesn't dismiss the pill
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
  field.addEventListener("blur", () => done(true));
  row.replaceChildren(field);
  field.focus();
  field.select();
}

async function openChats(focusFilter = true) {
  if (busy) return;
  listOpen = true;
  $("answer").dataset.list = "on";
  $("chats").hidden = false;
  $("answer").hidden = false;
  $("answer-title").textContent = "Your chats";
  if (chatHidden) setChatHidden(false);
  updateShowChat();
  try {
    const r = await get("/api/conversations");
    chats = r.chats || [];
    $("chats").dataset.unreadable = String(r.unreadable || 0);
  } catch {
    chats = [];
  }
  $("chats-filter").value = "";
  renderChats();
  if (focusFilter) $("chats-filter").focus();
}

function closeChats() {
  if (!listOpen) return;
  listOpen = false;
  $("answer").dataset.list = "off";
  $("chats").hidden = true;
  $("answer").hidden = !thread.children.length;
  $("answer-title").textContent = currentTitle;
  updateShowChat();
}

let currentTitle = "Chief of staff";

/** Pick up a chat by id, or by a few words ("module 6", "the last one"). Null when none matches. */
async function switchTo(which) {
  if (busy) return null;
  let r;
  try {
    r = await post("/api/conversation/open", which);
  } catch {
    return null;
  }
  if (r.error) {
    if (which.id) setState("idle", r.error);
    return null;
  }
  closeChats();
  renderThread(r);
  input.focus();
  return r;
}

/** A short note in the pill that clears itself. */
function flash(text, tone = "") {
  noticeThenClear(text, tone, 4000);
}

/** After a reply, the chat may get its name in the background: show it when it lands. */
function refreshTitleSoon() {
  for (const ms of [4000, 12000]) setTimeout(syncConversation, ms);
}

/** POST and read newline-delimited JSON events as they arrive; returns the final result. */
async function postStream(url, body, onEvent) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, stream: true }) });
  if (!(r.headers.get("content-type") || "").includes("ndjson") || !r.body) return r.json();
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === "done") result = ev.result;
      else if (ev.type === "error") result = { kind: "error", text: ev.error };
      else onEvent(ev);
    }
  }
  return result || { kind: "error", text: "The connection closed before a reply." };
}

async function send(body, thinking, fromVoice = false) {
  if (liveMode.active) liveMode.stop();
  busy = true;
  setState("thinking", thinking);
  let pending = null;
  let live = "";
  const begin = (conversation, user) => {
    if (conversation && conversation !== conversationId) renderThread({ id: conversation, turns: [] });
    if (user) addTurn({ role: "user", text: user });
    pending = addTurn({ role: "assistant", text: "", pending: true });
  };
  let r;
  try {
    r = await postStream("/api/pill", body, (ev) => {
      if (ev.type === "start") begin(ev.conversation, ev.user);
      else if (ev.type === "status") {
        live = "";
        status.textContent = ev.text;
        if (pending) fillTurn(pending, { text: "", pending: true });
      } else if (ev.type === "text" && pending) {
        live += ev.delta;
        fillTurn(pending, { text: live, pending: true });
        scrollThread();
      }
    });
  } catch (err) {
    r = { kind: "error", text: String(err) };
  }
  if (r.error && !r.text) r = { kind: "error", text: r.error };
  if (!pending) begin(r.conversation, r.user);
  fillTurn(pending, r);
  if (r.screen) {
    const users = thread.querySelectorAll(".turn.user");
    if (users.length) markLooked(users[users.length - 1], r.screen);
  }
  lastReply = r.text || "";
  $("answer-model").textContent = r.model && r.model !== "rules" ? `· ${r.model}` : "";
  scrollThread();
  if (chatHidden && r.text) $("show-chat").classList.add("unread");
  // A page is made to be looked at, so it opens full size the moment it exists. A picture is
  // already in the reply and waits to be clicked. In a browser tab a pop-up would be blocked.
  if (SHELL) for (const a of r.artifacts || []) if (a.kind === "page") openArtifact(a.id);
  if (r.changes) markStale();
  if (r.title && r.conversation === conversationId) showChatInfo({ title: r.title });
  refreshTitleSoon();
  busy = false;
  setState("idle");
  // Spoken questions get spoken replies, then a chime and the mic reopens for the answer.
  // Typed ones stay quiet unless you press read aloud. Opening something ends the exchange, so no chime.
  if (!fromVoice || !r.text) return;
  const expectsReply = !["action", "confirm"].includes(r.kind);
  const spoken = await speakText(r.text, { start: true, turn: expectsReply });
  if (spoken && expectsReply) listenForReply(spoken);
}

async function submit(text, fromVoice = false) {
  const t = text.trim();
  if (!t) {
    // A speech-recognition error may have just shown a notice (see rec.onerror): recognition
    // then ends on its own and lands here with nothing said, which shouldn't blank it right away.
    if (pill.dataset.state !== "idle" || !status.textContent) setState("idle");
    return;
  }
  // "Darius, …" in front: what follows is a command ("Darius, new chat") if it reads as one, and an
  // aside or the way back needs the name (or an aside in progress) so ordinary talk is never taken for it.
  // Anything that isn't a command goes to the model as said, name and all.
  const { named, rest: c } = cosCommands.addressed(t);
  const quick = named ? cosCommands.aside(c) : null;
  if (quick !== null) {
    input.value = "";
    await startAside(quick, fromVoice);
    return;
  }
  if ((named || inAside) && cosCommands.backOnTopic(c)) {
    input.value = "";
    await endAside(fromVoice);
    return;
  }
  if (COMPACT_PILL.test(c) || FULL_PILL.test(c)) {
    input.value = "";
    setPillCompact(COMPACT_PILL.test(c));
    setState("idle");
    return;
  }
  if (HIDE_CHAT.test(c) || SHOW_CHAT.test(c)) {
    input.value = "";
    setChatHidden(HIDE_CHAT.test(c));
    setState("idle");
    return;
  }
  if (NEW_CHAT.test(c)) {
    input.value = "";
    await newConversation();
    flash("New chat");
    const spoken = fromVoice && (await speakText("New chat.", { turn: true }));
    if (spoken) listenForReply(spoken);
    return;
  }
  if (LIST_CHATS.test(c)) {
    input.value = "";
    await openChats(!fromVoice);
    setState("idle");
    return;
  }
  const asked = SWITCH_CHAT.exec(c);
  if (asked) {
    const r = await switchTo({ query: asked[1] || asked[2] });
    if (r) {
      input.value = "";
      flash(`Back in “${r.title || "that chat"}”`);
      const spoken = fromVoice && (await speakText(`Back in ${r.title || "that chat"}.`, { turn: true }));
      if (spoken) listenForReply(spoken);
      return;
    }
    // No chat matches: it may mean something else ("open the Slack chat"), so ask as usual.
  }
  if (listOpen) closeChats();
  // A typed question needs its answer on screen; a spoken one is heard, so the chat can stay hidden.
  if (!fromVoice && chatHidden) setChatHidden(false);
  if (fromVoice && DONE_TALKING.test(c)) {
    input.value = "";
    setState("idle");
    toShell({ type: "hide" });
    return;
  }
  input.value = "";
  // Said by name, the words after it are the command the server's rules and Jev read; the model still gets it all.
  await send({ text: t, mode: inputMode, ...(named ? { command: c } : {}) }, fromVoice ? `“${t}”` : "Thinking…", fromVoice);
}

function runFocus(project) {
  return send({ text: project, mode: "focus" }, `Looking at ${project}…`);
}

// Live mode is intentionally session-only: never reopen a room microphone on launch.
let liveStartupTimer = null;
let liveLifetimeTimer = null;
const liveMode = cosLive.create({
  post,
  async onStart(session) {
    endFollowUp();
    await post("/api/speak/stop", {}).catch(() => {});
    if (liveMode.session !== session) return;
    liveLifetimeTimer = setTimeout(() => {
      if (liveMode.session !== session) return;
      liveMode.stop();
      flash("Live session ended after 30 minutes. Turn it on to keep going.");
    }, 30 * 60_000);
    setState("listening", "Starting Live microphone…");
    $("live-toggle").setAttribute("aria-pressed", "true");
    pill.dataset.live = "on";
    toShell({ type: "liveListen", session });
    liveStartupTimer = setTimeout(() => {
      if (liveMode.session !== session) return;
      liveMode.stop();
      noticeThenClear("Live mic didn’t start. Check microphone permissions and use the updated desktop app.", "error", 6000);
    }, 15000);
  },
  onStop() {
    clearTimeout(liveStartupTimer);
    clearTimeout(liveLifetimeTimer);
    $("live-toggle").setAttribute("aria-pressed", "false");
    pill.dataset.live = "off";
    toShell({ type: "stopLive" });
    setState("idle");
  },
  onResult(said, r) {
    if (r.kind === "action") {
      addTurn({ role: "user", text: said });
      addTurn({ role: "assistant", text: r.text, kind: r.kind, model: r.model });
      lastReply = r.text;
      scrollThread();
      if (chatHidden) $("show-chat").classList.add("unread");
    }
    if (r.text?.startsWith("Live session ended")) { liveMode.stop(); flash(r.text); return; }
    setState("listening", r.text || r.error || "Live · listening…", r.kind === "error" ? "error" : "");
    mic.title = "Stop Live mode";
    mic.setAttribute("aria-label", "Stop Live mode");
  },
  onError(text) {
    if (liveMode.active) setState("listening", text, "error");
    else noticeThenClear(text, "error", 6000);
  },
});
$("live-toggle").disabled = !SHELL;
$("live-toggle").title = SHELL ? "Keep listening for apps, sites and folders · Escape to stop" : "Live mode is available in the desktop app";
$("live-toggle").addEventListener("click", async () => {
  if (liveMode.active) return liveMode.stop();
  if (busy) return flash("Wait for the current reply, then turn Live on.");
  endFollowUp();
  toShell({ type: "stopLive" });
  liveMode.start();
});
window.addEventListener("pagehide", () => {
  if (liveMode.session) navigator.sendBeacon("/api/live/stop", JSON.stringify({ session: liveMode.session }));
  toShell({ type: "stopLive" });
});

// ---------- voice in a plain browser (Web Speech API). The native shell listens itself. ----------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function browserListen() {
  if (!Recognition) {
    setState("idle", "No speech recognition in this browser — type instead.");
    return;
  }
  if (rec) {
    rec.stop();
    return;
  }
  rec = new Recognition();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (const res of e.results) res.isFinal ? (finalText += res[0].transcript) : (interim += res[0].transcript);
    status.textContent = `“${finalText || interim}”`;
  };
  // The browser ends recognition by itself after a silence, so follow-ups need no timer here.
  rec.onend = () => {
    rec = null;
    endFollowUp();
    submit(finalText, true);
  };
  rec.onerror = (e) => {
    rec = null;
    endFollowUp();
    const notice = cosVoiceStatus.forSpeechError(e.error);
    if (notice) noticeThenClear(notice.text, notice.tone, 5000);
    else setState("idle");
  };
  if (pill.dataset.state === "speaking") post("/api/speak/stop", {});
  setState("listening", followUp ? "Your turn…" : "Listening…");
  rec.start();
}

function micPressed() {
  if (liveMode.active) return liveMode.stop();
  if (SHELL) toShell({ type: pill.dataset.state === "listening" ? "stopListen" : "listen" });
  else browserListen();
}

function setView(view) {
  if (view === "brief" && liveMode.active) liveMode.stop();
  root.dataset.view = view;
  if (view === "brief" && (!brief || briefStale)) loadBrief(briefStale);
}

// ---------- the bridge the native shell calls ----------
window.cosShell = {
  stopLive() { liveMode.stop(); },
  liveListening(session) {
    if (liveMode.session !== session) return;
    clearTimeout(liveStartupTimer);
    setState("listening", "Live · say an open command…");
    mic.title = "Stop Live mode";
    mic.setAttribute("aria-label", "Stop Live mode");
  },
  liveStopped(session) { if (liveMode.session === session) liveMode.stop(); },
  livePhrase(text, session, sequence) {
    if (liveMode.session !== session) return;
    const { rest } = cosCommands.addressed(text);
    if (/^(?:stop(?: listening)?|(?:turn )?(?:live(?: mode)? )?off|stop live(?: mode)?)[.!]*$/i.test(rest.trim())) return liveMode.stop();
    liveMode.phrase(rest, session, sequence);
  },
  focus() {
    input.focus();
    syncConversation();
  },
  setMode(view) {
    setView(view);
    input.focus();
  },
  listening(on) {
    if (!on) {
      endFollowUp();
      if (pill.dataset.state === "listening") setState("idle");
      return;
    }
    // Talking over a reply stops it, so the mic doesn't hear the voice.
    if (pill.dataset.state === "speaking") post("/api/speak/stop", {});
    setState("listening", followUp ? "Your turn…" : "Listening…");
    if (followUp) {
      clearTimeout(followUpTimer);
      followUpTimer = setTimeout(() => {
        if (followUp && pill.dataset.state === "listening") toShell({ type: "stopListen" });
      }, FOLLOW_UP_WAIT_MS);
    }
  },
  transcript(text, final) {
    if (liveMode.active) {
      if (!final) status.textContent = text.trim() ? `Live · “${text}”` : "Live · listening…";
      return;
    }
    // Once they start talking, the shell's pause detection decides when they're done.
    if (text.trim()) clearTimeout(followUpTimer);
    if (!final) {
      status.textContent = `“${text}”`;
      return;
    }
    endFollowUp();
    submit(text, true);
  },
  status(text, isError = false) {
    if (isError && liveMode.active) liveMode.stop();
    endFollowUp();
    noticeThenClear(text, isError ? "error" : "", 5000);
  },
  reload() {
    loadBrief(false);
  },
  focusProject(name) {
    runFocus(name);
  },
  /** Hide for now; the conversation stays and is there next time. */
  dismiss() {
    if (liveMode.active) liveMode.stop();
    endFollowUp();
    if (typingOpen) {
      typingOpen = false;
      applyPillSize();
    }
    if (pill.dataset.state === "speaking") post("/api/speak/stop", {});
    input.value = "";
    setState("idle");
  },
};

// ---------- wiring ----------
pill.addEventListener("submit", (e) => {
  e.preventDefault();
  submit(input.value);
});
$("mic").addEventListener("click", micPressed);
$("stop").addEventListener("click", stopSpeaking);
// The menubar icon can be hidden beside the notch; this opens the same menu from the pill.
$("menu-btn").addEventListener("click", () => toShell({ type: "menu" }));
$("btn-refresh").addEventListener("click", () => loadBrief(true));
$("btn-speak").addEventListener("click", () => speakText($("panel").dataset.speech || ""));
$("answer-speak").addEventListener("click", () => speakText(lastReply));
$("new-chat").addEventListener("click", newConversation);
$("chats-btn").addEventListener("click", () => (listOpen ? closeChats() : openChats()));
$("answer-title").addEventListener("click", () => (listOpen ? closeChats() : openChats()));
$("chats-filter").addEventListener("input", renderChats);
$("chats-filter").addEventListener("keydown", async (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeChats();
    input.focus();
  }
  if (e.key !== "Enter") return;
  const q = $("chats-filter").value.trim();
  if (!q) return;
  // Enter searches everything said in every chat, not just the names shown.
  if (!(await switchTo({ query: q }))) {
    $("chats-list").prepend(el("li", { class: "chats-note" }, `Nothing said in any chat matches “${q}”.`));
  }
});
$("hide-chat").addEventListener("click", () => setChatHidden(true));
$("pill-size").addEventListener("click", () => {
  const expand = root.dataset.pill === "compact";
  setPillCompact(!expand);
  if (expand) input.focus();
});
// Typing while compact opens the full bar, with what's been typed so far.
input.addEventListener("input", () => {
  if (!pillCompact || typingOpen || !input.value) return;
  typingOpen = true;
  applyPillSize();
});
applyPillSize();
$("show-chat").addEventListener("click", () => ($("show-chat").dataset.action === "list" ? openChats() : setChatHidden(false)));
setChatHidden(chatHidden);
$("mode").addEventListener("click", () => {
  inputMode = inputMode === "auto" ? "ask" : inputMode === "ask" ? "capture" : "auto";
  $("mode").textContent = inputMode;
  input.placeholder = inputMode === "capture" ? "Tell me something to file…" : "Ask anything…";
});

let lastShift = 0;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    input.focus();
  }
  if (e.metaKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newConversation();
  }
  if (e.metaKey && e.key.toLowerCase() === "y") {
    e.preventDefault();
    listOpen ? closeChats() : openChats();
  }
  if (e.key === "Escape") {
    window.cosShell.dismiss();
    if (rec) rec.abort();
    toShell({ type: "hide" });
  }
  // In a browser there is no global Fn hook; double-tap Shift starts listening instead.
  if (!SHELL && e.key === "Shift") {
    const now = Date.now();
    if (now - lastShift < 350) browserListen();
    lastShift = now;
  }
});

// ---------- moving it: drag the bar or the chat's header ----------
// In the app the window follows the drag, stays on screen, and is summoned to the same spot next time;
// in a browser the page's content moves and the spot is kept for this browser. A press that moves less
// than a few pixels is still a click (the mic, the title, a chip). Double-click the header or the bar's
// background to put it back (the chat may be hidden, so the bar needs its own way).
const DRAG_THRESHOLD = 4;
let placedAt = SHELL ? null : JSON.parse(localStorage.getItem("cos.placement") || "null");

/** In a browser: the card and the bar move by the same amount, each on its own (the bar is fixed to the window). */
function applyPlacement() {
  if (SHELL) return;
  $("answer").style.transform = placedAt ? `translate(${placedAt.x}px, ${placedAt.y}px)` : "";
  $("pill").style.transform = placedAt ? `translate(calc(-50% + ${placedAt.x}px), ${placedAt.y}px)` : "";
}

function startDrag(e) {
  if (e.button !== 0 || e.target.closest("input, textarea")) return;
  const start = { x: e.screenX, y: e.screenY };
  let last = start;
  let dragging = false;
  const move = (ev) => {
    if (!dragging) {
      if (Math.hypot(ev.screenX - start.x, ev.screenY - start.y) < DRAG_THRESHOLD) return;
      dragging = true;
      root.dataset.dragging = "1";
    }
    // Screen coordinates, so the window moving under the pointer doesn't count as the pointer moving.
    const dx = ev.screenX - last.x;
    const dy = ev.screenY - last.y;
    last = { x: ev.screenX, y: ev.screenY };
    if (!dx && !dy) return;
    if (SHELL) toShell({ type: "move", dx, dy });
    else {
      placedAt = { x: (placedAt?.x || 0) + dx, y: (placedAt?.y || 0) + dy };
      applyPlacement();
    }
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (!dragging) return;
    delete root.dataset.dragging;
    if (SHELL) toShell({ type: "placed" });
    else localStorage.setItem("cos.placement", JSON.stringify(placedAt));
    // The press that dragged isn't also a click on the button it started on.
    const swallow = (c) => {
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener("click", swallow, true);
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function resetPlacement(e) {
  if (e.target.closest("button, input, textarea, #answer-title")) return;
  if (SHELL) toShell({ type: "unplace" });
  else {
    placedAt = null;
    localStorage.removeItem("cos.placement");
    applyPlacement();
  }
  flash("Back at the bottom");
}

$("pill").addEventListener("pointerdown", startDrag);
$("pill").addEventListener("dblclick", resetPlacement);
document.querySelector(".answer-head").addEventListener("pointerdown", startDrag);
document.querySelector(".answer-head").addEventListener("dblclick", resetPlacement);
applyPlacement();

// The shell sizes its window to the content, so report the height whenever it changes.
if (SHELL) {
  const stage = document.querySelector(".stage");
  new ResizeObserver(() => toShell({ type: "height", value: Math.ceil(stage.getBoundingClientRect().height) })).observe(stage);
}

setState("idle");
loadBrief();
syncConversation();
// The name it answers to (cos voice name), so "Darius, new chat" is heard as a command.
get("/api/voice")
  .then((v) => v.wakeName && cosCommands.setName(v.wakeName))
  .catch(() => undefined);
// Keep it current while it sits open: an agent may finish, or an action land, between messages.
setInterval(syncConversation, 20_000);
