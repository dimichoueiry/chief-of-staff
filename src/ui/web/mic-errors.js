/* What to tell someone when the browser's own microphone (used only when the pill is opened in a
 * plain browser tab, not the native app) fails, so a blocked or missing microphone never just
 * goes quiet. Plain script, shared with the page as window.cosMicErrors; app.js decides when to
 * show it. Error codes: https://developer.mozilla.org/docs/Web/API/SpeechRecognitionErrorEvent/error */
(function () {
  /** The status text for a SpeechRecognition error, or "" when it needs none (nothing went wrong). */
  function messageFor(error) {
    switch (error) {
      case "not-allowed":
      case "service-not-allowed":
        return "This browser blocked the microphone — typing still works. Allow it from the address bar, then try again.";
      case "audio-capture":
        return "No microphone found — typing still works.";
      case "no-speech":
      case "aborted":
        return "";
      default:
        return "Couldn't use the microphone — typing still works.";
    }
  }

  window.cosMicErrors = { messageFor };
})();
