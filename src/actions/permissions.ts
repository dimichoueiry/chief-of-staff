/**
 * The macOS permissions Chief of Staff uses, and the exact System Settings page
 * for each, so "open the Full Disk Access setting" lands on the right list
 * instead of System Settings' front page.
 *
 * They belong to the app bundle, so the server and helpers it starts share them.
 * macOS ties each one to the exact build: after a rebuild the old switch still
 * shows "on" but no longer applies (`cos menubar build` clears them for that reason).
 */

export interface PrivacyPane {
  name: string;
  /** System Settings' anchor for the list, e.g. Privacy_AllFiles. */
  anchor: string;
  /** How people say it: "full disk access", "screen recording settings". */
  words: RegExp;
}

export const PRIVACY_PANES: PrivacyPane[] = [
  { name: "Full Disk Access", anchor: "Privacy_AllFiles", words: /\bfull[ -]?disk(?: access)?\b|\bdisk access\b/i },
  { name: "Screen & System Audio Recording", anchor: "Privacy_ScreenCapture", words: /\bscreen (?:(?:and|&) system audio )?recording\b|\bscreen (?:capture|sharing) (?:permissions?|settings?)\b/i },
  { name: "Accessibility", anchor: "Privacy_Accessibility", words: /\baccessibility\b/i },
  { name: "Microphone", anchor: "Privacy_Microphone", words: /\bmicrophone (?:permissions?|settings?|access)\b|\bmic (?:permissions?|settings?|access)\b/i },
  { name: "Speech Recognition", anchor: "Privacy_SpeechRecognition", words: /\bspeech recognition\b/i },
];

export function paneUrl(pane: PrivacyPane): string {
  return `x-apple.systempreferences:com.apple.preference.security?${pane.anchor}`;
}

/** The permission page someone means, if they named one. */
export function findPane(target: string): PrivacyPane | null {
  return PRIVACY_PANES.find((p) => p.words.test(target)) ?? null;
}

/** Said when a switch looks on but does nothing. */
export const STALE_SWITCH =
  "If Chief of Staff is already on there, that switch is from an older build: remove it with −, add it back with +, and reopen the app.";
