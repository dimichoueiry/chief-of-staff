/// What to tell someone when Microphone or Speech Recognition is off, so the wake menu, its
/// alert, and a failed "Talk" all name the one that's actually off instead of shrugging at both.
/// Pure logic (no AVFoundation/Speech calls), so it can be checked without a microphone
/// (apps/menubar/Checks).
enum MicSpeechCopy {
  /// "Microphone", "Speech Recognition", or "Microphone and Speech Recognition" — whichever's off.
  /// Nil when both are on.
  static func label(microphoneGranted: Bool, speechGranted: Bool) -> String? {
    switch (microphoneGranted, speechGranted) {
    case (true, true): return nil
    case (false, true): return "Microphone"
    case (true, false): return "Speech Recognition"
    case (false, false): return "Microphone and Speech Recognition"
    }
  }

  /// The label plus "is"/"are off", e.g. "Microphone is off": for the wake menu's subtitle.
  static func problem(microphoneGranted: Bool, speechGranted: Bool) -> String? {
    guard let label = label(microphoneGranted: microphoneGranted, speechGranted: speechGranted) else { return nil }
    let verb = (!microphoneGranted && !speechGranted) ? "are" : "is"
    return "\(label) \(verb) off"
  }

  /// What to say right after "Talk" fails to start because of it: what's off, that typing still
  /// works meanwhile, and exactly where to fix it. Empty when both are already on.
  static func recoveryMessage(microphoneGranted: Bool, speechGranted: Bool) -> String {
    guard let label = label(microphoneGranted: microphoneGranted, speechGranted: speechGranted) else { return "" }
    let plural = !microphoneGranted && !speechGranted
    let verb = plural ? "are" : "is"
    let switchThem = plural ? "Switch them on" : "Switch it on"
    return "\(label) \(verb) off, so it can't hear you — typing still works. \(switchThem) under ✦ › Permissions, then try again."
  }
}
