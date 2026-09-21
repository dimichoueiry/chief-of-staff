/* The small things every page here needs: find a node, make one, GET, POST, say when.
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

  /** A time as a person would say it: the clock today, "yesterday", a weekday this week, then a date. */
  function when(iso) {
    const d = new Date(iso);
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
    if (days === 0) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (days === 1) return "yesterday";
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  window.cosDom = { $, el, get, post, when };
})();
