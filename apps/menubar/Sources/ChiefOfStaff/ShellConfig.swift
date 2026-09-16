import Darwin
import Foundation

/// Written by `cos menubar build`: how to start the local server this shell talks to.
struct ShellConfig: Codable {
  var node: String
  var repo: String
  var port: Int

  static var home: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cos") }
  static var file: URL { home.appendingPathComponent("menubar.json") }
  static var logs: URL { home.appendingPathComponent("logs") }

  /// A packaged app (`cos menubar package`) carries its own Node and runtime and runs those, on any Mac, with no
  /// menubar.json. A developer build has neither and reads the file `cos menubar build` wrote.
  static func load() -> ShellConfig? {
    let saved = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(ShellConfig.self, from: $0) }
    if let bundled = bundled(port: saved?.port ?? 4747) { return bundled }
    return saved
  }

  static func bundled(port: Int) -> ShellConfig? {
    let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
    let helpers = contents.appendingPathComponent("Helpers")
    let node = helpers.appendingPathComponent("node")
    let runtime = contents.appendingPathComponent("Resources/runtime")
    let fm = FileManager.default
    guard fm.isExecutableFile(atPath: node.path), fm.fileExists(atPath: runtime.appendingPathComponent("dist/cli/cos.js").path) else { return nil }
    seedHelpers(from: helpers)
    return ShellConfig(node: node.path, repo: runtime.path, port: port)
  }

  /// The prebuilt calendar, screen and player helpers go where the server looks for them (~/.cos/bin), so this Mac
  /// never needs swiftc. A helper already there is replaced only when the bundled one is newer.
  static func seedHelpers(from dir: URL) {
    let fm = FileManager.default
    guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
    let bin = home.appendingPathComponent("bin")
    try? fm.createDirectory(at: bin, withIntermediateDirectories: true)
    for name in names where name.hasPrefix("cos-") {
      let source = dir.appendingPathComponent(name)
      let target = bin.appendingPathComponent(name)
      if let have = modified(target), let bundled = modified(source), have >= bundled { continue }
      try? fm.removeItem(at: target)
      if (try? fm.copyItem(at: source, to: target)) != nil { Log.write("helper \(name) installed from the app") }
    }
  }

  private static func modified(_ url: URL) -> Date? {
    (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
  }

  var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

  /// Whether a server of ours could be started on this port: nothing else is holding it.
  static func free(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var yes: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    return bound == 0
  }

  /// A port to serve on: the usual one, or the next free one after it. Something else on 4747
  /// used to mean the app simply didn't start, with no way to change it but a text editor.
  static func choosePort(preferred: Int, isFree: (Int) -> Bool = ShellConfig.free) -> Int {
    if isFree(preferred) { return preferred }
    for candidate in (preferred + 1)...(preferred + 40) where isFree(candidate) { return candidate }
    return preferred // nothing free nearby: let the server say so
  }
}

/// The wake phrase settings, kept with the voice settings in ~/.cos/voice.json (`cos voice wake`, `cos voice name`).
struct WakeSettings: Equatable {
  /// Off until asked for: an app someone was handed should not be listening to the room on day one.
  var enabled = false
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
  /// Past this, a log is moved aside and started again, so ~/.cos/logs can't grow without end.
  static let maxBytes = 2 * 1024 * 1024

  /// Keep one previous copy (.1) and drop anything older.
  static func rotate(_ url: URL, maxBytes: Int = Log.maxBytes) {
    let fm = FileManager.default
    guard let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > maxBytes else { return }
    let previous = url.appendingPathExtension("1")
    try? fm.removeItem(at: previous)
    try? fm.moveItem(at: url, to: previous)
  }

  static func write(_ line: String) {
    let url = ShellConfig.logs.appendingPathComponent("menubar.log")
    try? FileManager.default.createDirectory(at: ShellConfig.logs, withIntermediateDirectories: true)
    rotate(url)
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
