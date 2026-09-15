import Foundation

/// What was said to the assistant by name.
enum WakeCommand: String, Equatable {
  /// "Darius wake up", "hey Darius": start listening.
  case wake
  /// "Darius listen", "Darius stop", "Darius wait": stop talking and listen.
  case listen
  /// "Darius sleep", "Darius go to sleep", "Darius that's all": stop and close.
  case sleep
}

/// Finds "<name> <command>" in what the recogniser heard, allowing for how it mishears a name
/// ("Darias", "Dorius", "Marius") but never matching the name on its own, so talking about
/// someone called Darius does nothing. Only the last command said counts.
struct WakePhrase {
  let name: String

  init(name: String) {
    self.name = WakePhrase.words(name).joined()
  }

  /// Words to bias the recogniser towards, so it hears the name and commands at all.
  var hints: [String] {
    let shown = name.prefix(1).uppercased() + name.dropFirst()
    return [shown, "\(shown) wake up", "hey \(shown)", "\(shown) listen", "\(shown) stop", "\(shown) sleep", "\(shown) go to sleep"]
  }

  private static let commands: [(words: [String], command: WakeCommand)] = [
    (["go", "to", "sleep"], .sleep), (["sleep"], .sleep), (["good", "night"], .sleep), (["goodnight"], .sleep),
    (["that's", "all"], .sleep), (["go", "away"], .sleep), (["goodbye"], .sleep), (["bye"], .sleep),
    (["listen", "to", "me"], .listen), (["listen"], .listen), (["stop", "talking"], .listen), (["stop"], .listen),
    (["hold", "on"], .listen), (["wait"], .listen), (["shush"], .listen),
    (["wake", "up"], .wake), (["wakeup"], .wake), (["wake"], .wake), (["are", "you", "there"], .wake), (["you", "there"], .wake),
  ]

  /// Lowercase words, keeping apostrophes ("that's") and dropping other punctuation.
  static func words(_ text: String) -> [String] {
    let cleaned = text.lowercased()
      .replacingOccurrences(of: "’", with: "'")
      .map { $0.isLetter || $0.isNumber || $0 == "'" ? $0 : " " }
    return String(cleaned).split(separator: " ").map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "'")) }.filter { !$0.isEmpty }
  }

  /// The last "<name> <command>" in the text, or nil.
  func find(in text: String) -> WakeCommand? {
    let w = Self.words(text)
    var found: WakeCommand?
    var i = 0
    while i < w.count {
      guard let used = nameAt(w, i) else { i += 1; continue }
      var next = i + used
      if next < w.count, w[next] == "please" { next += 1 }
      if let (length, command) = commandAt(w, next) {
        found = command
        i = next + length
        continue
      }
      // "hey Darius" with nothing after it wakes it too.
      if i > 0, ["hey", "hi", "ok", "okay", "yo"].contains(w[i - 1]), next == w.count { found = .wake }
      i += used
    }
    return found
  }

  /// How many words at i make up the name (one, or two the recogniser split: "dare us"), or nil.
  private func nameAt(_ w: [String], _ i: Int) -> Int? {
    if isName(w[i]) { return 1 }
    if i + 1 < w.count, w[i].count <= 4, isName(w[i] + w[i + 1]) { return 2 }
    return nil
  }

  private func isName(_ word: String) -> Bool {
    var word = word
    if word.hasSuffix("'s") { word = String(word.dropLast(2)) }
    guard abs(word.count - name.count) <= 2, let first = word.first, let nameFirst = name.first else { return false }
    // One slip anywhere ("Marius", "Darias"); two only when it starts right ("Darrious"), so "various" isn't it.
    let distance = Self.distance(word, name)
    return distance <= 1 || (name.count >= 5 && distance <= 2 && first == nameFirst)
  }

  private func commandAt(_ w: [String], _ i: Int) -> (Int, WakeCommand)? {
    for (words, command) in Self.commands where i + words.count <= w.count && Array(w[i..<(i + words.count)]) == words {
      return (words.count, command)
    }
    return nil
  }

  /// Edit distance between two words.
  static func distance(_ a: String, _ b: String) -> Int {
    let a = Array(a), b = Array(b)
    if a.isEmpty { return b.count }
    if b.isEmpty { return a.count }
    var row = Array(0...b.count)
    for i in 1...a.count {
      var previous = row[0]
      row[0] = i
      for j in 1...b.count {
        let current = row[j]
        row[j] = a[i - 1] == b[j - 1] ? previous : min(previous, row[j], row[j - 1]) + 1
        previous = current
      }
    }
    return row[b.count]
  }
}
