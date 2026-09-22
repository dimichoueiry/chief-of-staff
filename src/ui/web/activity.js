/* What it's running for you and what you've allowed, in one place: how proactive it is and when
 * it next looks, your reminders, the rhythm of your projects, and every action that waited for
 * your OK (or didn't need one). Plain script over GET /api/activity. */
const { $, el, get, post, when } = window.cosDom;
const { glyph, toast, item, group } = window.cosPage;

const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dayLabel = (date, today) => {
  if (date === today) return "Today";
  const days = Math.round((new Date(`${date}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86_400_000);
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const timeLabel = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

// ---------- Scheduled ----------
const HINTS = {
  off: "It never writes to you first.",
  proactive: "When it can do something before you ask, it offers, and waits for your yes.",
  plus: "It prepares drafts on its own and shows you. Anything that would send, post or change your memory still waits for your yes.",
};

function proactiveSection(hb) {
  const control = el("div", { class: "segmented full", role: "radiogroup", "aria-label": "How proactive" });
  for (const m of hb.modes) {
    control.append(el("button", {
      class: "seg",
      role: "radio",
      "aria-checked": String(m.id === hb.mode),
      onclick: async () => {
        const r = await post("/api/heartbeat", { mode: m.id });
        if (r.error) return toast(r.error, "error");
        toast(m.id === "off" ? "Off" : `${m.name} is on`);
        load();
      },
    }, m.name));
  }
  const s = hb.schedule;
  const look = el("button", {
    class: "btn small",
    onclick: async () => {
      look.disabled = true;
      look.textContent = "Looking…";
      const r = await post("/api/heartbeat/tick", {});
      look.disabled = false;
      look.textContent = "Look Now";
      toast(r.outcome === "offered" || r.outcome === "done" ? `It wrote to you: ${r.offer.title}` : r.outcome === "off" ? "It's off." : `Nothing worth saying${r.why ? `: ${r.why}` : "."}`);
      load();
    },
  }, "Look Now");
  if (hb.mode === "off") look.disabled = true;

  const heartbeatSub = hb.mode === "off"
    ? "Off"
    : s ? `Every ${Math.round(s.everyMs / 60000)} minutes · next at ${clock(s.nextAt)}` : "While the app is open";
  const rows = [
    el("div", { class: "item plain" }, el("div", { class: "item-main" }, control, el("div", { class: "item-sub", style: "margin-top:8px" }, HINTS[hb.mode] || ""))),
    item({ icon: glyph("heart", "red"), title: "Heartbeat", sub: heartbeatSub, trail: [look] }),
  ];
  if (hb.last && hb.mode !== "off") rows.push(item({ icon: glyph("clock", "gray"), title: "Last look", sub: `${when(hb.last.at)} · ${hb.last.outcome.replace(/^quiet: /, "said nothing: ")}` }));

  const offered = hb.offers.slice(0, 5).map((o) =>
    item({
      icon: glyph("spark", "orange"),
      title: o.title,
      sub: `${{ open: "Waiting on you", accepted: "You said yes", declined: "You said not now", done: "Done on its own" }[o.status] || o.status} · ${when(o.createdAt)}`,
    }));
  return [
    ...group("Proactive", rows),
    ...(offered.length ? group("What it offered", offered) : []),
  ];
}

function remindersSection(reminders, today) {
  if (!reminders.length) {
    return group("Reminders", [el("p", { class: "empty-note" }, "Nothing set. Tell it “remind me Friday to …”, or just say when something is happening.")]);
  }
  return group("Reminders", reminders.map((r) => {
    const check = el("button", {
      class: "check",
      role: "checkbox",
      "aria-checked": "false",
      "aria-label": `Mark “${r.text}” done`,
      onclick: async () => {
        check.setAttribute("aria-checked", "true");
        const res = await post("/api/reminders/done", { text: r.text });
        if (res.error) {
          check.setAttribute("aria-checked", "false");
          return toast(res.error, "error");
        }
        toast("Done");
        setTimeout(load, 350);
      },
    });
    const overdue = r.date < today;
    return item({ icon: check, title: r.text, sub: `${dayLabel(r.date, today)}${r.time ? `, ${timeLabel(r.time)}` : ""}${overdue ? " · Overdue" : ""}`, cls: overdue ? "warn" : "" });
  }), { aside: `${reminders.length} open` });
}

function rhythmSection(rhythm) {
  if (!rhythm.length) return [];
  return group("Rhythm", rhythm.map((p) =>
    item({
      icon: glyph("repeat", "teal"),
      title: p.name,
      sub: [p.cadence, p.idle === null ? "" : p.idle === 0 ? "Touched today" : `Touched ${p.idle} day${p.idle === 1 ? "" : "s"} ago`].filter(Boolean).join(" · "),
      detail: p.next ? `Next: ${p.next}` : "",
    })), { foot: "Projects with a day of their own. Set one by telling it “MLGuerrilla on Thursdays”." });
}

// ---------- Asking first ----------
const ASKING = [
  { id: "browser", title: "Its browser", icon: ["cursor", "indigo"], ask: "Asks before it sends, posts, buys or deletes on a page.", auto: "Clicks Send, Post and Delete itself." },
  { id: "terminal", title: "Commands", icon: ["terminal", "gray"], ask: "Asks before a command that changes something.", auto: "Runs them itself. The riskiest still ask." },
  { id: "agents", title: "Agents", icon: ["agent", "teal"], ask: "Asks before starting or messaging an agent.", auto: "Starts and messages agents itself." },
  { id: "links", title: "Web pages", icon: ["globe", "blue"], ask: "Asks before opening an address it found or built.", auto: "Opens them straight away." },
];
const MODE_NAMES = { off: "Off", ask: "Ask", auto: "Don't Ask" };

function askingSection(access) {
  const rows = ASKING.map((c) => {
    const control = el("div", { class: "segmented", role: "radiogroup", "aria-label": c.title });
    for (const m of ["off", "ask", "auto"]) {
      control.append(el("button", {
        class: "seg",
        role: "radio",
        "aria-checked": String(access[c.id] === m),
        onclick: async () => {
          const r = await post("/api/access", { capability: c.id, mode: m });
          if (r.error) return toast(r.error, "error");
          toast(`${c.title}: ${MODE_NAMES[m]}`);
          load();
        },
      }, MODE_NAMES[m]));
    }
    const sub = access[c.id] === "off" ? "It can't use this at all." : access[c.id] === "auto" ? c.auto : c.ask;
    return item({ icon: glyph(...c.icon), title: c.title, sub, trail: [control] });
  });
  return group("Asking first", rows, { foot: "Don't Ask still stops for the riskiest things, and some things are never allowed. Saying “stop asking me” works too; it needs one tap to confirm." });
}

// ---------- Approvals ----------
const KIND = { open: ["globe", "blue"], command: ["terminal", "gray"], "browser-act": ["cursor", "indigo"], offer: ["spark", "orange"] };
const iconFor = (kind) => KIND[kind] || (/agent|orchestrator|ticket/.test(kind) ? ["agent", "teal"] : /browser/.test(kind) ? ["cursor", "indigo"] : ["check", "green"]);
const OUTCOMES = {
  allowed: (a) => (a.how === "said" ? "Allowed — you said yes" : "Allowed"),
  declined: (a) => (a.how === "said" ? "Declined — you said no" : "Declined"),
  failed: () => "Allowed, but it failed",
  auto: () => "Allowed by your settings",
  done: () => "Done on its own (Proactive+)",
};

function approvalsPanel(list) {
  if (!list.length) return group("", [el("p", { class: "empty-note" }, "Nothing yet. When it asks before doing something, or does something your settings allow, it's listed here.")]);
  // One group per day, newest first, like a history should read.
  const days = new Map();
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  for (const a of list) {
    const d = new Date(a.at);
    const key = d.toDateString();
    const label = key === today ? "Today" : key === yesterday ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    if (!days.has(key)) days.set(key, { label, rows: [] });
    const [icon, color] = iconFor(a.kind);
    days.get(key).rows.push(item({
      icon: glyph(icon, color),
      title: a.label,
      sub: `${(OUTCOMES[a.outcome] || (() => a.outcome))(a)} · ${clock(a.at)}`,
      detail: a.detail || "",
      cls: a.outcome === "failed" ? "warn" : "",
    }));
  }
  return [...days.values()].flatMap((d) => group(d.label, d.rows));
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
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  $("scheduled").hidden = name !== "scheduled";
  $("approvals").hidden = name !== "approvals";
}
for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => showTab(b.dataset.tab));

async function load() {
  let a;
  try {
    a = await get("/api/activity");
  } catch {
    return toast("The app isn't answering.", "error");
  }
  const names = Object.fromEntries(a.heartbeat.modes.map((m) => [m.id, m.name]));
  const open = a.reminders.length;
  $("state").textContent = `${a.heartbeat.mode === "off" ? "Not writing to you first" : names[a.heartbeat.mode]} · ${open} reminder${open === 1 ? "" : "s"} open`;
  $("scheduled").replaceChildren(...proactiveSection(a.heartbeat), ...remindersSection(a.reminders, a.today), ...rhythmSection(a.rhythm));
  $("approvals").replaceChildren(...askingSection(a.access), ...approvalsPanel(a.approvals));
  showTab(tab);
}

load();
