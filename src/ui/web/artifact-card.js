/* One card for something the assistant made, drawn the same way wherever it appears: under a
 * reply in the chat, and in the gallery. The preview is the thing itself — the picture, or the
 * page as it will look, shrunk and not clickable, so clicking anywhere opens it properly.
 * Plain script, shared with the page as window.cosArtifacts. */
(() => {
  const { el } = window.cosDom;

  const fileUrl = (id) => `/artifacts/${encodeURIComponent(id)}`;
  const viewUrl = (id) => `/artifact.html?id=${encodeURIComponent(id)}`;

  function preview(a, onOpen) {
    return a.kind === "image"
      ? el("img", { src: fileUrl(a.id), alt: a.title, onclick: onOpen })
      : el("div", { class: "page-preview", onclick: onOpen },
          el("iframe", { src: fileUrl(a.id), sandbox: "allow-scripts", title: a.title, tabindex: "-1" }));
  }

  /**
   * card(artifact, { open, meta, extra }): `open` is what a click does, `meta` a line under the
   * name, `extra` any buttons the page wants beside "open".
   */
  function card(a, o = {}) {
    const open = o.open ?? (() => window.open(viewUrl(a.id), "_blank", "noopener"));
    return el("figure", { class: `artifact ${a.kind}` },
      preview(a, open),
      el("figcaption", {},
        el("span", { class: "name" },
          a.title,
          ...(o.meta ? [el("span", { class: "meta" }, o.meta)] : [])),
        el("button", { class: "chip", onclick: open }, "open"),
        ...(o.extra ?? [])));
  }

  window.cosArtifacts = { fileUrl, viewUrl, preview, card };
})();
