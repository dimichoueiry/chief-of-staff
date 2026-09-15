import Foundation

/// Decides when you've finished talking. Pure logic with an injected clock, so it
/// can be checked without a microphone (apps/menubar/Checks).
///
/// What you say ends after `pause` seconds in which the microphone heard no voice
/// and no new words arrived. It waits longer when the words so far trail off
/// ("and…", "so um"). Sound that keeps looking like voice while the words stop
/// changing (a TV, a café) only holds the mic open a little longer.
struct Endpointing {
  var pause: TimeInterval
  var noSpeech: TimeInterval = 12
  var maxDuration: TimeInterval = 120
  var trailingExtra: TimeInterval = 1.5
  var stallExtra: TimeInterval = 2.5

  /// Text from stretches the recogniser has already closed.
  private(set) var committed = ""
  /// Text of the stretch being recognised now.
  private(set) var segment = ""
  private let startedAt: Date
  private var lastVoice: Date
  private var lastText: Date

  init(pause: TimeInterval, now: Date = Date()) {
    self.pause = pause
    startedAt = now
    lastVoice = now
    lastText = now
  }

  var text: String { Endpointing.join(committed, segment) }

  /// The microphone level says someone is speaking.
  mutating func voice(at now: Date) {
    lastVoice = now
  }

  /// A transcription update for the current stretch.
  mutating func recognized(_ new: String, at now: Date) {
    // Some recognisers start over after a pause, reporting only the new words: keep the earlier ones.
    if !segment.isEmpty, Endpointing.startedOver(from: segment, to: new) {
      committed = Endpointing.join(committed, segment)
    }
    if new != segment {
      segment = new
      lastText = now
    }
  }

  /// The recogniser closed the current stretch by itself; listening goes on with a fresh one.
  mutating func stretchEnded() {
    committed = text
    segment = ""
  }

  func shouldEnd(at now: Date) -> Bool {
    if now.timeIntervalSince(startedAt) >= maxDuration { return true }
    let said = text
    if said.isEmpty { return now.timeIntervalSince(startedAt) >= noSpeech }
    let wait = Endpointing.trailsOff(said) ? pause + trailingExtra : pause
    let quiet = now.timeIntervalSince(max(lastVoice, lastText))
    return quiet >= wait || now.timeIntervalSince(lastText) >= wait + stallExtra
  }

  // MARK: words

  /// Words a finished sentence rarely ends on. Not prepositions or question words: "what should I work on" is done.
  static let trailingWords: Set<String> = [
    "and", "or", "but", "so", "because", "cause", "then", "if",
    "the", "a", "an", "to", "of", "my", "your", "our", "their", "i",
    "should", "could", "would", "can", "will",
    "um", "uh", "erm", "er", "hmm", "mm",
  ]

  static func words(_ s: String) -> [String] {
    s.lowercased().split { !$0.isLetter && $0 != "'" && $0 != "’" }.map(String.init)
  }

  static func trailsOff(_ s: String) -> Bool {
    let t = s.trimmingCharacters(in: .whitespaces)
    if t.hasSuffix(",") || t.hasSuffix("…") || t.hasSuffix("-") || t.hasSuffix("—") { return true }
    guard let last = words(t).last else { return false }
    return trailingWords.contains(last)
  }

  /// A much shorter text with a different opening is a new stretch, not a revision of the old one.
  static func startedOver(from old: String, to new: String) -> Bool {
    let a = words(old)
    let b = words(new)
    guard !b.isEmpty, b.count * 2 <= a.count else { return false }
    return a.first != b.first
  }

  static func join(_ a: String, _ b: String) -> String {
    if a.isEmpty { return b }
    if b.isEmpty { return a }
    return "\(a) \(b)"
  }
}
