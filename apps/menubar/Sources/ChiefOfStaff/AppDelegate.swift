import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var statusItem: NSStatusItem!
  private var panel: PillPanel!
  private var server: ServerManager!
  private let hotkeys = HotkeyMonitor()
  private let speech = SpeechListener()
  private let focusMenu = NSMenu()
  private var fnItem: NSMenuItem!
  private var view = "pill"
  private var pageState = "idle"
  private var ready = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard let config = ShellConfig.load() else {
      alert("Chief of Staff is not set up yet.", "Run `npm run cos -- menubar build` in the repo; it writes ~/.cos/menubar.json.")
      NSApp.terminate(nil)
      return
    }
    server = ServerManager(config: config)
    buildStatusItem()

    panel = PillPanel()
    panel.onMessage = { [weak self] msg in self?.handle(message: msg) }
    panel.onResignKey = { [weak self] in
      guard let self else { return }
      // Clicking elsewhere dismisses, unless it is still working for you.
      if self.pageState == "idle" && !self.speech.listening { self.panel.hide() }
    }

    hotkeys.onFnDoubleTap = { [weak self] in self?.summon(listen: true) }
    hotkeys.onShortcut = { [weak self] in self?.summon(listen: false) }
    hotkeys.start()
    let defaults = UserDefaults.standard
    if !HotkeyMonitor.accessibilityTrusted(prompt: false) && !defaults.bool(forKey: "askedAccessibility") {
      defaults.set(true, forKey: "askedAccessibility")
      _ = HotkeyMonitor.accessibilityTrusted(prompt: true)
    }

    speech.onPartial = { [weak self] text in self?.panel.eval("cosShell.transcript(\(Self.js(text)), false)") }
    speech.onFinal = { [weak self] text in self?.panel.eval("cosShell.transcript(\(Self.js(text)), true)") }
    speech.onError = { [weak self] err in self?.panel.eval("cosShell.status(\(Self.js(err)))") }

    server.ensureRunning { [weak self] ok in
      guard let self else { return }
      guard ok else {
        self.alert("The local server did not start.", "See ~/.cos/logs/menubar-server.log. Is the repo built (npm run build)?")
        return
      }
      self.ready = true
      self.panel.load(URL(string: "\(config.baseURL)/?shell=1&mode=pill")!)
      Log.write("ready at \(config.baseURL)")
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    hotkeys.stop()
    speech.cancel()
    server?.stop()
  }

  // MARK: status item

  private func buildStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let button = statusItem.button {
      button.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Chief of Staff")
      button.image?.isTemplate = true
    }
    let menu = NSMenu()
    menu.delegate = self
    add(menu, "Today's brief", #selector(showBrief), key: "b")
    add(menu, "Talk   (fn fn)", #selector(talk))
    add(menu, "Ask or capture…   (⌥Space)", #selector(type))
    let focus = NSMenuItem(title: "Focus a project", action: nil, keyEquivalent: "")
    focus.submenu = focusMenu
    menu.addItem(focus)
    add(menu, "Read the brief aloud", #selector(readAloud))
    menu.addItem(.separator())
    add(menu, "Rebuild the brief", #selector(rebuildBrief))
    add(menu, "Open in browser", #selector(openInBrowser))
    fnItem = add(menu, "Enable double-tap Fn…", #selector(enableFn))
    menu.addItem(.separator())
    add(menu, "Quit Chief of Staff", #selector(quit), key: "q")
    statusItem.menu = menu
  }

  @discardableResult
  private func add(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.target = self
    menu.addItem(item)
    return item
  }

  func menuWillOpen(_ menu: NSMenu) {
    guard menu !== focusMenu else { return }
    let trusted = HotkeyMonitor.accessibilityTrusted(prompt: false)
    fnItem.title = trusted ? "Double-tap Fn: on" : "Enable double-tap Fn (Accessibility)…"
    fnItem.state = trusted ? .on : .off
    refreshFocusMenu()
  }

  private func refreshFocusMenu() {
    guard ready else { return }
    server.getJSON("api/projects") { [weak self] obj in
      guard let self else { return }
      self.focusMenu.removeAllItems()
      let rows = (obj as? [[String: Any]]) ?? []
      if rows.isEmpty {
        self.focusMenu.addItem(NSMenuItem(title: "No projects yet", action: nil, keyEquivalent: ""))
        return
      }
      for row in rows {
        guard let name = row["name"] as? String else { continue }
        let parked = (row["status"] as? String) == "parked"
        let item = NSMenuItem(title: parked ? "\(name)  (parked)" : name, action: #selector(self.focusProject(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = name
        self.focusMenu.addItem(item)
      }
    }
  }

  // MARK: actions

  private func setView(_ v: String) {
    view = v
    panel.eval("cosShell.setMode(\(Self.js(v)))")
  }

  private func summon(listen: Bool) {
    guard ready else { return }
    if panel.isVisible && view == "pill" {
      if speech.listening {
        speech.stop() // second double-tap: done talking
        return
      }
      if !listen || pageState == "idle" {
        panel.eval("cosShell.dismiss()")
        panel.hide()
        return
      }
    }
    setView("pill")
    panel.show()
    if listen { startListening() }
  }

  @objc private func showBrief() {
    guard ready else { return }
    setView("brief")
    panel.show()
  }

  @objc private func talk() { summon(listen: true) }
  @objc private func type() { summon(listen: false) }

  @objc private func focusProject(_ sender: NSMenuItem) {
    guard ready, let name = sender.representedObject as? String else { return }
    setView("pill")
    panel.show()
    panel.eval("cosShell.focusProject(\(Self.js(name)))")
  }

  @objc private func readAloud() {
    server.getJSON("api/brief") { [weak self] obj in
      guard let text = (obj as? [String: Any])?["speech"] as? String else { return }
      self?.server.postJSON("api/speak", ["text": text])
    }
  }

  @objc private func rebuildBrief() {
    server.getJSON("api/brief?refresh=1") { [weak self] _ in self?.panel.eval("cosShell.reload()") }
  }

  @objc private func openInBrowser() { NSWorkspace.shared.open(server.config.baseURL) }

  @objc private func enableFn() {
    if HotkeyMonitor.accessibilityTrusted(prompt: true) {
      alert("Double-tap Fn is on.", "If Fn also opens the emoji picker or dictation, set System Settings › Keyboard › “Press 🌐 key to” to “Do Nothing”.")
    }
  }

  @objc private func quit() { NSApp.terminate(nil) }

  // MARK: messages from the page

  private func handle(message: [String: Any]) {
    switch message["type"] as? String {
    case "height":
      if let h = message["value"] as? Double { panel.setHeight(CGFloat(h)) }
    case "state":
      pageState = message["value"] as? String ?? "idle"
    case "listen":
      startListening()
    case "stopListen":
      speech.stop()
    case "hide":
      speech.cancel()
      panel.hide()
    case "open":
      if let s = message["url"] as? String, let url = URL(string: s) { NSWorkspace.shared.open(url) }
    default:
      break
    }
  }

  private func startListening() {
    speech.authorize { [weak self] ok in
      guard let self else { return }
      guard ok else {
        self.panel.eval("cosShell.status(\(Self.js("Microphone or speech recognition is off: System Settings › Privacy & Security.")))")
        return
      }
      self.panel.eval("cosShell.listening(true)")
      self.speech.start()
    }
  }

  // MARK: helpers

  private func alert(_ title: String, _ text: String) {
    NSApp.activate(ignoringOtherApps: true)
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.runModal()
  }

  /// A Swift string as a JavaScript string literal.
  static func js(_ s: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [s]), let arr = String(data: data, encoding: .utf8) else { return "\"\"" }
    return String(arr.dropFirst().dropLast())
  }
}
