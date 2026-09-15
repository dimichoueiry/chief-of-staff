import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var statusItem: NSStatusItem!
  private var panel: PillPanel!
  private var server: ServerManager!
  private let hotkeys = HotkeyMonitor()
  private let speech = SpeechListener()
  private let wake = WakeListener()
  private var wakeSettings = WakeSettings.load()
  private var wakeItem: NSMenuItem!
  private var homeItem: NSMenuItem!
  private var loggedWakeProblem: String?
  private let focusMenu = NSMenu()
  private let modelMenu = NSMenu()
  private let permissionsMenu = NSMenu()
  private var permissionsItem: NSMenuItem!
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
    installEditMenu()
    buildStatusItem()

    panel = PillPanel()
    panel.onMessage = { [weak self] msg in self?.handle(message: msg) }
    panel.onResignKey = { [weak self] in
      guard let self else { return }
      // Clicking elsewhere dismisses, unless it is still working for you.
      if self.pageState == "idle" && !self.speech.listening { self.panel.hide() }
    }

    hotkeys.onDoubleTap = { [weak self] in self?.summon(listen: true) }
    hotkeys.onShortcut = { [weak self] in self?.summon(listen: false) }
    hotkeys.start()

    speech.onPartial = { [weak self] text in
      guard let self else { return }
      if self.saidSleep(text) { return }
      self.panel.eval("cosShell.transcript(\(Self.js(text)), false)")
    }
    speech.onFinal = { [weak self] text in
      guard let self else { return }
      if self.saidSleep(text) { return }
      self.panel.eval("cosShell.transcript(\(Self.js(text)), true)")
    }
    speech.onError = { [weak self] err in self?.panel.eval("cosShell.status(\(Self.js(err)))") }
    // The microphone is free again: go back to waiting for the name.
    speech.onIdle = { [weak self] in self?.resumeWake() }
    wake.onCommand = { [weak self] command in self?.heard(command) }
    // `cos voice wake off` or a new name applies within a few seconds, with no restart.
    Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.reloadWakeSettings() }

    server.ensureRunning { [weak self] ok in
      guard let self else { return }
      guard ok else {
        self.alert("The local server did not start.", "See ~/.cos/logs/menubar-server.log. Is the repo built (npm run build)?")
        return
      }
      self.ready = true
      self.resumeWake()
      self.panel.load(URL(string: "\(config.baseURL)/?shell=1&mode=pill")!)
      Log.write("ready at \(config.baseURL)")
      DispatchQueue.main.async { self.offerSetup() }
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    hotkeys.stop()
    wake.stop()
    speech.cancel()
    server?.stop()
  }

  /// A menubar app has no menu bar of its own, so ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z do nothing in text fields
  /// (the pill's input, the model box) unless an Edit menu exists to route them. It's never shown.
  private func installEditMenu() {
    let main = NSMenu()
    let editItem = NSMenuItem()
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)
    NSApp.mainMenu = main
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
    add(menu, "Talk   (⌃ ⌃)", #selector(talk))
    add(menu, "Ask or capture…   (⌥Space)", #selector(type))
    wakeItem = add(menu, "Listen for “Darius”", #selector(toggleWake))
    homeItem = add(menu, "Move the chat back to the bottom", #selector(moveHome))
    let focus = NSMenuItem(title: "Focus a project", action: nil, keyEquivalent: "")
    focus.submenu = focusMenu
    menu.addItem(focus)
    let model = NSMenuItem(title: "Model", action: nil, keyEquivalent: "")
    model.submenu = modelMenu
    menu.addItem(model)
    add(menu, "Read the brief aloud", #selector(readAloud))
    menu.addItem(.separator())
    add(menu, "Rebuild the brief", #selector(rebuildBrief))
    add(menu, "Open in browser", #selector(openInBrowser))
    permissionsItem = NSMenuItem(title: "Permissions", action: nil, keyEquivalent: "")
    permissionsItem.submenu = permissionsMenu
    menu.addItem(permissionsItem)
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
    guard menu !== focusMenu, menu !== modelMenu else { return }
    refreshWakeItem()
    homeItem.isHidden = panel.placement == nil
    refreshPermissionsMenu()
    refreshFocusMenu()
    refreshModelMenu()
  }

  // MARK: the wake phrase

  /// "Darius wake up" / "Darius listen": listen now, after the "your turn" chime. "Darius sleep": stop and close.
  private func heard(_ command: WakeCommand) {
    guard ready else { return }
    switch command {
    case .wake, .listen:
      guard !speech.listening else { return }
      wake.stop() // hand the microphone over
      server.postJSON("api/speak/stop", [:]) // talked over: it stops at once, not after the chime
      setView("pill")
      panel.show()
      playTurnCue { [weak self] in self?.startListening() }
    case .sleep:
      speech.cancel()
      panel.eval("cosShell.dismiss()")
      panel.hide()
      resumeWake()
    }
  }

  /// "Darius sleep" said while it's already listening to you.
  private func saidSleep(_ text: String) -> Bool {
    guard wakeSettings.enabled, WakePhrase(name: wakeSettings.name).find(in: text) == .sleep else { return false }
    Log.write("wake: heard sleep while listening")
    heard(.sleep)
    return true
  }

  private func resumeWake() {
    guard ready, wakeSettings.enabled, !speech.listening else { return }
    wake.start(name: wakeSettings.name)
    if wake.problem != loggedWakeProblem {
      loggedWakeProblem = wake.problem
      if let problem = wake.problem { Log.write("wake: not listening: \(problem)") }
    }
  }

  /// Every few seconds: pick up `cos voice wake` / `cos voice name`, and start waiting once permissions are on.
  private func reloadWakeSettings() {
    let now = WakeSettings.load()
    if now != wakeSettings {
      wakeSettings = now
      if !now.enabled { wake.stop() }
    }
    if wakeSettings.enabled, !wake.running || wake.problem != nil { resumeWake() }
  }

  @objc private func toggleWake() {
    WakeSettings.setEnabled(!wakeSettings.enabled)
    reloadWakeSettings()
    if wakeSettings.enabled, let problem = wake.problem {
      alert("Not listening for “\(wakeSettings.name)” yet", "Because \(problem). Turn on Microphone and Speech Recognition under ✦ › Permissions.")
    }
  }

  private func refreshWakeItem() {
    let name = wakeSettings.name.prefix(1).uppercased() + wakeSettings.name.dropFirst()
    let off = wakeSettings.enabled && !wake.running ? " (not listening: \(wake.problem ?? "starting"))" : ""
    wakeItem.title = "Listen for “\(name)”\(off)"
    wakeItem.state = wakeSettings.enabled ? .on : .off
  }

  /// The same soft chime the pill plays when it's your turn, then go; straight away when cues are off or it isn't built yet.
  private func playTurnCue(then go: @escaping () -> Void) {
    let sounds = ShellConfig.home.appendingPathComponent("sounds")
    let cue = wakeSettings.cues == "off" ? nil : (try? FileManager.default.contentsOfDirectory(at: sounds, includingPropertiesForKeys: [.contentModificationDateKey]))?
      .filter { $0.lastPathComponent.hasPrefix("turn-") && $0.pathExtension == "wav" }
      .max { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) < ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
    guard let cue, let sound = NSSound(contentsOf: cue, byReference: true), sound.play() else { return go() }
    // The mic opens once the chime has played, so it doesn't hear it.
    DispatchQueue.main.asyncAfter(deadline: .now() + sound.duration + 0.08) { go() }
  }

  // MARK: permissions

  /// Each permission with a check when it's on. Clicking one that's off sets it up; one that's on opens its page.
  private func refreshPermissionsMenu() {
    permissionsMenu.removeAllItems()
    let off = Permission.allCases.filter { !$0.granted }
    permissionsItem.title = off.isEmpty ? "Permissions" : "Permissions (\(off.count) off)"
    for p in Permission.allCases {
      let item = NSMenuItem(title: "\(p.name): \(p.why)", action: #selector(fixPermission(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = p.rawValue
      item.state = off.contains(p) ? .off : .on
      permissionsMenu.addItem(item)
    }
    permissionsMenu.addItem(.separator())
    let setup = NSMenuItem(title: "Set up what's off…", action: off.isEmpty ? nil : #selector(runSetup), keyEquivalent: "")
    setup.target = self
    setup.isEnabled = !off.isEmpty
    permissionsMenu.addItem(setup)
  }

  @objc private func fixPermission(_ sender: NSMenuItem) {
    guard let raw = sender.representedObject as? String, let p = Permission(rawValue: raw) else { return }
    if p.granted { NSWorkspace.shared.open(p.settingsURL) } else { walk([p]) }
  }

  @objc private func runSetup() { walk(Permission.allCases.filter { !$0.granted }) }

  /// Once per build (a rebuild clears macOS's switches): if anything is off, offer to go through it.
  private func offerSetup() {
    let defaults = UserDefaults.standard
    guard defaults.string(forKey: "setupDoneForBuild") != Permission.build else { return }
    let off = Permission.allCases.filter { !$0.granted }
    guard !off.isEmpty else {
      defaults.set(Permission.build, forKey: "setupDoneForBuild")
      return
    }
    NSApp.activate(ignoringOtherApps: true)
    let a = NSAlert()
    a.messageText = off.count == 1 ? "One permission is off" : "\(off.count) permissions are off"
    a.informativeText = off.map { "• \($0.name): \($0.why)" }.joined(separator: "\n")
      + "\n\nSet up goes through them one at a time. They're also under ✦ › Permissions."
    a.addButton(withTitle: "Set up")
    a.addButton(withTitle: "Later")
    let choice = a.runModal()
    if choice == .alertFirstButtonReturn {
      walk(off)
    } else {
      defaults.set(Permission.build, forKey: "setupDoneForBuild")
    }
  }

  /// One permission at a time: macOS's prompt, or its page and a Next button once it's switched on.
  private func walk(_ steps: [Permission]) {
    guard let step = steps.first else {
      let off = Permission.allCases.filter { !$0.granted }
      // Anything still off (Screen Recording and Full Disk Access only count after a reopen) is offered again
      // next launch; "Later" or "Stop" is what stops the asking for this build.
      if off.isEmpty { UserDefaults.standard.set(Permission.build, forKey: "setupDoneForBuild") }
      Log.write("permission setup finished; off: \(off.map(\.rawValue))")
      return
    }
    let rest = Array(steps.dropFirst())
    guard !step.granted else { walk(rest); return }
    Log.write("permission setup: \(step.rawValue)")
    step.request { [weak self] openedPage in
      guard let self else { return }
      guard openedPage else { self.walk(rest); return }
      let a = NSAlert()
      a.messageText = "Turn on \(step.name)"
      a.informativeText = "For \(step.why). " + step.instructions
      a.addButton(withTitle: rest.isEmpty ? "Done" : "Next")
      a.addButton(withTitle: "Stop")
      NSApp.activate(ignoringOtherApps: true)
      if a.runModal() == .alertFirstButtonReturn {
        self.walk(rest)
      } else {
        UserDefaults.standard.set(Permission.build, forKey: "setupDoneForBuild")
        Log.write("permission setup stopped at \(step.rawValue)")
      }
    }
  }

  /// Presets from the server, a check on the model in use, dimmed when that provider has no key.
  private func refreshModelMenu() {
    guard ready else { return }
    server.getJSON("api/models") { [weak self] obj in
      guard let self, let state = obj as? [String: Any] else { return }
      self.modelMenu.removeAllItems()
      let intents = state["intents"] as? [String: Any] ?? [:]
      let inUse = (intents["ask"] as? [String: Any])?["spec"] as? String
      let saved = state["default"] as? String
      let header = NSMenuItem(title: inUse.map { "In use: \($0)" } ?? "No model yet — add a key to .env", action: nil, keyEquivalent: "")
      header.isEnabled = false
      self.modelMenu.addItem(header)
      self.modelMenu.addItem(.separator())
      for preset in state["presets"] as? [[String: Any]] ?? [] {
        guard let spec = preset["spec"] as? String else { continue }
        let hasKey = preset["ready"] as? Bool ?? false
        let item = NSMenuItem(title: hasKey ? spec : "\(spec)   (no key)", action: hasKey ? #selector(self.selectModel(_:)) : nil, keyEquivalent: "")
        item.target = self
        item.representedObject = spec
        item.state = spec == (saved ?? inUse) ? .on : .off
        item.isEnabled = hasKey
        self.modelMenu.addItem(item)
      }
      self.modelMenu.addItem(.separator())
      // Whatever else the server lists ("Use any model…", "Browse…"), so new items need no rebuild.
      for action in state["actions"] as? [[String: Any]] ?? [] {
        guard let title = action["title"] as? String else { continue }
        let item = NSMenuItem(title: title, action: #selector(self.runMenuAction(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = action
        self.modelMenu.addItem(item)
      }
      if saved != nil {
        let clear = NSMenuItem(title: "Clear saved choice", action: #selector(self.clearModel), keyEquivalent: "")
        clear.target = self
        self.modelMenu.addItem(clear)
      }
    }
  }

  @objc private func selectModel(_ sender: NSMenuItem) {
    guard let spec = sender.representedObject as? String else { return }
    server.postJSON("api/models", ["spec": spec]) { _ in Log.write("model → \(spec)") }
  }

  /// A menu item described by the server: open a link, post to an endpoint, or ask for a value first.
  @objc private func runMenuAction(_ sender: NSMenuItem) {
    guard let action = sender.representedObject as? [String: Any], let kind = action["kind"] as? String else { return }
    switch kind {
    case "open":
      if let s = action["url"] as? String, let url = URL(string: s) { NSWorkspace.shared.open(url) }
    case "post":
      guard let path = action["path"] as? String else { return }
      server.postJSON(path, action["body"] as? [String: Any] ?? [:]) { [weak self] obj in self?.report(obj) }
    case "input":
      guard let path = action["path"] as? String else { return }
      NSApp.activate(ignoringOtherApps: true)
      let ask = NSAlert()
      ask.messageText = action["prompt"] as? String ?? sender.title
      ask.informativeText = action["message"] as? String ?? ""
      let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
      field.placeholderString = action["placeholder"] as? String
      field.stringValue = action["value"] as? String ?? ""
      ask.accessoryView = field
      ask.addButton(withTitle: action["button"] as? String ?? "OK")
      ask.addButton(withTitle: "Cancel")
      ask.window.initialFirstResponder = field
      guard ask.runModal() == .alertFirstButtonReturn else { return }
      let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !value.isEmpty else { return }
      Log.write("menu: \(sender.title) \(value)")
      server.postJSON(path, ["value": value]) { [weak self] obj in self?.report(obj) }
    default:
      break
    }
  }

  /// Say how a menu action went: the server's message, or its error.
  private func report(_ obj: Any?) {
    guard let result = obj as? [String: Any] else {
      alert("That didn't work.", "The app's server didn't answer. See ~/.cos/logs/menubar-server.log.")
      return
    }
    if let error = result["error"] as? String {
      alert("That didn't work.", error)
    } else if let message = result["message"] as? String {
      alert(message, result["detail"] as? String ?? "")
    }
  }

  @objc private func clearModel() {
    server.postJSON("api/models", ["spec": NSNull()])
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

  @objc private func quit() { NSApp.terminate(nil) }

  @objc private func moveHome() { panel.resetPlacement() }

  // MARK: messages from the page

  private func handle(message: [String: Any]) {
    switch message["type"] as? String {
    case "height":
      if let h = message["value"] as? Double { panel.setHeight(CGFloat(h)) }
    case "move":
      // Dragged by the bar or the card's header: the window follows, and the spot is kept when the drag ends.
      if let dx = message["dx"] as? Double, let dy = message["dy"] as? Double { panel.move(dx: CGFloat(dx), dy: CGFloat(dy)) }
    case "placed":
      panel.savePlacement()
      Log.write("pill placed at \(panel.frame.midX),\(panel.frame.minY)")
    case "unplace":
      panel.resetPlacement()
    case "state":
      pageState = message["value"] as? String ?? "idle"
    case "listen":
      startListening()
    case "stopListen":
      speech.stop()
    case "menu":
      // Same menu as the ✦ icon, opened where you clicked, so a hidden menubar icon never locks you out.
      statusItem.menu?.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    case "hide":
      speech.cancel()
      panel.hide()
      resumeWake()
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
      self.wake.stop() // one listener on the microphone at a time
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
