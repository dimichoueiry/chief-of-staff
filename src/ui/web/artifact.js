/* One picture, page or document, full size, with the two things you do with it: save it, copy it.
 * Everything else about it — changing it, making another — is said to the assistant. */
const { $, el, get } = window.cosDom;
const { toast } = window.cosPage;
const id = new URLSearchParams(location.search).get("id") || "";

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const KINDS = { image: "Picture", page: "Page", doc: "Document" };

function fail(text) {
  $("title").textContent = "Not here";
  $("meta").textContent = text;
  for (const b of document.querySelectorAll("#copy, #raw, #save")) b.remove();
}

/** Copy the picture itself, or the page's HTML. Not every format can go on the clipboard; say so when it can't. */
async function copyIt(a, url) {
  const said = (text) => toast(text, text.startsWith("Copied") ? "" : "error");
  try {
    const res = await fetch(url);
    if (a.kind !== "image") await navigator.clipboard.writeText(await res.text());
    else await navigator.clipboard.write([new ClipboardItem({ [a.mediaType]: await res.blob() })]);
    said(a.kind === "image" ? "Copied the picture" : a.kind === "doc" ? "Copied the text" : "Copied the HTML");
  } catch {
    said(a.kind === "image" ? "This picture can't go on the clipboard. Save it instead." : "Couldn't copy it.");
  }
}

async function load() {
  if (!id) return fail("No id in the address.");
  let a;
  try {
    a = await get(`/api/artifacts?id=${encodeURIComponent(id)}`);
  } catch {
    return fail("The app isn't answering.");
  }
  if (a.error) return fail(a.error);

  const url = `/artifacts/${encodeURIComponent(a.id)}`;
  document.title = `${a.title} — Chief of Staff`;
  $("bar-title").textContent = a.title;
  $("title").textContent = a.title;
  $("meta").textContent = [KINDS[a.kind] || "Page", a.model, when(a.createdAt)].filter(Boolean).join(" · ");
  $("save").href = url;
  $("save").setAttribute("download", a.file);
  $("raw").href = url;
  $("copy").addEventListener("click", () => copyIt(a, url));
  if (a.kind === "doc") {
    const text = await fetch(url).then((r) => r.text()).catch(() => "");
    $("viewer").replaceChildren(el("article", { class: "doc doc-full" }, cosMarkdown.render(text, { rich: true })));
  } else {
    $("viewer").replaceChildren(
      a.kind === "image"
        ? el("img", { src: url, alt: a.title })
        : el("iframe", { src: url, sandbox: "allow-scripts allow-popups", title: a.title }),
    );
  }
  // What it was asked for, so the next ask can start from it rather than from nothing.
  $("prompt").textContent = a.prompt ? `Asked for: ${a.prompt}` : "";
}

load();
