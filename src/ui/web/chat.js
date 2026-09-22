/* Talking to it from the dashboard: your chats down the side, the one you're in, and a box to
 * write in. The same conversation the pill has — whatever is said in either shows in both — with
 * everything a reply can carry: its offers, answers as buttons, documents, pictures and pages,
 * and actions waiting for your OK. Plain script over the server the pill uses. */
const { $, el, get, post, when } = window.cosDom;
const { glyph, toast } = window.cosPage;

let conversationId = null;
let chats = [];
let busy = false;
let turnsShown = 0;

// ---------- the list of chats ----------
async function loadChats() {
  let r;
  try {
    r = await get("/api/conversations");
  } catch {
    return;
  }
  chats = r.chats || [];
  drawChats();
}

function drawChats() {
  const q = $("search").value.trim().toLowerCase();
  const shown = chats.filter((c) => !q || `${c.title} ${c.preview || ""}`.toLowerCase().includes(q));
  const items = shown.map((c) => {
    const row = el("li", {
      class: "chat-row",
      role: "option",
      tabindex: "0",
      "aria-selected": String(c.id === conversationId),
      onclick: () => openChat(c.id),
    },
    el("div", { class: "chat-row-top" }, el("span", { class: "chat-row-title" }, c.title), el("span", { class: "chat-row-when" }, when(c.updatedAt))),
    el("div", { class: "chat-row-preview" }, c.preview || " "));
    row.addEventListener("keydown", (e) => e.key === "Enter" && openChat(c.id));
    return row;
  });
  $("chat-list").replaceChildren(...(items.length ? items : [el("li", { class: "chat-empty" }, q ? "No chats match." : "No chats yet.")]));
}

$("search").addEventListener("input", drawChats);

async function openChat(id) {
  if (busy || id === conversationId) return;
  const r = await post("/api/conversation/open", { id });
  if (r.error) return toast(r.error, "error");
  render(r);
  drawChats();
  $("input").focus();
}

async function newChat() {
  if (busy) return;
  const r = await post("/api/conversation/new", {});
  render(r);
  drawChats();
  $("input").focus();
}
$("new-chat").addEventListener("click", newChat);

// ---------- the thread ----------
const inner = () => $("thread-inner");
const atBottom = () => {
  const t = $("thread");
  return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
};
const toBottom = () => {
  const t = $("thread");
  t.scrollTop = t.scrollHeight;
};

function openLink(url) {
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener");
}
const md = (text) => cosMarkdown.render(text, { openLink, rich: true });

function artifactCards(items) {
  return el("div", { class: "msg-artifacts" }, ...items.map((a) => {
    const open = () => (location.href = `/artifact.html?id=${encodeURIComponent(a.id)}`);
    const kind = { image: "Image", page: "Page", doc: "Document" }[a.kind] || "Page";
    return el("figure", { class: `artifact msg-artifact ${a.kind}` },
      el("div", { class: "thumb", role: "link", tabindex: "0", "aria-label": `Open ${a.title}`, onclick: open }, cosArtifacts.preview(a, open)),
      el("figcaption", {}, el("div", { class: "cap-main" }, el("div", { class: "cap-title" }, a.title), el("div", { class: "cap-meta" }, kind))));
  }));
}

function choiceButtons(options) {
  const box = el("div", { class: "choices" });
  for (const text of options) {
    box.append(el("button", { class: "choice", type: "button", onclick: () => !busy && send({ text }) }, text));
  }
  return box;
}

function confirmButtons(items) {
  const box = el("div", { class: "confirms" });
  for (const c of items) {
    const verb = c.verb || "Open";
    const decide = async (cancel) => {
      for (const b of box.querySelectorAll("button")) b.disabled = true;
      const r = await post("/api/actions/confirm", { id: c.id, cancel });
      box.replaceChildren(el("div", { class: "confirm-done" }, r.text || r.error || ""));
      setTimeout(refresh, 300);
    };
    box.append(el("div", { class: "confirm" },
      el("div", { class: "confirm-detail" }, c.detail || c.label),
      el("div", { class: "confirm-actions" },
        el("button", { class: "btn small", type: "button", onclick: () => decide(true) }, "Cancel"),
        el("button", { class: "btn small primary", type: "button", onclick: () => decide(false) }, verb))));
  }
  return box;
}

function offerCard(turn) {
  const o = turn.offer;
  const card = el("div", { class: "offer-card" },
    el("div", { class: "offer-head" }, glyph("spark", "orange"), el("div", { class: "offer-title" }, o.title)),
    el("div", { class: "offer-body" }, md(turn.text)));
  if (turn.artifacts?.length) card.append(artifactCards(turn.artifacts));
  if (o.mode === "offer") {
    if (o.answered) card.append(el("div", { class: "offer-said" }, o.answered === "yes" ? "You said yes" : "Not now"));
    else {
      const actions = el("div", { class: "offer-actions" },
        el("button", {
          class: "btn small", type: "button",
          onclick: async () => {
            for (const b of actions.querySelectorAll("button")) b.disabled = true;
            const r = await post("/api/offers/decline", { id: o.id });
            if (r.error) toast(r.error, "error");
            refresh();
          },
        }, "Not Now"),
        el("button", { class: "btn small primary", type: "button", onclick: () => !busy && send({ text: "Yes, do it.", offer: o.id }) }, "Yes, Do It"));
      card.append(actions);
    }
  }
  if (turn.choices?.length) card.append(choiceButtons(turn.choices));
  return el("div", { class: "msg msg-them" }, card);
}

function turnNode(t) {
  if (t.role === "event") return el("div", { class: "msg-event" }, t.text);
  if (t.offer) return offerCard(t);
  if (t.role === "user") {
    const bubble = el("div", { class: "bubble me" });
    if (t.replyTo) bubble.append(el("div", { class: "reply-to" }, t.replyTo));
    bubble.append(t.text);
    const node = el("div", { class: "msg msg-me" }, bubble);
    if (t.screen) node.append(el("div", { class: "msg-note" }, `Looked at your screen${t.screen.app ? ` · ${t.screen.app}` : ""}`));
    return node;
  }
  const bubble = el("div", { class: `bubble them${t.kind === "error" ? " error" : ""}` });
  if (t.pending && !t.text) bubble.append(el("span", { class: "typing", "aria-label": "Thinking" }, el("i"), el("i"), el("i")));
  else bubble.append(md(t.text));
  const node = el("div", { class: "msg msg-them" }, bubble);
  if (t.artifacts?.length) node.append(artifactCards(t.artifacts));
  if (t.confirm?.length) node.append(confirmButtons(t.confirm));
  if (t.choices?.length) node.append(choiceButtons(t.choices));
  return node;
}

/** Answers under a reply are only for the latest one: once you've said something, they go. */
function pruneChoices() {
  const nodes = [...inner().children];
  const lastMe = nodes.map((n) => n.classList.contains("msg-me")).lastIndexOf(true);
  nodes.forEach((n, i) => i < lastMe && n.querySelectorAll(".choices, .confirms").forEach((c) => c.remove()));
}

function render(c) {
  conversationId = c.id;
  $("thread-title").textContent = c.title || "New chat";
  $("thread-sub").textContent = c.aside ? "A side conversation" : "";
  const nodes = c.turns.map(turnNode);
  inner().replaceChildren(...(nodes.length ? nodes : [emptyState()]));
  turnsShown = c.turns.length;
  pruneChoices();
  toBottom();
}

function emptyState() {
  const ideas = ["What should I do today?", "Draft this week's MLGuerrilla posts", "What did I say about drawcal last week?"];
  return el("div", { class: "thread-empty" },
    el("div", { class: "brand-mark big", "aria-hidden": "true" }, "✦"),
    el("div", { class: "thread-empty-title" }, "What can I do for you?"),
    el("div", { class: "choices starters" }, ...ideas.map((t) => el("button", { class: "choice", type: "button", onclick: () => send({ text: t }) }, t))));
}

/** Pick up what arrived without us: the heartbeat wrote, an agent finished, the pill said something. */
async function refresh() {
  if (busy) return;
  try {
    const c = await get("/api/conversation");
    if (busy) return;
    if (c.id !== conversationId || c.turns.length !== turnsShown) {
      const stick = atBottom() || c.id !== conversationId;
      const was = $("thread").scrollTop;
      render(c);
      if (!stick) $("thread").scrollTop = was;
      loadChats();
    } else if (c.title && $("thread-title").textContent !== c.title) {
      $("thread-title").textContent = c.title;
      loadChats();
    }
  } catch {
    /* the app is restarting */
  }
}

// ---------- sending ----------
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

function setStatus(text) {
  $("status").textContent = text || "Return to send · Shift-Return for a new line";
}

async function send({ text, offer }) {
  const said = String(text || "").trim();
  if (!said || busy) return;
  busy = true;
  $("send").disabled = true;
  $("input").value = "";
  grow();
  inner().querySelector(".thread-empty")?.remove();
  let pending = null;
  let live = "";
  const begin = (user, replyTo) => {
    inner().append(turnNode({ role: "user", text: user, replyTo }));
    pending = turnNode({ role: "assistant", text: "", pending: true });
    inner().append(pending);
    pruneChoices();
    toBottom();
  };
  const fill = (t) => {
    const next = turnNode(t);
    pending.replaceWith(next);
    pending = next;
  };
  setStatus("Thinking…");
  let r;
  try {
    r = await postStream("/api/pill", { text: said, mode: "auto", conversation: conversationId, ...(offer ? { offer } : {}) }, (ev) => {
      if (ev.type === "start") {
        if (ev.conversation && ev.conversation !== conversationId) conversationId = ev.conversation;
        begin(ev.user, ev.replyTo);
      } else if (ev.type === "status") {
        setStatus(ev.text);
      } else if (ev.type === "text" && pending) {
        const stick = atBottom();
        live += ev.delta;
        fill({ role: "assistant", text: live, pending: true });
        if (stick) toBottom();
      }
    });
  } catch (err) {
    r = { kind: "error", text: String(err) };
  }
  if (r.error && !r.text) r = { kind: "error", text: r.error };
  if (!pending) begin(said, r.replyTo);
  fill({ role: "assistant", ...r, confirm: r.confirm });
  pruneChoices();
  toBottom();
  busy = false;
  setStatus("");
  // Its answer has settled: pick up the saved version (offers answered, the chat's new name).
  await refresh();
  setTimeout(loadChats, 4000);
  $("input").focus();
}

// ---------- the box you write in ----------
function grow() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
  $("send").disabled = busy || !t.value.trim();
}
$("input").addEventListener("input", grow);
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send({ text: $("input").value });
  }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send({ text: $("input").value });
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newChat();
  }
});

// Dictation, where the browser has it: speak, it types, you send.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  const mic = $("mic");
  mic.hidden = false;
  let rec = null;
  mic.addEventListener("click", () => {
    if (rec) return rec.stop();
    rec = new Recognition();
    rec.interimResults = true;
    rec.continuous = false;
    const before = $("input").value;
    rec.onresult = (e) => {
      const heard = [...e.results].map((x) => x[0].transcript).join("");
      $("input").value = `${before}${before && !before.endsWith(" ") ? " " : ""}${heard}`;
      grow();
    };
    rec.onend = () => {
      rec = null;
      mic.classList.remove("on");
      setStatus("");
      $("input").focus();
    };
    rec.onerror = (e) => e.error !== "no-speech" && toast(`Dictation stopped: ${e.error}`, "error");
    mic.classList.add("on");
    setStatus("Listening…");
    rec.start();
  });
}

// ---------- start ----------
(async () => {
  try {
    render(await get("/api/conversation"));
  } catch {
    toast("The app isn't answering.", "error");
  }
  await loadChats();
  $("input").focus();
  setInterval(refresh, 8000);
  setInterval(loadChats, 30000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh());
})();
