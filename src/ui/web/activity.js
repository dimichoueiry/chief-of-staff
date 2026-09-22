/* What it's running for you and what you've allowed, in one place: the heartbeat and how
 * proactive it is, your reminders, the rhythm of your projects, and every action that waited
 * for your OK (or didn't need one). Plain script over GET /api/activity. */
const { $, el, get, post, when } = window.cosDom;

const say = (text, tone = "") => {
  $("said").textContent = text;
  $("said").dataset.tone = tone;
};

// ---------- small line icons, drawn once ----------
const ICONS = {
  heart: "M12 20s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.65-7 10-7 10z",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0",
  repeat: "M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
  agent: "M8 8h8v8H8zM12 4v4M12 16v4M4 12h4M16 12h4",
  spark: "M12 3l2 7 7 2-7 2-2 7-2-7-7-2 7-2z",
  check: "M5 12l4 4 10-10",
  cursor: "M5 3l14 8-6 2-2 6z",
};
const KIND_ICON = { open: "globe", command: "terminal", "browser-act": "cursor", offer: "spark" };
const iconFor = (kind) => KIND_ICON[kind] || (/agent|orchestrator|ticket/.test(kind) ? "agent" : /browser/.test(kind) ? "cursor" : "check");

function icon(name) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", ICONS[name] || ICONS.check);
  svg.append(path);
  return el("span", { class: `row-icon icon-${name}` }, svg);
}

const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dayLabel = (date, today) => {
  if (date === today) return "Today";
  const d = new Date(`${date}T12:00:00`);
  const t = new Date(`${today}T12:00:00`);
  const days = Math.round((d - t) / 86_400_000);
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const timeLabel = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

function row(iconName, title, sub, ...extra) {
  return el("div", { class: "row" }, icon(iconName), el("div", { class: "row-main" }, el("div", { class: "row-title" }, title), ...(sub ? [el("div", { class: "row-sub" }, sub)] : [])), ...extra);
}

function section(title, ...rows) {
  return el("section", { class: "act-section" }, el("h2", {}, title), ...rows);
}

// ---------- Scheduled ----------
function heartbeatSection(hb) {
  const modes = el("div", { class: "segmented", role: "radiogroup", "aria-label": "How proactive" });
  const hints = { off: "Never writes first.", proactive: "Offers, and waits for your yes.", plus: "Prepares drafts on its own, then shows you. Anything that would send or post still waits." };
  for (const m of hb.modes) {
    modes.append(el("button", {
      class: m.id === hb.mode ? "seg on" : "seg",
      role: "radio",
      "aria-checked": String(m.id === hb.mode),
      title: hints[m.id] || "",
      onclick: async () => {
        const r = await post("/api/heartbeat", { mode: m.id });
        if (r.error) return say(r.error, "error");
        say(`${m.name}. ${hints[m.id] || ""}`);
        load();
      },
    }, m.name));
  }
  const s = hb.schedule;
  const sub = hb.mode === "off"
    ? "Off: it won't write to you first."
    : [s ? `Every ${Math.round(s.everyMs / 60000)} minutes · next ${clock(s.nextAt)}` : "Runs while the app is open", hb.last ? `last look ${when(hb.last.at)}: ${hb.last.outcome}` : ""].filter(Boolean).join(" · ");
  const look = el("button", {
    class: "chip",
    onclick: async () => {
      look.disabled = true;
      look.textContent = "looking…";
      const r = await post("/api/heartbeat/tick", {});
      look.disabled = false;
      look.textContent = "look now";
      say(r.outcome === "offered" || r.outcome === "done" ? `It wrote to you: ${r.offer.title}` : r.outcome === "off" ? "It's off." : `Nothing to say${r.why ? `: ${r.why}` : "."}`);
      load();
    },
  }, "look now");
  if (hb.mode === "off") look.disabled = true;
  const offers = hb.offers.slice(0, 5).map((o) =>
    row("spark", o.title, `${{ open: "waiting on you", accepted: "you said yes", declined: "you said not now", done: "did it on its own" }[o.status] || o.status} · ${when(o.createdAt)}`));
  return section("Proactive",
    el("div", { class: "row" }, icon("heart"), el("div", { class: "row-main" }, el("div", { class: "row-title" }, "Heartbeat"), el("div", { class: "row-sub" }, sub)), look),
    modes,
    ...(offers.length ? [el("div", { class: "sub-list" }, el("div", { class: "sub-head" }, "What it offered lately"), ...offers)] : []));
}

function remindersSection(reminders, today) {
  if (!reminders.length) return section("Reminders", el("p", { class: "empty" }, "Nothing set. Say “remind me Friday to …”, or tell it what's happening when."));
  return section("Reminders", ...reminders.map((r) => {
    const done = el("button", {
      class: "chip icon",
      title: "Mark it done",
      "aria-label": `Mark “${r.text}” done`,
      onclick: async () => {
        done.disabled = true;
        const res = await post("/api/reminders/done", { text: r.text });
        if (res.error) return say(res.error, "error");
        say(res.text);
        load();
      },
    }, "✓");
    const overdue = r.date < today;
    const node = row("bell", r.text, `${dayLabel(r.date, today)}${r.time ? `, ${timeLabel(r.time)}` : ""}${overdue ? " · overdue" : ""}`, done);
    if (overdue) node.classList.add("overdue");
    return node;
  }));
}

function rhythmSection(rhythm) {
  if (!rhythm.length) return null;
  return section("Rhythm", ...rhythm.map((p) =>
    row("repeat", p.name, [p.cadence, p.next ? `next: ${p.next}` : "", p.idle === null ? "" : `touched ${p.idle === 0 ? "today" : `${p.idle} day${p.idle === 1 ? "" : "s"} ago`}`].filter(Boolean).join(" · "))));
}

// ---------- Approvals ----------
const OUTCOMES = {
  allowed: (a) => `Allowed · ${a.how === "said" ? "you said yes" : "you tapped"}`,
  declined: (a) => `Declined · ${a.how === "said" ? "you said no" : "you tapped"}`,
  failed: () => "Allowed, but it failed",
  auto: () => "Allowed by your settings",
  done: () => "Done on its own (Proactive+)",
};

function approvalsPanel(list) {
  if (!list.length) return [el("p", { class: "empty" }, "Nothing yet. When it asks before doing something, or does something your settings allow, it's listed here.")];
  return [section("Approvals history", ...list.map((a) => {
    const n = row(iconFor(a.kind), a.label, `${(OUTCOMES[a.outcome] || (() => a.outcome))(a)} · ${when(a.at)}`);
    if (a.detail) n.querySelector(".row-main").append(el("div", { class: "row-detail" }, a.detail));
    n.dataset.outcome = a.outcome;
    return n;
  }))];
}

// ---------- the page ----------
let tab = (() => {
  try {
    return localStorage.getItem("cos.activityTab") || "scheduled";
  } catch {
    return "scheduled";
  }
})();

function showTab(name) {
  tab = name;
  try {
    localStorage.setItem("cos.activityTab", name);
  } catch {
    /* fine */
  }
  for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  $("scheduled").hidden = name !== "scheduled";
  $("approvals").hidden = name !== "approvals";
}

for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => showTab(b.dataset.tab));

async function load() {
  let a;
  try {
    a = await get("/api/activity");
  } catch {
    return say("The app isn't answering.", "error");
  }
  const names = Object.fromEntries(a.heartbeat.modes.map((m) => [m.id, m.name]));
  $("state").textContent = a.heartbeat.mode === "off" ? "Not writing first" : `${names[a.heartbeat.mode]} · ${a.reminders.length} reminder${a.reminders.length === 1 ? "" : "s"} open`;
  $("scheduled").replaceChildren(...[heartbeatSection(a.heartbeat), remindersSection(a.reminders, a.today), rhythmSection(a.rhythm)].filter(Boolean));
  $("approvals").replaceChildren(...approvalsPanel(a.approvals));
  showTab(tab);
}

load();
