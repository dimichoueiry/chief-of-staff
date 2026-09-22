/* Everything the assistant has made, newest first, as a gallery: each card shows the thing itself.
 * A kept draft needs two things here — save it somewhere of your own, or throw it away. */
const { $, el, get, post, when } = window.cosDom;
const { glyph, toast } = window.cosPage;

let artifacts = [];
let kind = "all";

const KINDS = { image: "Image", page: "Page", doc: "Document" };
const viewUrl = (a) => `/artifact.html?id=${encodeURIComponent(a.id)}`;

/** Delete asks first, in place: the second click is the answer. */
function deleteButton(a) {
  const b = el("button", { class: "btn small plain danger", type: "button", title: "Delete", "aria-label": `Delete ${a.title}` }, "Delete");
  let armed = false;
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      b.textContent = "Delete?";
      setTimeout(() => {
        armed = false;
        if (b.isConnected) b.textContent = "Delete";
      }, 3500);
      return;
    }
    b.disabled = true;
    const r = await post("/api/artifacts/delete", { id: a.id });
    if (r.error) return toast(r.error, "error");
    toast("Deleted");
    artifacts = r.artifacts ?? artifacts.filter((x) => x.id !== a.id);
    draw();
  });
  return b;
}

function card(a) {
  const open = () => (location.href = viewUrl(a));
  const thumb = el("div", { class: "thumb", role: "link", tabindex: "0", "aria-label": `Open ${a.title}`, onclick: open });
  thumb.addEventListener("keydown", (e) => e.key === "Enter" && open());
  thumb.append(cosArtifacts.preview(a, open));
  return el("figure", { class: "artifact" },
    thumb,
    el("figcaption", {},
      el("div", { class: "cap-main" }, el("div", { class: "cap-title", title: a.title }, a.title), el("div", { class: "cap-meta" }, `${KINDS[a.kind] || "Page"} · ${when(a.createdAt)}`)),
      el("div", { class: "cap-actions" },
        el("a", { class: "btn small plain", href: cosArtifacts.fileUrl(a.id), download: a.file, onclick: (e) => e.stopPropagation() }, "Save"),
        deleteButton(a))));
}

function draw() {
  const shown = artifacts.filter((a) => kind === "all" || a.kind === kind);
  $("count").textContent = artifacts.length ? `${artifacts.length} made for you · kept in ~/.cos/artifacts` : "Nothing yet.";
  for (const b of $("filters").children) b.setAttribute("aria-selected", String(b.dataset.kind === kind));
  $("gallery").replaceChildren(
    ...(shown.length
      ? shown.map(card)
      : [el("div", { class: "group", style: "grid-column:1/-1" }, el("p", { class: "empty-note" }, artifacts.length ? "Nothing of that kind yet." : "Nothing yet. Ask it for a post, a picture, a content calendar or a write-up."))]),
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
  .catch(() => toast("The app isn't answering.", "error"));
