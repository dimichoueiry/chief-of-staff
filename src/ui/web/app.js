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

async function speakText(text) {
  if (!text) return;
  setState("speaking", "Reading it to you…");
  try {
    await post("/api/speak", { text });
  } finally {
    if (pill.dataset.state === "speaking") setState("idle");
  }
}

async function stopSpeaking() {
  await post("/api/speak/stop", {});
  setState("idle");
}

function showAnswer(title, text, model = "") {
  $("answer").hidden = false;
  $("answer-title").textContent = title;
  $("answer-model").textContent = model ? `· ${model}` : "";
  $("answer-text").textContent = text;
  if (!SHELL) $("answer").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideAnswer() {
  $("answer").hidden = true;
}

async function submit(text, fromVoice = false) {
  const t = text.trim();
  if (!t) {
    setState("idle");
    return;
  }
  input.value = "";
  setState("thinking", fromVoice ? `“${t}”` : "Thinking…");
  let r;
  try {
    r = await post("/api/pill", { text: t, mode: inputMode });
  } catch (err) {
    showAnswer("Chief of staff", String(err));
    setState("idle");
    return;
  }
  showAnswer(r.kind === "capture" ? "Filed" : "Chief of staff", r.text || r.error || "", r.model);
  if (r.kind === "capture") markStale();
  setState("idle");
  // Spoken questions get spoken answers; typed ones stay quiet unless you press read aloud.
  if (fromVoice && r.kind !== "capture" && r.text) await speakText(r.text);
}

async function runFocus(project) {
  setState("thinking", `Looking at ${project}…`);
  try {
    const r = await post("/api/pill", { text: project, mode: "focus" });
    showAnswer(r.project ? `${r.project} — top 3 right now` : "Focus", r.text || r.error || "", r.model);
    if (r.changes) markStale();
  } catch (err) {
    showAnswer("Focus", String(err));
  }
  setState("idle");
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
  rec.onend = () => {
    rec = null;
    submit(finalText, true);
  };
  rec.onerror = () => {
    rec = null;
    setState("idle");
  };
  setState("listening", "Listening…");
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
  },
  setMode(view) {
    setView(view);
    input.focus();
  },
  listening(on) {
    if (on) {
      hideAnswer();
      setState("listening", "Listening…");
    } else if (pill.dataset.state === "listening") setState("idle");
  },
  transcript(text, final) {
    if (!final) {
      status.textContent = `“${text}”`;
      return;
    }
    submit(text, true);
  },
  status(text) {
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
  dismiss() {
    if (pill.dataset.state === "speaking") post("/api/speak/stop", {});
    hideAnswer();
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
$("btn-refresh").addEventListener("click", () => loadBrief(true));
$("btn-speak").addEventListener("click", () => speakText($("panel").dataset.speech || ""));
$("answer-speak").addEventListener("click", () => speakText($("answer-text").textContent));
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
