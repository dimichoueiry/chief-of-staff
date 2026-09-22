/* The window every page of its own sits in: the sidebar, icons in coloured squares, the toolbar
 * that frosts once the page scrolls under it, and a quiet toast for "saved". Plain script,
 * shared as window.cosPage. A page puts <div class="window" data-page="…"> around its content. */
(() => {
  const { el } = window.cosDom;

  const PATHS = {
    pulse: "M3 12h4l3-8 4 16 3-8h4",
    target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    book: "M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19",
    grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    spark: "M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z",
    heart: "M12 20s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.65-7 10-7 10z",
    bell: "M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21a2 2 0 0 0 4 0",
    repeat: "M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4",
    globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
    terminal: "M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4",
    agent: "M7 8h10v9H7zM12 4v4M9.5 12h.01M14.5 12h.01M4 12h3M17 12h3",
    cursor: "M5 3l14 8-6.5 1.5L10 19z",
    check: "M5 12.5l4.5 4.5L19 7.5",
    doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
    person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 21a7.5 7.5 0 0 1 15 0",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2",
    note: "M5 4h14v12l-4 4H5zM15 20v-4h4",
    photo: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01",
    page: "M4 5h16v14H4zM4 9h16M8 7h.01",
    x: "M6 6l12 12M18 6L6 18",
  };

  /** An SF-Symbols-like line glyph, in a coloured rounded square unless `bare`. */
  function glyph(name, color = "gray", bare = false) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", PATHS[name] || PATHS.check);
    svg.append(path);
    return bare ? svg : el("span", { class: `glyph ${color}` }, svg);
  }

  const NAV = [
    { id: "activity", title: "Activity", href: "/activity.html", icon: "pulse", color: "orange" },
    { id: "goals", title: "Goals", href: "/you.html#goals", icon: "target", color: "green" },
    { id: "memory", title: "Memory", href: "/you.html#memory", icon: "book", color: "indigo" },
    { id: "artifacts", title: "Artifacts", href: "/artifacts.html", icon: "grid", color: "blue" },
    { id: "soul", title: "Soul", href: "/settings.html", icon: "spark", color: "pink" },
  ];

  function sidebar(current) {
    const list = el("ul", { class: "nav" });
    for (const n of NAV) {
      const a = el("a", { href: n.href, ...(n.id === current ? { "aria-current": "page" } : {}) }, glyph(n.icon, n.color), el("span", {}, n.title));
      a.dataset.nav = n.id;
      list.append(el("li", {}, a));
    }
    return el("nav", { class: "sidebar", "aria-label": "Chief of Staff" },
      el("div", { class: "brand" }, el("span", { class: "brand-mark", "aria-hidden": "true" }, "✦"), el("span", { class: "brand-name" }, "Chief of Staff")),
      list);
  }

  /** Mark which sidebar item is the page now (Goals and Memory share one page). */
  function setCurrent(id) {
    for (const a of document.querySelectorAll(".nav a")) {
      if (a.dataset.nav === id) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  }

  let toastTimer = null;
  function toast(text, tone = "") {
    let t = document.querySelector(".toast");
    if (!t) {
      t = el("div", { class: "toast", role: "status", "aria-live": "polite" });
      document.body.append(t);
    }
    if (!text) return t.classList.remove("on");
    t.textContent = text;
    t.dataset.tone = tone;
    t.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("on"), tone === "error" ? 6000 : 2600);
  }

  /** A row in a grouped list: glyph (or any node), title, subtitle, and what trails on the right. */
  function item({ tag = "div", icon, title, sub, detail, trail = [], onclick, cls = "" } = {}) {
    const node = el(tag, { class: `item ${cls}`.trim(), ...(tag === "button" ? { type: "button" } : {}) });
    if (onclick) node.addEventListener("click", onclick);
    if (icon) node.append(icon);
    const main = el("div", { class: "item-main" }, el("div", { class: "item-title" }, title));
    if (sub) main.append(el("div", { class: "item-sub" }, sub));
    if (detail) main.append(el("div", { class: "item-detail" }, detail));
    node.append(main);
    if (trail.length) node.append(el("div", { class: "item-trail" }, ...trail));
    return node;
  }

  function group(title, rows, { aside, foot } = {}) {
    const out = [];
    if (title) out.push(el("div", { class: "group-head" }, el("h2", {}, title), ...(aside ? [el("span", { class: "aside" }, aside)] : [])));
    out.push(el("div", { class: "group" }, ...rows));
    if (foot) out.push(el("p", { class: "group-foot" }, foot));
    return out;
  }

  // Put the page's own content inside the window, next to the sidebar.
  const win = document.querySelector(".window");
  if (win) {
    win.prepend(sidebar(win.dataset.page));
    const content = win.querySelector(".content");
    content?.addEventListener("scroll", () => content.classList.toggle("scrolled", content.scrollTop > 8), { passive: true });
  }

  window.cosPage = { glyph, toast, item, group, setCurrent };
})();
