/* Goals (the projects ledger, as goals with where each one stands) and Memory (the files it knows
 * you from, to read and change). The sidebar picks which: you.html#goals or you.html#memory.
 * Every save to memory is a commit, so nothing edited here is lost. Plain script. */
const { $, el, get, post, when } = window.cosDom;
const { glyph, toast, item, group, setCurrent } = window.cosPage;

// ---------- which of the two ----------
function route() {
  const view = location.hash === "#memory" ? "memory" : "goals";
  $("goals").hidden = view !== "goals";
  $("memory").hidden = view !== "memory";
  $("bar-title").textContent = view === "goals" ? "Goals" : "Memory";
  document.title = `${view === "goals" ? "Goals" : "Memory"} — Chief of Staff`;
  document.querySelector(".window").dataset.page = view;
  setCurrent(view);
  if (!$("editor").hidden) closeEditor(true);
}
window.addEventListener("hashchange", route);

// ---------- goals ----------
const ago = (n) => (n === null ? "Not touched yet" : n === 0 ? "Touched today" : `Touched ${n} day${n === 1 ? "" : "s"} ago`);
function due(d, today) {
  const days = Math.round((new Date(`${d}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86_400_000);
  const text = days < 0 ? `Overdue by ${-days} day${days === -1 ? "" : "s"}` : days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due in ${days} days`;
  return el("span", { class: days < 0 ? "due-late" : "" }, text);
}

async function decideGoal(g, choice) {
  const r = await post("/api/decide", { project: g.name, choice });
  if (r.error) return toast(r.error, "error");
  toast(r.message);
  loadGoals();
}

/** The next action, edited in place: click it, type, Return saves, Escape leaves it. */
function nextLine(g) {
  const line = el("button", { class: `goal-next${g.next ? "" : " placeholder"}`, type: "button", title: "Change the next action" }, g.next || "Add a next action");
  line.addEventListener("click", () => {
    const input = el("input", { class: "field", type: "text", value: g.next, placeholder: "The one next action", "aria-label": `Next action for ${g.name}` });
    let settled = false;
    const done = async (save) => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      if (save && next !== g.next) {
        const r = await post("/api/goals/next", { project: g.name, next });
        if (r.error) toast(r.error, "error");
        else {
          g.next = r.next;
          toast("Saved");
        }
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
    input.select();
  });
  return line;
}

function goalRow(g, today) {
  const finished = g.status === "done" || g.status === "killed";
  const check = el("button", {
    class: "check",
    role: "checkbox",
    "aria-checked": String(g.status === "done"),
    "aria-label": g.status === "done" ? `${g.name} is done. Mark it active again` : `Mark ${g.name} done`,
    title: g.status === "done" ? "Done" : "Mark done",
    onclick: () => decideGoal(g, g.status === "done" ? "keep" : "done"),
  });
  const meta = el("div", { class: "goal-meta" });
  const bits = [g.deadline ? due(g.deadline, today) : null, g.cadence || null, ago(g.idle)].filter(Boolean);
  bits.forEach((b, i) => meta.append(...(i ? [" · "] : []), b));
  const main = el("div", { class: "item-main" },
    el("div", { class: "item-title" }, g.name),
    g.status === "active" ? nextLine(g) : el("div", { class: "item-sub" }, g.next || ""),
    ...(g.why ? [el("div", { class: "goal-meta" }, g.why)] : []),
    meta);
  const trail = el("div", { class: "item-trail" });
  if (g.status === "active") trail.append(el("button", { class: "btn small", type: "button", onclick: () => decideGoal(g, "park") }, "Park"));
  if (g.status === "parked") trail.append(el("button", { class: "btn small", type: "button", onclick: () => decideGoal(g, "keep") }, "Resume"));
  return el("div", { class: `item goal${finished ? " finished" : ""}` }, check, main, trail);
}

async function loadGoals() {
  let r;
  try {
    r = await get("/api/goals");
  } catch {
    return toast("The app isn't answering.", "error");
  }
  const by = (s) => r.goals.filter((g) => g.status === s);
  const active = by("active").sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999"));
  const parked = by("parked");
  const finished = [...by("done"), ...by("killed")];
  const parts = [
    ...group("In progress", active.length ? active.map((g) => goalRow(g, r.today)) : [el("p", { class: "empty-note" }, "Nothing in progress. Tell it “starting a project: …”, and why it matters.")], { aside: `${active.length}` }),
  ];
  if (parked.length) parts.push(...group("Parked", parked.map((g) => goalRow(g, r.today)), { foot: "Parked goals come back for a decision after a month." }));
  if (finished.length) {
    parts.push(el("details", { class: "more" }, el("summary", {}, `Done and dropped (${finished.length})`), el("div", { class: "group" }, ...finished.map((g) => goalRow(g, r.today)))));
  }
  $("goals-list").replaceChildren(...parts);
  $("goals-state").textContent = `${active.length} in progress${parked.length ? ` · ${parked.length} parked` : ""}${finished.length ? ` · ${finished.length} done` : ""}`;
}

// ---------- memory ----------
const FILE_ICONS = { "goals/projects.md": ["target", "green"], "goals/reminders.md": ["bell", "red"], "notes/inbox.md": ["note", "orange"] };

function tile(icon, color, title, sub, onclick) {
  return el("button", { class: "tile", type: "button", onclick }, glyph(icon, color), el("span", { class: "tile-title" }, title), el("span", { class: "tile-sub" }, sub));
}

async function loadMemory() {
  let r;
  try {
    r = await get("/api/files");
  } catch {
    return toast("The app isn't answering.", "error");
  }
  const all = r.groups.flatMap((g) => g.files);
  const rules = all.find((f) => f.path === "goals/heartbeat.md");
  const tiles = el("div", { class: "tiles" },
    tile("spark", "pink", "Soul", r.soul.chars ? "How it behaves, in your words" : "How it behaves: defaults only", () => (location.href = "/settings.html")),
    tile("heart", "red", "Heartbeat rules", rules?.exists ? `When it writes first · edited ${when(rules.modified)}` : "When it writes first · not set yet",
      () => openFile({ path: "goals/heartbeat.md", title: "Heartbeat rules" })));
  const groups = r.groups.map((g) => {
    const files = g.files.filter((f) => f.path !== "goals/heartbeat.md");
    if (!files.length) return [];
    return group(g.name, files.map((f) => {
      const [icon, color] = FILE_ICONS[f.path] || (f.path.startsWith("journal/") ? ["doc", "gray"] : ["person", "blue"]);
      return item({
        tag: "button",
        icon: glyph(icon, color),
        title: f.title,
        sub: f.exists ? `Edited ${when(f.modified)}` : "Empty so far",
        trail: [el("span", { class: "chevron", "aria-hidden": "true" }, "›")],
        onclick: () => openFile(f),
      });
    }));
  }).flat();
  $("memory-list").replaceChildren(tiles, ...groups, el("p", { class: "group-foot", style: "margin-top:22px" }, `Kept in ${r.dir}`));
}

// ---------- the editor ----------
let editing = null; // { path, base, saved }
const area = () => $("text");
const dirty = () => editing && area().value !== editing.saved;

function setPreview(on) {
  $("preview").hidden = !on;
  area().hidden = on;
  $("formatting").classList.toggle("off", on);
  $("mode-edit").setAttribute("aria-selected", String(!on));
  $("mode-preview").setAttribute("aria-selected", String(on));
  if (on) $("preview").replaceChildren(cosMarkdown.render(area().value, { rich: true }));
  else area().focus();
}

async function openFile(f) {
  const r = await get(`/api/files/read?path=${encodeURIComponent(f.path)}`);
  if (r.error) return toast(r.error, "error");
  editing = { path: f.path, base: r.modified, saved: r.text };
  $("file-title").textContent = f.title || f.path;
  $("file-bar-title").textContent = "";
  $("file-note").textContent = r.modified ? `${f.path} · edited ${when(r.modified)}` : `${f.path} · new — saving creates it`;
  area().value = r.text;
  $("editor-said").textContent = "";
  $("home").hidden = true;
  $("editor").hidden = false;
  setPreview(false);
  area().setSelectionRange(0, 0);
  area().scrollTop = 0;
}

function closeEditor(force = false) {
  if (!force && dirty() && !window.confirm("Discard your changes?")) return false;
  editing = null;
  $("editor").hidden = true;
  $("home").hidden = false;
  loadMemory();
  return true;
}

async function save() {
  if (!editing) return;
  const text = area().value;
  const r = await post("/api/files/save", { path: editing.path, text, base: editing.base });
  if (r.error) {
    $("editor-said").textContent = r.error;
    $("editor-said").dataset.tone = "error";
    return;
  }
  editing.saved = text;
  editing.base = r.modified;
  $("editor-said").textContent = "";
  $("editor-said").dataset.tone = "";
  $("file-note").textContent = `${editing.path} · saved just now`;
  toast("Saved");
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
      const want = kind === "ol" ? `${i + 1}. ` : prefix;
      return l.startsWith(want) ? strip(l) : want + strip(l); // pressing it again takes it off
    });
    t.setRangeText(out.join("\n"), start, end, "select");
  }
  t.focus();
}

for (const b of $("formatting").querySelectorAll("button")) b.addEventListener("click", () => format(b.dataset.md));
$("mode-edit").addEventListener("click", () => setPreview(false));
$("mode-preview").addEventListener("click", () => setPreview(true));
$("save-btn").addEventListener("click", save);
$("back").addEventListener("click", () => closeEditor());
document.addEventListener("keydown", (e) => {
  if ($("editor").hidden) return;
  if (e.key === "Escape" && document.activeElement !== area()) closeEditor();
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === "s") {
    e.preventDefault();
    save();
  } else if ((k === "b" || k === "i") && !area().hidden) {
    e.preventDefault();
    format(k === "b" ? "bold" : "italic");
  }
});
window.addEventListener("beforeunload", (e) => {
  if (dirty()) e.preventDefault();
});

route();
loadGoals();
loadMemory();
