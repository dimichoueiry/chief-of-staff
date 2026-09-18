/* What to tell the pill when listening or speaking doesn't go as planned: no voice set up, a
 * failed read-aloud, or the browser's own speech recognition erroring out (permissions, no mic,
 * no connection). Pure text decisions, with no page to poke at, so app.js and its tests agree on
 * the wording. Plain script, shared with the page as window.cosVoiceStatus. */
(function () {
  /**
   * What POST /api/speak came back with: null when it read fine or was stopped on purpose
   * (Esc, the stop button, talking over it), else a message worth showing.
   */
  function forSpeakResult(r) {
    if (!r) return { tone: "error", text: "Couldn't reach the app, so it wasn't read aloud." };
    if (r.stopped) return null;
    if (r.muted) return { tone: "error", text: "No voice is set up — the reply's in the chat." };
    if (r.error) return { tone: "error", text: "Couldn't read that aloud — the reply's in the chat." };
    return null;
  }

  /**
   * A SpeechRecognition error code, as the browser fallback hears it (the native shell listens
   * itself and never sees these). Null for ones worth staying quiet about.
   */
  function forSpeechError(code) {
    switch (code) {
      case "not-allowed":
      case "service-not-allowed":
        return { tone: "error", text: "Microphone access is blocked — check this site's permissions." };
      case "audio-capture":
        return { tone: "error", text: "No microphone found." };
      case "network":
        return { tone: "error", text: "Speech recognition needs a connection." };
      case "no-speech":
        return { tone: "", text: "Didn't catch that — try again." };
      // "aborted": the app or the person stopped it on purpose; nothing to say.
      default:
        return null;
    }
  }

  window.cosVoiceStatus = { forSpeakResult, forSpeechError };
})();
