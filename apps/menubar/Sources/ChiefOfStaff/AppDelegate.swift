import AppKit
import ServiceManagement

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
  private var keysItem: NSMenuItem!
  private var memoryItem: NSMenuItem!
  private var loginItem: NSMenuItem!
  private var connectionsItem: NSMenuItem!
  private var gridItem: NSMenuItem!
  private var loggedWakeProblem: String?
  private let focusMenu = NSMenu()
  private let modelMenu = NSMenu()
  private let imageMenu = NSMenu()
  private let memoryMenu = NSMenu()
  private let gridMenu = NSMenu()
  private var keysWindow: KeysWindow!
  private var connectionsWindow: ConnectionsWindow!
  private let permissionsMenu = NSMenu()
  private var permissionsItem: NSMenuItem!
  private var view = "pill"
  private var pageState = "idle"
  private var ready = false
  private var hasKey = true
  private var listenGeneration = 0

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard let config = ShellConfig.load() else {
      alert(
        "Chief of Staff can't find the parts it runs on.",
        "This copy of the app is incomplete, so it can't start. Install it again from the disk image you were sent, keeping the whole Chief of Staff app together."
      )
      NSApp.terminate(nil)
      return
    }
    server = ServerManager(config: config)
    keysWindow = KeysWindow(server: server)
    connectionsWindow = ConnectionsWindow(server: server)
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
    hotkeys.onControlTap = { [weak self] in self?.toggleListeningFromControl() ?? false }
    hotkeys.onHoldStart = { [weak self] in self?.beginPushToTalk() }
    hotkeys.onHoldEnd = { [weak self] in self?.endPushToTalk() }
    hotkeys.onHoldCancelled = { [weak self] in self?.cancelPushToTalk() }
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
    speech.onLivePhrase = { [weak self] text, session, sequence in
      guard let self else { return }
      if self.saidSleep(text) { return }
      self.panel.eval("cosShell.livePhrase(\(Self.js(text)), \(Self.js(session)), \(sequence))")
    }
    speech.onError = { [weak self] err in self?.panel.eval("cosShell.status(\(Self.js(err)), true)") }
    // The microphone is free again: go back to waiting for the name.
    speech.onIdle = { [weak self] in
      guard let self else { return }
      if let session = self.speech.liveSession { self.panel.eval("cosShell.liveStopped(\(Self.js(session)))") }
      self.resumeWake()
    }
    wake.onCommand = { [weak self] command in self?.heard(command) }
    // `cos voice wake off` or a new name applies within a few seconds, with no restart.
    Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.reloadWakeSettings() }

    server.ensureRunning { [weak self] ok in
      guard let self else { return }
      guard ok else {
        self.alert(
          "Chief of Staff couldn't start.",
          "It runs a small program on your own Mac and that didn't come up. Quitting and opening it again usually fixes it. If it keeps happening, the details are in ~/.cos/logs/menubar-server.log."
        )
        return
      }
      self.ready = true
      self.resumeWake()
      self.panel.load(URL(string: "\(self.server.config.baseURL)/?shell=1&mode=pill")!)
      Log.write("ready at \(self.server.config.baseURL)")
      DispatchQueue.main.async {
        let walking = self.offerSetup()
        self.refreshKeysItem()
        if !walking { self.offerKeys() } // otherwise the walk asks when it finishes
      }
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
    gridItem = NSMenuItem(title: "Agent Grid", action: nil, keyEquivalent: "")
    gridItem.submenu = gridMenu
    menu.addItem(gridItem)
    let focus = NSMenuItem(title: "Focus a project", action: nil, keyEquivalent: "")
    focus.submenu = focusMenu
    menu.addItem(focus)
    add(menu, "Artifacts…", #selector(showArtifacts))
    let model = NSMenuItem(title: "Model", action: nil, keyEquivalent: "")
    model.submenu = modelMenu
    menu.addItem(model)
    keysItem = add(menu, "API keys…", #selector(showKeys))
    connectionsItem = add(menu, "Connections…", #selector(showConnections))
    add(menu, "My instructions…", #selector(showSettings))
    memoryItem = NSMenuItem(title: "Memory", action: nil, keyEquivalent: "")
    memoryItem.submenu = memoryMenu
    menu.addItem(memoryItem)
    add(menu, "Read the brief aloud", #selector(readAloud))
    loginItem = add(menu, "Open at login", #selector(toggleLogin))
    menu.addItem(.separator())
    add(menu, "Rebuild the brief", #selector(rebuildBrief))
    add(menu, "Open in browser", #selector(openInBrowser))
    permissionsItem = NSMenuItem(title: "Permissions", action: nil, keyEquivalent: "")
    permissionsItem.submenu = permissionsMenu
    menu.addItem(permissionsItem)
    menu.addItem(.separator())
    add(menu, "Remove Chief of Staff…", #selector(uninstall))
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
    guard menu !== focusMenu, menu !== modelMenu, menu !== memoryMenu, !isGridMenu(menu) else { return }
    refreshWakeItem()
    homeItem.isHidden = panel.placement == nil
    refreshPermissionsMenu()
    refreshFocusMenu()
    refreshModelMenu()
    refreshKeysItem()
    refreshMemoryMenu()
    refreshConnectionsItem()
    refreshGridMenu()
    loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
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
    if wakeSettings.enabled, wake.problem != nil {
      alert(
        "Not listening for “\(wakeSettings.name)” yet",
        MicSpeechCopy.recoveryMessage(microphoneGranted: Permission.microphone.granted, speechGranted: Permission.speech.granted)
      )
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

  /// What the first run asks for. Screen Recording and Full Disk Access are left out on purpose:
  /// Full Disk Access has no prompt at all (it means dragging the app into System Settings) and
  /// only powers browser favorites, so both are asked for by the feature that needs them.
  private static let firstRunPermissions: [Permission] = [.accessibility, .microphone, .speech]

  /// Once per build (a rebuild clears macOS's switches): if anything is off, offer to go through it.
  /// Returns true when a walk started, so the key offer waits for it rather than landing on top.
  @discardableResult
  private func offerSetup() -> Bool {
    let defaults = UserDefaults.standard
    guard defaults.string(forKey: "setupDoneForBuild") != Permission.build else { return false }
    let off = AppDelegate.firstRunPermissions.filter { !$0.granted }
    guard !off.isEmpty else {
      defaults.set(Permission.build, forKey: "setupDoneForBuild")
      return false
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
      return true
    }
    defaults.set(Permission.build, forKey: "setupDoneForBuild")
    return false
  }

  /// One permission at a time: macOS's prompt, or its page and a Next button once it's switched on.
  private func walk(_ steps: [Permission]) {
    guard let step = steps.first else {
      let off = AppDelegate.firstRunPermissions.filter { !$0.granted }
      // Anything still off (Screen Recording and Full Disk Access only count after a reopen) is offered again
      // next launch; "Later" or "Stop" is what stops the asking for this build.
      if off.isEmpty { UserDefaults.standard.set(Permission.build, forKey: "setupDoneForBuild") }
      Log.write("permission setup finished; off: \(off.map(\.rawValue))")
      offerKeys() // the other thing a first launch needs, asked after the permissions, never during
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
      let header: NSMenuItem
      if let inUse {
        header = NSMenuItem(title: "In use: \(inUse)", action: nil, keyEquivalent: "")
        header.isEnabled = false
      } else {
        // Nothing can answer yet, so the one useful thing here is the way to fix that.
        header = NSMenuItem(title: "No model yet — add an API key…", action: #selector(self.showKeys), keyEquivalent: "")
        header.target = self
      }
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
      // Which model draws is a model choice too, so it lives here, in a list of its own.
      if let images = state["images"] as? [String: Any] {
        self.imageMenu.removeAllItems()
        for preset in images["presets"] as? [[String: Any]] ?? [] {
          guard let spec = preset["spec"] as? String else { continue }
          let item = NSMenuItem(title: preset["label"] as? String ?? spec, action: #selector(self.selectImageModel(_:)), keyEquivalent: "")
          item.target = self
          item.representedObject = spec
          item.state = (preset["current"] as? Bool ?? false) ? .on : .off
          self.imageMenu.addItem(item)
        }
        self.imageMenu.addItem(.separator())
        for action in images["actions"] as? [[String: Any]] ?? [] {
          guard let title = action["title"] as? String else { continue }
          let item = NSMenuItem(title: title, action: #selector(self.runMenuAction(_:)), keyEquivalent: "")
          item.target = self
          item.representedObject = action
          self.imageMenu.addItem(item)
        }
        if images["ready"] as? Bool == false {
          self.imageMenu.addItem(.separator())
          let note = NSMenuItem(title: "Needs an OpenRouter key…", action: #selector(self.showKeys), keyEquivalent: "")
          note.target = self
          self.imageMenu.addItem(note)
        }
        let item = NSMenuItem(title: "Images", action: nil, keyEquivalent: "")
        item.submenu = self.imageMenu
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

  @objc private func selectImageModel(_ sender: NSMenuItem) {
    guard let spec = sender.representedObject as? String else { return }
    server.postJSON("api/models/image", ["spec": spec]) { _ in Log.write("image model → \(spec)") }
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

  /// Open at login, through macOS's own list (System Settings › General › Login Items), so it can
  /// always be turned off there too. The older way, a LaunchAgent we wrote, is left to `cos`.
  @objc private func toggleLogin() {
    let service = SMAppService.mainApp
    do {
      if service.status == .enabled {
        try service.unregister()
        Log.write("open at login: off")
      } else {
        try service.register()
        Log.write("open at login: on")
      }
    } catch {
      let denied = service.status == .requiresApproval
      alert(
        denied ? "macOS wants you to allow this" : "Couldn't change that",
        denied
          ? "Open System Settings › General › Login Items & Extensions and switch Chief of Staff on there."
          : "\(error.localizedDescription)"
      )
      if denied { SMAppService.openSystemSettingsLoginItems() }
    }
    loginItem.state = service.status == .enabled ? .on : .off
  }

  /// Take it off this Mac: the login item, its own folder, and the app. Memory is left alone
  /// unless they ask, because that is theirs and it is the only copy.
  @objc private func uninstall() {
    NSApp.activate(ignoringOtherApps: true)
    let home = ShellConfig.home.path
    let a = NSAlert()
    a.messageText = "Remove Chief of Staff from this Mac?"
    a.informativeText = """
      This quits it, stops it opening at login, moves the app to the Trash, and moves \(home)       (its settings, keys and logs) to the Trash too.

      Your memory folder is not touched: the notes, projects and journal stay where they are.       Privacy & Security will still list Chief of Staff until you remove it there yourself.
      """
    a.addButton(withTitle: "Remove")
    a.addButton(withTitle: "Cancel")
    a.buttons.first?.hasDestructiveAction = true
    guard a.runModal() == .alertFirstButtonReturn else { return }

    try? SMAppService.mainApp.unregister()
    server.stop()
    var failed: [String] = []
    for url in [ShellConfig.home, Bundle.main.bundleURL] {
      guard FileManager.default.fileExists(atPath: url.path) else { continue }
      var trashed: NSURL?
      do { try FileManager.default.trashItem(at: url, resultingItemURL: &trashed) } catch { failed.append(url.lastPathComponent) }
    }
    if failed.isEmpty {
      NSApp.terminate(nil)
    } else {
      alert("Some of it is still here", "Couldn't move \(failed.joined(separator: " and ")) to the Trash. Drag them there yourself: \(home) and this app.")
    }
  }

  @objc private func showKeys() { keysWindow.show() }

  @objc private func showConnections() { connectionsWindow.show() }

  /// A box you write paragraphs in wants a window, not a menu: a page the app already serves.
  @objc private func showSettings() { NSWorkspace.shared.open(server.config.baseURL.appendingPathComponent("settings.html")) }

  /// Everything it has made, newest first.
  @objc private func showArtifacts() { NSWorkspace.shared.open(server.config.baseURL.appendingPathComponent("artifacts.html")) }

  /// The grid menu and the per-area submenus under it don't refresh the whole status menu when they open.
  private func isGridMenu(_ menu: NSMenu) -> Bool {
    var m: NSMenu? = menu
    while let current = m {
      if current === gridMenu { return true }
      m = current.supermenu
    }
    return false
  }

  private func infoItem(_ title: String, small: Bool = false) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    if small { item.attributedTitle = NSAttributedString(string: title, attributes: [.font: NSFont.systemFont(ofSize: 11)]) }
    return item
  }

  /// One running agent: what it is doing, whether it needs you, and the tickets it holds. Opens Agent Grid.
  private func agentItem(_ a: [String: Any], open: [String: Any]?) -> NSMenuItem {
    let name = a["name"] as? String ?? "agent"
    let needs = a["needsYou"] as? Bool ?? false
    let status = needs ? "needs you" : (a["status"] as? String ?? "")
    let held = (a["tickets"] as? [String] ?? []).joined(separator: ", ")
    let title = "\(needs ? "●" : "○")  \(name) — \(status)\(held.isEmpty ? "" : " · \(held)")"
    let item = NSMenuItem(title: title, action: open == nil ? nil : #selector(runMenuAction(_:)), keyEquivalent: "")
    item.target = self
    item.representedObject = open
    item.isEnabled = open != nil
    return item
  }

  private func areaLine(name: String, running: Int, needYou: Int, finished: Int) -> String {
    var bits: [String] = []
    if running > 0 { bits.append("\(running) running") }
    if needYou > 0 { bits.append("\(needYou) need\(needYou == 1 ? "s" : "") you") }
    if bits.isEmpty { bits.append(finished > 0 ? "\(finished) finished" : "no agents") }
    return "\(name) — \(bits.joined(separator: ", "))"
  }

  /// Work areas and their agents, the ticket board in a line, and a way to file one. From api/grid.
  private func refreshGridMenu() {
    guard ready else { return }
    server.getJSON("api/grid") { [weak self] obj in
      guard let self, let state = obj as? [String: Any] else { return }
      self.gridMenu.removeAllItems()
      let actions = state["actions"] as? [[String: Any]] ?? []
      let open = actions.first { ($0["kind"] as? String) == "open" }

      guard state["connected"] as? Bool ?? false else {
        self.gridMenu.addItem(self.infoItem("Agent Grid isn't reachable"))
        if let why = state["error"] as? String { self.gridMenu.addItem(self.infoItem(why, small: true)) }
        self.addActions(actions, to: self.gridMenu)
        self.gridItem.title = "Agent Grid"
        return
      }

      var needYou = 0
      for area in state["areas"] as? [[String: Any]] ?? [] {
        let agents = area["agents"] as? [[String: Any]] ?? []
        let n = area["needYou"] as? Int ?? 0
        needYou += n
        let item = NSMenuItem(title: self.areaLine(name: area["name"] as? String ?? "", running: area["running"] as? Int ?? 0, needYou: n, finished: area["finished"] as? Int ?? 0), action: nil, keyEquivalent: "")
        if agents.isEmpty {
          item.isEnabled = false
        } else {
          let sub = NSMenu()
          for a in agents { sub.addItem(self.agentItem(a, open: open)) }
          item.submenu = sub
        }
        self.gridMenu.addItem(item)
      }
      if let unfiled = state["unfiled"] as? [String: Any], (unfiled["running"] as? Int ?? 0) > 0 {
        let agents = unfiled["agents"] as? [[String: Any]] ?? []
        needYou += agents.filter { $0["needsYou"] as? Bool ?? false }.count
        let item = NSMenuItem(title: self.areaLine(name: "Not in a work area", running: unfiled["running"] as? Int ?? 0, needYou: 0, finished: 0), action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for a in agents { sub.addItem(self.agentItem(a, open: open)) }
        item.submenu = sub
        self.gridMenu.addItem(item)
      }

      self.gridMenu.addItem(.separator())
      if let tickets = state["tickets"] as? [String: Any] {
        let openCount = tickets["open"] as? Int ?? 0
        let review = tickets["review"] as? [[String: Any]] ?? []
        let unassigned = tickets["unassigned"] as? Int ?? 0
        var line = openCount == 0 ? "No open tickets" : "Tickets: \(openCount) open"
        if !review.isEmpty { line += " · \(review.count) in review" }
        if unassigned > 0 { line += " · \(unassigned) unassigned" }
        self.gridMenu.addItem(self.infoItem(line))
        for t in review {
          let title = "   Review \(t["id"] as? String ?? ""): \(t["title"] as? String ?? "")"
          let item = NSMenuItem(title: title, action: open == nil ? nil : #selector(self.runMenuAction(_:)), keyEquivalent: "")
          item.target = self
          item.representedObject = open
          self.gridMenu.addItem(item)
        }
      } else {
        self.gridMenu.addItem(self.infoItem("This Agent Grid has no ticket board yet"))
      }
      self.gridMenu.addItem(.separator())
      self.addActions(actions, to: self.gridMenu)
      self.gridItem.title = needYou > 0 ? "Agent Grid  (\(needYou) need\(needYou == 1 ? "s" : "") you)" : "Agent Grid"
    }
  }

  private func addActions(_ actions: [[String: Any]], to menu: NSMenu) {
    for action in actions {
      guard let title = action["title"] as? String else { continue }
      let item = NSMenuItem(title: title, action: #selector(runMenuAction(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = action
      menu.addItem(item)
    }
  }

  /// How many connections are on, so the menu says whether there are any without opening the window.
  private func refreshConnectionsItem() {
    guard ready else { return }
    server.getJSON("api/connections") { [weak self] obj in
      guard let self, let state = obj as? [String: Any] else { return }
      let all = state["connections"] as? [[String: Any]] ?? []
      let on = all.filter { $0["enabled"] as? Bool ?? false }.count
      self.connectionsItem.title = all.isEmpty ? "Connections…" : "Connections  (\(on) on)"
    }
  }

  /// Where memory lives, whether its history is being kept, and whatever the server says fixes it.
  /// Every item is described by the server (api/memory), drawn by runMenuAction like the model ones.
  private func refreshMemoryMenu() {
    guard ready else { return }
    server.getJSON("api/memory") { [weak self] obj in
      guard let self, let state = obj as? [String: Any] else { return }
      self.memoryMenu.removeAllItems()
      let dir = state["dir"] as? String ?? "?"
      let folder = NSMenuItem(title: (dir as NSString).abbreviatingWithTildeInPath, action: nil, keyEquivalent: "")
      folder.isEnabled = false
      self.memoryMenu.addItem(folder)

      let history = state["history"] as? [String: Any] ?? [:]
      let on = history["on"] as? Bool ?? false
      let line = on
        ? "History: on\(( history["lastCommit"] as? String).map { ", last write \($0.prefix(10))" } ?? "")"
        : "History: off — your memory is saved, not versioned"
      let status = NSMenuItem(title: line, action: nil, keyEquivalent: "")
      status.isEnabled = false
      self.memoryMenu.addItem(status)
      if !on, let why = history["reason"] as? String {
        let reason = NSMenuItem(title: why, action: nil, keyEquivalent: "")
        reason.isEnabled = false
        reason.attributedTitle = NSAttributedString(string: why, attributes: [.font: NSFont.systemFont(ofSize: 11)])
        self.memoryMenu.addItem(reason)
      }
      self.memoryMenu.addItem(.separator())
      for action in state["actions"] as? [[String: Any]] ?? [] {
        guard let title = action["title"] as? String else { continue }
        let item = NSMenuItem(title: title, action: #selector(self.runMenuAction(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = action
        self.memoryMenu.addItem(item)
      }
      self.memoryItem.title = (state["ready"] as? Bool ?? true) && on ? "Memory" : "Memory ⚠︎"
    }
  }

  /// Keep the menu honest about whether anything can answer, and offer the window once when nothing can.
  private func refreshKeysItem() {
    guard ready else { return }
    server.getJSON("api/keys") { [weak self] obj in
      guard let self, let state = obj as? [String: Any] else { return }
      let ready = state["ready"] as? Bool ?? false
      self.keysItem.title = ready ? "API keys…" : "Add an API key…"
      self.hasKey = ready
    }
  }

  /// First launch with no key: the app can hold notes and read the calendar, but it can't think.
  /// Said once per build, like the permission walk, and never again once a key is in.
  private func offerKeys() {
    guard ready else { return }
    let defaults = UserDefaults.standard
    guard defaults.string(forKey: "keysOfferedForBuild") != Permission.build else { return }
    server.getJSON("api/keys") { [weak self] obj in
      guard let self, let state = obj as? [String: Any], !(state["ready"] as? Bool ?? false) else { return }
      defaults.set(Permission.build, forKey: "keysOfferedForBuild")
      NSApp.activate(ignoringOtherApps: true)
      let a = NSAlert()
      a.messageText = "Chief of Staff needs an API key"
      a.informativeText = "Without one it still keeps your notes, projects and calendar, but it can't answer questions or write your brief.\n\nOne key from Anthropic, OpenAI or OpenRouter is enough. It's also under ✦ › API keys."
      a.addButton(withTitle: "Add a key")
      a.addButton(withTitle: "Later")
      if a.runModal() == .alertFirstButtonReturn { self.keysWindow.show() }
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
        if speech.liveSession != nil { panel.eval("cosShell.stopLive()"); speech.cancel() }
        else { speech.stop() } // second double-tap: done talking
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

  /** A short Control press works as a toggle only when the pill is already present. */
  private func toggleListeningFromControl() -> Bool {
    guard ready, panel.isVisible, view == "pill" else { return false }
    if speech.listening {
      if speech.liveSession != nil { panel.eval("cosShell.stopLive()"); speech.cancel() }
      else { speech.stop() }
      return true
    }
    if pageState == "thinking" {
      panel.eval("cosShell.status(\"Wait for the current reply to finish.\")")
      return true
    }
    if pageState == "speaking" { server.postJSON("api/speak/stop", [:]) }
    startListening()
    return true
  }

  /** Holding Control starts ordinary dictation; releasing it sends exactly that phrase. */
  private func beginPushToTalk() {
    guard ready else { return }
    if speech.liveSession != nil { panel.eval("cosShell.stopLive()"); speech.cancel() }
    if pageState == "speaking" { server.postJSON("api/speak/stop", [:]) }
    setView("pill")
    panel.show()
    startListening()
  }

  private func endPushToTalk() {
    if speech.liveSession != nil { panel.eval("cosShell.stopLive()"); speech.cancel() }
    else if speech.listening { speech.stop() }
  }

  private func cancelPushToTalk() {
    if speech.listening { speech.cancel() }
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
    case "liveListen":
      if let session = message["session"] as? String { startListening(liveSession: session) }
    case "stopLive":
      listenGeneration += 1
      speech.cancel()
    case "stopListen":
      if speech.liveSession != nil { panel.eval("cosShell.stopLive()"); speech.cancel() }
      else { speech.stop() }
    case "menu":
      // Same menu as the ✦ icon, opened where you clicked, so a hidden menubar icon never locks you out.
      statusItem.menu?.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    case "hide":
      listenGeneration += 1
      speech.cancel()
      panel.hide()
      resumeWake()
    case "open":
      if let s = message["url"] as? String, let url = URL(string: s) { NSWorkspace.shared.open(url) }
    default:
      break
    }
  }

  private func startListening(liveSession: String? = nil) {
    listenGeneration += 1
    let generation = listenGeneration
    speech.cancel()
    speech.authorize { [weak self] ok in
      guard let self, self.listenGeneration == generation else { return }
      guard ok else {
        let message = MicSpeechCopy.recoveryMessage(microphoneGranted: Permission.microphone.granted, speechGranted: Permission.speech.granted)
        self.panel.eval("cosShell.status(\(Self.js(message.isEmpty ? "Microphone or Speech Recognition is off — typing still works. Switch it on under ✦ › Permissions, then try again." : message)), true)")
        return
      }
      self.wake.stop() // one listener on the microphone at a time
      if let session = liveSession { self.panel.eval("cosShell.liveListening(\(Self.js(session)))") }
      else { self.panel.eval("cosShell.listening(true)") }
      self.speech.start(liveSession: liveSession)
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
