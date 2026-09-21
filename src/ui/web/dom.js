/* The four things every page here needs: find a node, make one, GET, POST.
 * Plain script, shared with the page as window.cosDom. */
(() => {
  const $ = (id) => document.getElementById(id);

  /** el("button", { class: "chip", onclick: fn }, "save") — "on…" keys become listeners. */
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children) n.append(c);
    return n;
  }

  async function get(url) {
    const r = await fetch(url);
    return r.json();
  }

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  }

  window.cosDom = { $, el, get, post };
})();
