/* The pill + brief page. Plain JS, talks to the local server. */
const $ = (id) => document.getElementById(id);
const pill = $("pill");
const input = $("pill-input");
const status = $("pill-status");
let brief = null;
let mode = "auto"; // auto | ask | capture

// ---------- state machine for the pill ----------
function setState(state, text = "") {
  pill.dataset.state = state;
  status.textContent = text;
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
    const li = el("li", { class: s.free ? "free" : "" },
      el("span", { class: "time" }, `${s.start}–${s.end}`),
      el("span", {}, s.free ? "Free block" : s.title, s.free && s.plan ? el("span", { class: "plan" }, `  → ${s.plan}`) : ""));
    schedule.append(li);
  }

  const decisions = $("decisions");
  decisions.replaceChildren();
  $("decisions-wrap").hidden = !brief.decisions.length;
  for (const d of brief.decisions) {
    const opts = el("div", { class: "opts" });
    const li = el("li", {}, el("div", { class: "q" }, d.question), el("div", { class: "reason" }, d.reason), opts);
    for (const o of d.options) {
      opts.append(el("button", {
        class: `chip ${o === "keep" ? "chip-keep" : o === "kill" ? "chip-kill" : ""}`,
        onclick: async (e) => {
          for (const b of opts.querySelectorAll("button")) b.disabled = true;
          const r = await post("/api/decide", { project: d.project, choice: o });
          opts.replaceWith(el("div", { class: "done" }, r.message || r.error));
        },
      }, o[0].toUpperCase() + o.slice(1)));
    }
    decisions.append(li);
  }

  const reminders = $("reminders");
  reminders.replaceChildren();
  $("reminders-wrap").hidden = !brief.reminders.length;
  for (const r of brief.reminders) {
    reminders.append(el("li", { class: r.overdue ? "overdue" : "" }, el("time", {}, r.date), r.text));
  }

  const nudges = $("nudges");
  nudges.replaceChildren();
  $("nudges-wrap").hidden = !brief.nudges.length;
  for (const n of brief.nudges) nudges.append(el("li", {}, n));

  $("source").textContent = `${data.source}${data.offline ? " · offline: set ANTHROPIC_API_KEY for the model" : ""} · ${data.today}`;
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
  setState("thinking", refresh ? "Rebuilding the brief…" : "Loading…");
  try {
    renderBrief(await get(`/api/brief${refresh ? "?refresh=1" : ""}`));
  } catch (err) {
    $("greeting").textContent = "Could not load the brief";
    $("headline").textContent = String(err);
  }
  setState("idle");
}

async function speakText(text) {
  setState("speaking", "Reading it to you…");
  try {
    await post("/api/speak", { text });
  } finally {
    setState("idle");
  }
}

function showAnswer(kind, text) {
  $("answer").hidden = false;
  $("answer-title").textContent = kind === "capture" ? "Filed" : "Chief of staff";
  $("answer-text").textContent = text;
  $("answer").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function submit(text) {
  const t = text.trim();
  if (!t) return;
  input.value = "";
  setState("thinking", "Thinking…");
  try {
    const r = await post("/api/pill", { text: t, mode });
    showAnswer(r.kind, r.text || r.error);
    if (r.kind === "capture") loadBrief(true);
    else if (r.text) await speakText(r.text);
  } catch (err) {
    showAnswer("answer", String(err));
  }
  setState("idle");
}

// ---------- voice in the browser (Web Speech API, when the browser has it) ----------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen() {
  if (!Recognition) {
    status.textContent = "This browser has no speech recognition — type instead.";
    setTimeout(() => setState("idle"), 2000);
    return;
  }
  if (rec) { rec.stop(); return; }
  rec = new Recognition();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (const res of e.results) (res.isFinal ? (finalText += res[0].transcript) : (interim += res[0].transcript));
    status.textContent = `“${finalText || interim}”`;
  };
  rec.onend = () => {
    rec = null;
    if (finalText.trim()) submit(finalText);
    else setState("idle");
  };
  rec.onerror = () => { rec = null; setState("idle"); };
  setState("listening", "Listening…");
  rec.start();
}

// ---------- wiring ----------
pill.addEventListener("submit", (e) => { e.preventDefault(); submit(input.value); });
$("mic").addEventListener("click", listen);
$("btn-refresh").addEventListener("click", () => loadBrief(true));
$("btn-speak").addEventListener("click", () => speakText($("panel").dataset.speech || ""));
$("answer-speak").addEventListener("click", () => speakText($("answer-text").textContent));
$("mode").addEventListener("click", () => {
  mode = mode === "auto" ? "ask" : mode === "ask" ? "capture" : "auto";
  $("mode").textContent = mode;
  input.placeholder = mode === "capture" ? "Tell me something to file…" : "Ask anything…";
});

// Fn double-tap is captured natively by the desktop shell; in the browser we offer Cmd/Ctrl+K and a double-tap of Shift.
let lastShift = 0;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.focus(); }
  if (e.key === "Escape") { $("answer").hidden = true; if (rec) rec.stop(); setState("idle"); }
  if (e.key === "Shift") {
    const now = Date.now();
    if (now - lastShift < 350) listen();
    lastShift = now;
  }
});

loadBrief();
