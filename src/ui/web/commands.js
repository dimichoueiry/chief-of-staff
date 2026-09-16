/* Spoken commands said to the assistant by name: "Darius, by the way…", "Darius, back on topic",
 * "Darius, start a new chat". The name in front is what tells a command from ordinary talk
 * ("quick question" on its own is just a question). It is matched the way the native wake phrase
 * does it, allowing for how the recogniser mishears a name ("Darias", "Marius", "dare us"), and
 * never on its own, so talking about someone called Darius does nothing.
 * Plain script, shared with the page as window.cosCommands; app.js decides what each command does. */
(function () {
  let name = "darius";

  /** Edit distance between two words. */
  function distance(a, b) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const current = row[j];
        row[j] = a[i - 1] === b[j - 1] ? previous : Math.min(previous, row[j], row[j - 1]) + 1;
        previous = current;
      }
    }
    return row[b.length];
  }

  /** Lowercase, apostrophes kept, other punctuation dropped: the words of the name as the recogniser writes them. */
  function clean(text) {
    return String(text || "").toLowerCase().replace(/’/g, "'").replace(/[^\p{L}\p{N}']+/gu, "").replace(/^'+|'+$/g, "");
  }

  /** The name, or one of its mishearings ("Darias", "Marius"), but not "various". */
  function isName(word) {
    let w = clean(word);
    if (w.endsWith("'s")) w = w.slice(0, -2);
    if (!w || Math.abs(w.length - name.length) > 2) return false;
    const d = distance(w, name);
    // One slip anywhere; two only when it starts right and the name is long enough to take it.
    return d <= 1 || (name.length >= 5 && d <= 2 && w[0] === name[0]);
  }

  const LEAD = /^(?:(?:hey|hi|ok|okay|yo)[,!]?\s+)?/iu;
  const WORD = /^([\p{L}\p{N}'’-]+)([,.!:;]*)(\s*)/u;

  /**
   * "<name>, <rest>": whether the text is addressed to the assistant by name, and what comes after
   * the name. Not addressed (or the name alone): named is false and rest is the whole text.
   */
  function addressed(text) {
    const t = String(text || "").trim();
    const asIs = { named: false, rest: t };
    let pos = LEAD.exec(t)[0].length;
    const first = WORD.exec(t.slice(pos));
    if (!first) return asIs;
    if (isName(first[1])) pos += first[0].length;
    else {
      // The recogniser split the name in two ("dare us"): a short first word and no punctuation between.
      const second = first[1].length <= 4 && !first[2] ? WORD.exec(t.slice(pos + first[0].length)) : null;
      if (!second || !isName(first[1] + second[1])) return asIs;
      pos += first[0].length + second[0].length;
    }
    const rest = t.slice(pos).trim();
    return rest ? { named: true, rest } : asIs;
  }

  // "By the way, what's the capital of France?" / "quick question: …" / "side note" on its own.
  // The recogniser rarely writes commas, so the words alone must do; "but" or "though" after them is skipped.
  const ASIDE_START =
    /^(?:(?:oh|um|so|hey|now|and)[,]?\s+)?(?:by the way|side ?note|quick (?:question|aside|one|thing)|off[- ]topic(?: question)?|unrelated(?: question| thing)?|(?:a |small |little |quick )?tangent|aside)\b[,.!:;]*\s*(?:(?:but|though)[,]?\s+)?(.*)$/isu;
  // "Back on topic", "okay back to what we were saying", "where were we?", "back to it".
  const ASIDE_END =
    /^(?:(?:ok(?:ay)?|alright|right|and|now|so|anyway|thanks|great|perfect|cool)[,.]?\s+)*(?:(?:let'?s\s+)?(?:go|get|come)\s+)?(?:back (?:on|to) (?:the )?(?:topic|main (?:chat|topic|conversation|thread|question|thing)|what we were (?:saying|doing|talking about|on)|where we were|it|that|our (?:chat|conversation|topic))|where were we|end (?:the |this |of )?aside|(?:resume|continue) (?:the |our )?(?:main )?(?:chat|conversation|topic))[.!?]*$/iu;

  /** What follows a "by the way": the quick question (may be empty), or null when this isn't one. */
  function aside(rest) {
    const m = ASIDE_START.exec(String(rest || "").trim());
    return m ? m[1].trim() : null;
  }

  /** "Back on topic" and its variants. */
  function backOnTopic(rest) {
    return ASIDE_END.test(String(rest || "").trim());
  }

  window.cosCommands = {
    /** The name it answers to (cos voice name). */
    setName(n) {
      const w = clean(n);
      if (w) name = w;
    },
    get name() {
      return name;
    },
    isName,
    addressed,
    aside,
    backOnTopic,
  };
})();
