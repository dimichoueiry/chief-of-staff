/* A little markdown, built as DOM nodes (never innerHTML): replies in the chat, and documents the
 * assistant wrote. A reply keeps headings small (a bold line); a document (rich) gets real
 * headings, rules and quotes, the way a written page looks.
 * Plain script, shared with the page as window.cosMarkdown. */
(() => {
  const { el } = window.cosDom;

  function inline(text, openLink) {
    const out = [];
    const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g;
    let last = 0;
    let m;
    const link = (label, url) => el("a", { href: url, onclick: (e) => { e.preventDefault(); openLink(url); } }, label);
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1] !== undefined) out.push(el("strong", {}, ...inline(m[1], openLink)));
      else if (m[2] !== undefined) out.push(el("code", {}, m[2]));
      else if (m[3] !== undefined) out.push(link(m[3], m[4]));
      else if (m[5] !== undefined) out.push(link(m[5], m[5]));
      else out.push(m[6], el("em", {}, m[7]));
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  const defaultOpen = (url) => {
    if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener");
  };

  /** render(text, { openLink, rich }): a fragment to append. */
  function render(text, o = {}) {
    const openLink = o.openLink || defaultOpen;
    const rich = Boolean(o.rich);
    const line1 = (s) => inline(s, openLink);
    const frag = document.createDocumentFragment();
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    let list = null;
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el("p");
      para.forEach((l, i) => (i ? p.append(el("br"), ...line1(l)) : p.append(...line1(l))));
      frag.append(p);
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush();
        list = null;
        const code = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
        frag.append(el("pre", {}, code.join("\n")));
        continue;
      }
      if (rich && /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flush();
        list = null;
        frag.append(el("hr"));
        continue;
      }
      const quote = rich ? /^\s*>\s?(.*)$/.exec(line) : null;
      if (quote) {
        flush();
        list = null;
        const last = frag.lastChild;
        if (last && last.tagName === "BLOCKQUOTE") last.append(el("br"), ...line1(quote[1]));
        else frag.append(el("blockquote", {}, ...line1(quote[1])));
        continue;
      }
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      const num = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (bullet || num) {
        flush();
        const tag = bullet ? "UL" : "OL";
        if (!list || list.tagName !== tag) {
          list = el(tag.toLowerCase());
          if (num && num[1] !== "1") list.setAttribute("start", num[1]);
          frag.append(list);
        }
        // "- [ ] thing" and "- [x] thing" are a checklist: a box, not brackets.
        const text = bullet ? bullet[1] : num[2];
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
        if (task) {
          const done = task[1] !== " ";
          list.classList.add("tasks");
          list.append(el("li", { class: done ? "task done" : "task" }, el("span", { class: "box", "aria-hidden": "true" }, done ? "✓" : ""), ...line1(task[2])));
        } else list.append(el("li", {}, ...line1(text)));
        continue;
      }
      if (!line.trim()) {
        flush();
        list = null;
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) {
        list.lastElementChild.append(el("br"), ...line1(line.trim()));
        continue;
      }
      list = null;
      const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        if (rich) frag.append(el(`h${Math.min(4, heading[1].length + 1)}`, {}, ...line1(heading[2])));
        else frag.append(el("p", {}, el("strong", {}, ...line1(heading[2]))));
      } else para.push(line);
    }
    flush();
    return frag;
  }

  window.cosMarkdown = { render, inline };
})();
