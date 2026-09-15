import Foundation

/// Written by `cos menubar build`: how to start the local server this shell talks to.
struct ShellConfig: Codable {
  var node: String
  var repo: String
  var port: Int

  static var home: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cos") }
  static var file: URL { home.appendingPathComponent("menubar.json") }
  static var logs: URL { home.appendingPathComponent("logs") }

  static func load() -> ShellConfig? {
    guard let data = try? Data(contentsOf: file) else { return nil }
    return try? JSONDecoder().decode(ShellConfig.self, from: data)
  }

  var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }
}

/// The wake phrase settings, kept with the voice settings in ~/.cos/voice.json (`cos voice wake`, `cos voice name`).
struct WakeSettings: Equatable {
  var enabled = true
  var name = "Darius"
  /// both | turn | off: whether the "your turn" chime plays (`cos voice cues`).
  var cues = "both"

  static var file: URL { ShellConfig.home.appendingPathComponent("voice.json") }

  static func load() -> WakeSettings {
    var s = WakeSettings()
    guard let data = try? Data(contentsOf: file), let saved = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return s }
    if let on = saved["wake"] as? Bool { s.enabled = on }
    if let name = (saved["wakeName"] as? String)?.trimmingCharacters(in: .whitespaces), !name.isEmpty { s.name = name }
    if let cues = saved["cues"] as? String { s.cues = cues }
    return s
  }

  /// Turn it on or off, keeping everything else in the file.
  static func setEnabled(_ on: Bool) {
    var saved = (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
    saved["wake"] = on
    try? FileManager.default.createDirectory(at: ShellConfig.home, withIntermediateDirectories: true)
    if let data = try? JSONSerialization.data(withJSONObject: saved, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: file, options: .atomic) }
  }
}

enum Log {
  static func write(_ line: String) {
    let url = ShellConfig.logs.appendingPathComponent("menubar.log")
    try? FileManager.default.createDirectory(at: ShellConfig.logs, withIntermediateDirectories: true)
    let stamp = ISO8601DateFormatter().string(from: Date())
    let text = "\(stamp) \(line)\n"
    if let handle = try? FileHandle(forWritingTo: url) {
      handle.seekToEndOfFile()
      handle.write(text.data(using: .utf8)!)
      try? handle.close()
    } else {
      try? text.write(to: url, atomically: true, encoding: .utf8)
    }
  }
}
