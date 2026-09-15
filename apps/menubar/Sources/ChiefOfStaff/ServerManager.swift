import Foundation

/// Starts `cos ui` as a child process if nothing is already listening, and stops it on quit.
final class ServerManager {
  let config: ShellConfig
  private var process: Process?

  init(config: ShellConfig) { self.config = config }

  func ensureRunning(_ done: @escaping (Bool) -> Void) {
    ping { alive in
      if alive { done(true); return }
      self.start()
      self.waitUntilUp(triesLeft: 60, done)
    }
  }

  func ping(_ done: @escaping (Bool) -> Void) {
    var req = URLRequest(url: config.baseURL.appendingPathComponent("api/projects"))
    req.timeoutInterval = 1
    URLSession.shared.dataTask(with: req) { _, response, _ in
      let ok = (response as? HTTPURLResponse)?.statusCode == 200
      DispatchQueue.main.async { done(ok) }
    }.resume()
  }

  private func waitUntilUp(triesLeft: Int, _ done: @escaping (Bool) -> Void) {
    ping { alive in
      if alive { done(true); return }
      if triesLeft <= 0 { done(false); return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
        self.waitUntilUp(triesLeft: triesLeft - 1, done)
      }
    }
  }

  private func start() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: config.node)
    p.arguments = ["\(config.repo)/dist/cli/cos.js", "ui", "--port", "\(config.port)", "--no-open"]
    p.currentDirectoryURL = URL(fileURLWithPath: config.repo)
    var env = ProcessInfo.processInfo.environment
    let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    env["PATH"] = (env["PATH"].map { "\($0):\(extra)" }) ?? extra
    p.environment = env
    try? FileManager.default.createDirectory(at: ShellConfig.logs, withIntermediateDirectories: true)
    let log = ShellConfig.logs.appendingPathComponent("menubar-server.log")
    if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
    if let handle = try? FileHandle(forWritingTo: log) {
      handle.seekToEndOfFile()
      p.standardOutput = handle
      p.standardError = handle
    }
    do {
      try p.run()
      process = p
      Log.write("server started pid \(p.processIdentifier)")
    } catch {
      Log.write("server failed to start: \(error)")
    }
  }

  func stop() {
    guard let p = process, p.isRunning else { return }
    p.terminate()
    Log.write("server stopped")
  }

  // ---- small JSON helpers the menu uses ----

  func getJSON(_ path: String, _ done: @escaping (Any?) -> Void) {
    URLSession.shared.dataTask(with: config.baseURL.appendingPathComponent(path)) { data, _, _ in
      let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
      DispatchQueue.main.async { done(obj) }
    }.resume()
  }

  func postJSON(_ path: String, _ body: [String: Any], _ done: ((Any?) -> Void)? = nil) {
    var req = URLRequest(url: config.baseURL.appendingPathComponent(path))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    URLSession.shared.dataTask(with: req) { data, _, _ in
      let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
      DispatchQueue.main.async { done?(obj) }
    }.resume()
  }
}
