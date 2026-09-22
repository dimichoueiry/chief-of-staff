/* Everything the assistant has made, newest first: the same cards as the chat, with the two
 * things a kept draft needs — save it somewhere of your own, or throw it away. */
const { $, el, get, post, when } = window.cosDom;

let artifacts = [];
let kind = "all";

const say = (text, tone = "") => {
  $("said").textContent = text;
  $("said").dataset.tone = tone;
};

const KINDS = { image: "Picture", page: "Page", doc: "Document" };
const label = (a) => `${KINDS[a.kind] || "Page"} · ${when(a.createdAt)}`;

/** Delete asks first, in place: the second tap is the answer. */
function deleteButton(a) {
  const button = el("button", { class: "chip", onclick: () => ask() }, "delete");
  const ask = () => {
    button.textContent = "sure?";
    button.className = "chip chip-kill";
    button.onclick = null;
    button.addEventListener("click", remove, { once: true });
    setTimeout(() => {
      if (!button.isConnected || button.textContent !== "sure?") return;
      button.textContent = "delete";
      button.className = "chip";
      button.replaceWith(deleteButton(a));
    }, 4000);
  };
  const remove = async () => {
    button.disabled = true;
    const r = await post("/api/artifacts/delete", { id: a.id });
    if (r.error) return say(r.error, "error");
    say(r.message);
    artifacts = r.artifacts ?? [];
    draw();
  };
  return button;
}

function draw() {
  const shown = artifacts.filter((a) => kind === "all" || a.kind === kind);
  $("count").textContent = artifacts.length
    ? `${shown.length} of ${artifacts.length} · they live in ~/.cos/artifacts`
    : "Nothing yet.";
  for (const b of $("filters").children) b.className = b.dataset.kind === kind ? "chip chip-accent" : "chip";
  $("gallery").replaceChildren(
    ...(shown.length
      ? shown.map((a) =>
          cosArtifacts.card(a, {
            meta: label(a),
            extra: [el("a", { class: "chip", href: cosArtifacts.fileUrl(a.id), download: a.file }, "save"), deleteButton(a)],
          }),
        )
      : [el("p", { class: "empty" }, artifacts.length ? "Nothing of that kind yet." : "Nothing yet. Ask for a post, a picture, a content calendar or a write-up.")]),
  );
}

for (const b of $("filters").children) {
  b.addEventListener("click", () => {
    kind = b.dataset.kind;
    draw();
  });
}

get("/api/artifacts")
  .then((r) => {
    artifacts = r.artifacts ?? [];
    draw();
  })
  .catch(() => say("The app isn't answering.", "error"));
