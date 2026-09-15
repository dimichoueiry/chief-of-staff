/* The pill + brief page. Plain JS, talks to the local server.
 * In a browser it is a full page. Hosted by the native shell (?shell=1) it is a
 * transparent strip anchored at the bottom of the screen, and the shell drives
 * it through window.cosShell (hotkeys, native listening). */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SHELL = params.get("shell") === "1" && Boolean(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.shell);
const root = document.documentElement;
root.dataset.shell = SHELL ? "1" : "0";
root.dataset.view = params.get("mode") || (SHELL ? "pill" : "full"); // pill | brief | full

const pill = $("pill");
const input = $("pill-input");
const status = $("pill-status");
let brief = null;
let briefStale = false;
let offline = false;
let inputMode = "auto"; // auto | ask | capture

function toShell(msg) {
  if (SHELL) window.webkit.messageHandlers.shell.postMessage(msg);
}

// ---------- the pill's state machine: idle | listening | thinking | speaking ----------
function setState(state, text = "") {
  pill.dataset.state = state;
  status.textContent = text;
  toShell({ type: "state", value: state });
  if (state === "idle") input.focus();
}

// ---------- render ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
}

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

  $("source").textContent = `${data.source}${offline ? " · no model key: questions and focus need one" : ""} · ${data.today}`;
  $("panel").dataset.speech = data.speech;
}

// ---------- network ----------
async function get(url) {
  const r = await fetch(url);
  return r.json();
}
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
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

/** Speak, and resolve true only if it played to the end (not stopped, dismissed or talked over). */
async function speakText(text) {
  if (!text) return false;
  setState("speaking", "Reading it to you…");
  let finished = false;
  try {
    const r = await post("/api/speak", { text });
    finished = !r.stopped && !r.error && pill.dataset.state === "speaking";
  } catch {
    /* no voice this time */
  } finally {
    if (pill.dataset.state === "speaking") setState("idle");
  }
  return finished;
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

function listenForReply() {
  followUp = true;
  // A short gap so the mic doesn't catch the end of the voice; Esc or typing in the gap wins.
  followUpTimer = setTimeout(() => {
    if (!followUp || pill.dataset.state !== "idle" || input.value) return endFollowUp();
    if (SHELL) toShell({ type: "listen" });
    else browserListen();
  }, 300);
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
let conversationId = null;
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

/** Put a reply (or the text streaming in so far) into an assistant turn. */
function fillTurn(node, turn) {
  node.dataset.kind = turn.kind || "answer";
  node.classList.toggle("pending", Boolean(turn.pending));
  const body = el("div", { class: "body" });
  if (turn.pending && !turn.text) body.append(el("span", { class: "typing" }, el("i"), el("i"), el("i")));
  else body.append(renderMarkdown(turn.text));
  node.replaceChildren(body);
  if (turn.confirm && turn.confirm.length) node.append(confirmButtons(turn.confirm, turn.text));
}

function addTurn(turn) {
  let node;
  if (turn.role === "user") node = el("div", { class: "turn user" }, turn.text);
  else if (turn.role === "event") node = el("div", { class: "turn event" }, turn.text);
  else {
    node = el("div", { class: "turn assistant" });
    fillTurn(node, turn);
    if (!turn.pending) lastReply = turn.text;
  }
  thread.append(node);
  $("answer").hidden = false;
  scrollThread();
  return node;
}

function renderThread(c) {
  conversationId = c.id;
  thread.replaceChildren();
  lastReply = "";
  $("answer-model").textContent = "";
  for (const t of c.turns) addTurn(t);
  $("answer").hidden = !c.turns.length;
}

/** Show the conversation in progress; after a quiet spell the server has started a new one. */
async function syncConversation() {
  if (busy) return;
  try {
    const c = await get("/api/conversation");
    if (!busy && c.id !== conversationId) renderThread(c);
  } catch {
    /* the server is restarting; try again next time */
  }
}

async function newConversation() {
  if (busy) return;
  renderThread(await post("/api/conversation/new", {}));
  input.focus();
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
  lastReply = r.text || "";
  $("answer-model").textContent = r.model && r.model !== "rules" ? `· ${r.model}` : "";
  scrollThread();
  if (r.changes) markStale();
  busy = false;
  setState("idle");
  // Spoken questions get spoken replies, then the mic reopens for the answer.
  // Typed ones stay quiet unless you press read aloud. Opening something ends the exchange.
  if (fromVoice && r.text && (await speakText(r.text)) && !["action", "confirm"].includes(r.kind)) listenForReply();
}

async function submit(text, fromVoice = false) {
  const t = text.trim();
  if (!t) {
    setState("idle");
    return;
  }
  if (fromVoice && DONE_TALKING.test(t)) {
    input.value = "";
    setState("idle");
    toShell({ type: "hide" });
    return;
  }
  input.value = "";
  await send({ text: t, mode: inputMode }, fromVoice ? `“${t}”` : "Thinking…", fromVoice);
}

function runFocus(project) {
  return send({ text: project, mode: "focus" }, `Looking at ${project}…`);
}

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
  rec.onerror = () => {
    rec = null;
    endFollowUp();
    setState("idle");
  };
  if (pill.dataset.state === "speaking") post("/api/speak/stop", {});
  setState("listening", followUp ? "Your turn…" : "Listening…");
  rec.start();
}

function micPressed() {
  if (SHELL) toShell({ type: pill.dataset.state === "listening" ? "stopListen" : "listen" });
  else browserListen();
}

function setView(view) {
  root.dataset.view = view;
  if (view === "brief" && (!brief || briefStale)) loadBrief(briefStale);
}

// ---------- the bridge the native shell calls ----------
window.cosShell = {
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
    // Once they start talking, the shell's pause detection decides when they're done.
    if (text.trim()) clearTimeout(followUpTimer);
    if (!final) {
      status.textContent = `“${text}”`;
      return;
    }
    endFollowUp();
    submit(text, true);
  },
  status(text) {
    endFollowUp();
    setState("idle", text);
    setTimeout(() => {
      if (pill.dataset.state === "idle" && status.textContent === text) status.textContent = "";
    }, 5000);
  },
  reload() {
    loadBrief(false);
  },
  focusProject(name) {
    runFocus(name);
  },
  /** Hide for now; the conversation stays and is there next time. */
  dismiss() {
    endFollowUp();
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

// The shell sizes its window to the content, so report the height whenever it changes.
if (SHELL) {
  const stage = document.querySelector(".stage");
  new ResizeObserver(() => toShell({ type: "height", value: Math.ceil(stage.getBoundingClientRect().height) })).observe(stage);
}

setState("idle");
loadBrief();
syncConversation();
