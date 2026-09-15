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
