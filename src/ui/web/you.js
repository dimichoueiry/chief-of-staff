/* You: your goals (the projects ledger, as goals with where each one stands) and your memory as
 * files you can open and edit, Soul first (your instructions for how it behaves). Every save to
 * memory is a commit, so nothing edited here is lost. Plain script. */
const { $, el, get, post, when } = window.cosDom;

const say = (text, tone = "", where = "said") => {
  $(where).textContent = text;
  $(where).dataset.tone = tone;
};

// ---------- tabs ----------
let tab = (() => {
  try {
    return localStorage.getItem("cos.youTab") || "goals";
  } catch {
    return "goals";
  }
})();

function showTab(name) {
  tab = name;
  try {
    localStorage.setItem("cos.youTab", name);
  } catch {
    /* fine */
  }
  for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  $("goals").hidden = name !== "goals";
  $("memory").hidden = name !== "memory";
}
for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => showTab(b.dataset.tab));

// ---------- goals ----------
const ago = (n) => (n === null ? "never touched" : n === 0 ? "touched today" : `touched ${n} day${n === 1 ? "" : "s"} ago`);
const dueLabel = (d, today) => {
  const days = Math.round((new Date(`${d}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86_400_000);
  return days < 0 ? `due ${-days} day${days === -1 ? "" : "s"} ago` : days === 0 ? "due today" : days === 1 ? "due tomorrow" : `due in ${days} days`;
};

async function decideGoal(g, choice) {
  const r = await post("/api/decide", { project: g.name, choice });
  if (r.error) return say(r.error, "error");
  say(r.message);
  loadGoals();
}

/** The next action, edited in place: click it, type, Enter saves, Esc leaves it. */
function nextLine(g) {
  const line = el("button", { class: "goal-next", title: "Change the next action" }, g.next || "No next action yet. Add one…");
  if (!g.next) line.classList.add("empty-next");
  line.addEventListener("click", () => {
    const input = el("input", { class: "goal-input", type: "text", value: g.next, placeholder: "The one next action", "aria-label": `Next action for ${g.name}` });
    const done = async (save) => {
      if (!input.isConnected) return;
      const next = input.value.trim();
      if (save && next !== g.next) {
        const r = await post("/api/goals/next", { project: g.name, next });
        if (r.error) return say(r.error, "error");
        g.next = r.next;
        say(`${g.name}: next is ${r.next || "nothing yet"}.`);
      }
      input.replaceWith(nextLine(g));
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      if (e.key === "Escape") done(false);
    });
    input.addEventListener("blur", () => done(true));
    line.replaceWith(input);
    input.focus();
  });
  return line;
}

function goalRow(g, today) {
  const meta = [g.why, g.deadline ? dueLabel(g.deadline, today) : "", g.cadence, ago(g.idle)].filter(Boolean).join(" · ");
  const actions = el("div", { class: "goal-actions" });
  if (g.status === "active") {
    actions.append(el("button", { class: "chip", title: "Set it aside; it comes back in a month", onclick: () => decideGoal(g, "park") }, "park"));
  } else if (g.status === "parked") {
    actions.append(el("button", { class: "chip", title: "Back to active", onclick: () => decideGoal(g, "keep") }, "resume"));
  }
  const check = el("button", {
    class: `goal-check${g.status === "done" ? " on" : ""}`,
    role: "checkbox",
    "aria-checked": String(g.status === "done"),
    "aria-label": g.status === "done" ? `${g.name} is done` : `Mark ${g.name} done`,
    title: g.status === "done" ? "Done" : "Mark it done",
    onclick: () => (g.status === "done" ? decideGoal(g, "keep") : decideGoal(g, "done")),
  });
  const overdue = g.deadline && g.deadline < today && g.status === "active";
  return el("div", { class: `goal${overdue ? " overdue" : ""}` },
    check,
    el("div", { class: "goal-main" }, el("div", { class: "goal-name" }, g.name), g.status === "active" ? nextLine(g) : el("div", { class: "goal-next static" }, g.next || ""), el("div", { class: "goal-meta" }, meta)),
    actions);
}

async function loadGoals() {
  let r;
  try {
    r = await get("/api/goals");
  } catch {
    return say("The app isn't answering.", "error");
  }
  const by = (s) => r.goals.filter((g) => g.status === s);
  const active = by("active").sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999"));
  const parts = [];
  parts.push(el("section", { class: "act-section" }, el("h2", { class: "tracking" }, el("span", { class: "dot", "aria-hidden": "true" }), "Tracking"),
    ...(active.length ? active.map((g) => goalRow(g, r.today)) : [el("p", { class: "empty" }, "Nothing active. Tell it “starting a project: …”, with why it matters.")])));
  if (by("parked").length) parts.push(el("section", { class: "act-section" }, el("h2", {}, "Parked"), ...by("parked").map((g) => goalRow(g, r.today))));
  const finished = [...by("done"), ...by("killed")];
  if (finished.length) {
    parts.push(el("details", { class: "act-section finished" }, el("summary", {}, `Done and dropped (${finished.length})`), ...finished.map((g) => goalRow(g, r.today))));
  }
  $("goals").replaceChildren(...parts);
  $("state").textContent = `${active.length} goal${active.length === 1 ? "" : "s"} tracking${by("parked").length ? ` · ${by("parked").length} parked` : ""}`;
}

// ---------- memory ----------
function heroCard(cls, name, line, date, onOpen) {
  return el("button", { class: `hero-card ${cls}`, onclick: onOpen },
    el("span", { class: "hero-name" }, name),
    el("span", { class: "hero-line" }, line),
    el("span", { class: "hero-date" }, date));
}

const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit", year: "2-digit" }).replace(/\//g, ".") : "not yet");

async function loadMemory() {
  let r;
  try {
    r = await get("/api/files");
  } catch {
    return say("The app isn't answering.", "error");
  }
  const rules = r.groups.flatMap((g) => g.files).find((f) => f.path === "goals/heartbeat.md");
  const heroes = el("div", { class: "heroes" },
    heroCard("soul", "Soul", "How it behaves", r.soul.chars ? `${r.soul.chars} characters` : "defaults only", () => openSoul()),
    heroCard("rules", "Heartbeat", "When it writes first", rules?.exists ? shortDate(rules.modified) : "not set", () => openFile({ path: "goals/heartbeat.md", title: "Heartbeat rules", exists: rules?.exists, modified: rules?.modified ?? null })));
  const groups = r.groups.map((g) =>
    el("section", { class: "act-section" }, el("h2", {}, g.name),
      ...g.files.filter((f) => f.path !== "goals/heartbeat.md").map((f) =>
        el("button", { class: "row file-row", onclick: () => openFile(f) },
          el("span", { class: "file-badge", "aria-hidden": "true" }, "MD"),
          el("div", { class: "row-main" }, el("div", { class: "row-title" }, f.title), el("div", { class: "row-sub" }, [f.about, f.exists ? `edited ${when(f.modified)}` : "not made yet"].filter(Boolean).join(" · ")))))));
  $("memory").replaceChildren(heroes, ...groups, el("p", { class: "note" }, `Kept in ${r.dir}. Every save is part of its history.`));
}

// ---------- the editor ----------
let editing = null; // { kind: "file" | "soul", path, base, saved }

const area = () => $("text");
const dirty = () => editing && area().value !== editing.saved;

function showEditor(on) {
  $("home").hidden = on;
  $("editor").hidden = !on;
  if (on) setPreview(false);
}

function setPreview(on) {
  $("preview").hidden = !on;
  area().hidden = on;
  $("toolbar").classList.toggle("off", on);
  $("preview-btn").textContent = on ? "edit" : "preview";
  if (on) $("preview").replaceChildren(cosMarkdown.render(area().value, { rich: true }));
  else area().focus();
}

async function openFile(f) {
  const r = await get(`/api/files/read?path=${encodeURIComponent(f.path)}`);
  if (r.error) return say(r.error, "error");
  editing = { kind: "file", path: f.path, base: r.modified, saved: r.text };
  $("file-title").textContent = f.title || f.path;
  $("file-note").textContent = r.modified ? `${f.path} · edited ${when(r.modified)}` : `${f.path} · new: saving makes it`;
  area().value = r.text;
  say("", "", "editor-said");
  showEditor(true);
  area().focus();
}

async function openSoul() {
  const r = await get("/api/instructions");
  editing = { kind: "soul", max: r.max, saved: r.text || "" };
  $("file-title").textContent = "Soul";
  $("file-note").textContent = `How it behaves, in your words, on top of its defaults · up to ${r.max} characters`;
  area().value = r.text || "";
  area().placeholder = "e.g. Be blunt. Lead with the answer. Never use exclamation marks.";
  say("", "", "editor-said");
  showEditor(true);
  area().focus();
}

async function save() {
  if (!editing) return;
  const text = area().value;
  const r = editing.kind === "soul"
    ? await post("/api/instructions", { text })
    : await post("/api/files/save", { path: editing.path, text, base: editing.base });
  if (r.error) return say(r.error, "error", "editor-said");
  editing.saved = editing.kind === "soul" ? (r.text ?? text) : text;
  if (r.modified) editing.base = r.modified;
  say(r.message || "Saved.", "", "editor-said");
}

function back() {
  if (dirty() && !window.confirm("Leave without saving your changes?")) return;
  editing = null;
  area().placeholder = "";
  showEditor(false);
  loadMemory();
}

/** Formatting: wrap the selection, or start the selected lines with a marker. */
function format(kind) {
  const t = area();
  const { selectionStart: a, selectionEnd: b, value: v } = t;
  if (kind === "bold" || kind === "italic") {
    const mark = kind === "bold" ? "**" : "*";
    const inner = v.slice(a, b) || (kind === "bold" ? "bold" : "italic");
    t.setRangeText(`${mark}${inner}${mark}`, a, b, "end");
    if (a === b) t.setSelectionRange(a + mark.length, a + mark.length + inner.length);
  } else {
    const start = v.lastIndexOf("\n", a - 1) + 1;
    const endNl = v.indexOf("\n", b);
    const end = endNl === -1 ? v.length : endNl;
    const lines = v.slice(start, end).split("\n");
    const prefix = { h1: "# ", h2: "## ", h3: "### ", ul: "- " }[kind];
    const strip = (l) => l.replace(/^(#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, "");
    const out = lines.map((l, i) => {
      const bare = strip(l);
      const want = kind === "ol" ? `${i + 1}. ` : prefix;
      return l.startsWith(want) ? bare : want + bare; // pressing it again takes it off
    });
    t.setRangeText(out.join("\n"), start, end, "select");
  }
  t.focus();
  t.dispatchEvent(new Event("input"));
}

for (const b of $("toolbar").querySelectorAll("button")) b.addEventListener("click", () => format(b.dataset.md));
$("preview-btn").addEventListener("click", () => setPreview($("preview").hidden));
$("save-btn").addEventListener("click", save);
$("back").addEventListener("click", back);
document.addEventListener("keydown", (e) => {
  if ($("editor").hidden || !(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === "s") {
    e.preventDefault();
    save();
  } else if (k === "b" || k === "i") {
    e.preventDefault();
    format(k === "b" ? "bold" : "italic");
  }
});
window.addEventListener("beforeunload", (e) => {
  if (dirty()) e.preventDefault();
});

// A link can open a tab directly: you.html#memory
if (location.hash === "#memory" || location.hash === "#goals") tab = location.hash.slice(1);
showTab(tab);
loadGoals();
loadMemory();
