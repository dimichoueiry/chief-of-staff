import AppKit

/// The window where someone puts their API keys in.
///
/// Whoever was handed the packaged app has no repo and no Terminal, so the keys can't live only in
/// ~/.cos/.env. The rows come from the server (GET api/keys), which also owns the file, so adding a
/// provider there needs no change here. Each key is posted on its own and checked with one live
/// request; the row then says whether it answered. A saved key is never shown again, only masked.
final class KeysWindow: NSObject, NSWindowDelegate {
  private let server: ServerManager
  private var window: NSWindow?
  private let rows = NSStackView()
  private var fields: [String: NSSecureTextField] = [:]
  private var status: [String: NSTextField] = [:]
  private var removeButtons: [String: NSButton] = [:]
  private var order: [String] = []
  private var saveButton: NSButton!
  private var footer: NSTextField!
  private var built = false

  init(server: ServerManager) {
    self.server = server
    super.init()
  }

  // MARK: showing

  func show() {
    NSApp.activate(ignoringOtherApps: true)
    if window == nil { makeWindow() }
    window?.makeKeyAndOrderFront(nil)
    window?.center()
    refresh()
  }

  private func makeWindow() {
    let w = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 560, height: 400),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    w.title = "API keys"
    w.delegate = self
    w.isReleasedWhenClosed = false

    let heading = NSTextField(labelWithString: "Chief of Staff needs one of these to think.")
    heading.font = .systemFont(ofSize: 13, weight: .semibold)
    let sub = NSTextField(wrappingLabelWithString: "One is enough — any of them answers everything. Paste a key and it is checked straight away.")
    sub.font = .systemFont(ofSize: 11)
    sub.textColor = .secondaryLabelColor

    rows.orientation = .vertical
    rows.alignment = .leading
    rows.spacing = 18

    footer = NSTextField(wrappingLabelWithString: "")
    footer.font = .systemFont(ofSize: 11)
    footer.textColor = .secondaryLabelColor

    saveButton = NSButton(title: "Save", target: self, action: #selector(save))
    saveButton.keyEquivalent = "\r"
    saveButton.bezelStyle = .rounded
    let close = NSButton(title: "Close", target: self, action: #selector(closeWindow))
    close.bezelStyle = .rounded
    let buttons = NSStackView(views: [close, saveButton])
    buttons.orientation = .horizontal
    buttons.spacing = 10

    let content = NSStackView(views: [heading, sub, rows, footer])
    content.orientation = .vertical
    content.alignment = .leading
    content.spacing = 12
    content.translatesAutoresizingMaskIntoConstraints = false
    buttons.translatesAutoresizingMaskIntoConstraints = false

    let root = NSView()
    root.addSubview(content)
    root.addSubview(buttons)
    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
      content.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
      content.topAnchor.constraint(equalTo: root.topAnchor, constant: 20),
      buttons.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
      buttons.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -16),
      buttons.topAnchor.constraint(greaterThanOrEqualTo: content.bottomAnchor, constant: 16),
    ])
    w.contentView = root
    window = w
  }

  @objc private func closeWindow() { window?.close() }

  // MARK: rows

  private func refresh() {
    server.getJSON("api/keys") { [weak self] obj in
      guard let self, let state = obj as? [String: Any] else { return }
      let keys = state["keys"] as? [[String: Any]] ?? []
      if !self.built { self.build(keys); self.built = true }
      self.apply(state)
    }
  }

  private func build(_ keys: [[String: Any]]) {
    for view in rows.arrangedSubviews { rows.removeArrangedSubview(view); view.removeFromSuperview() }
    fields.removeAll(); status.removeAll(); removeButtons.removeAll(); order.removeAll()

    for key in keys {
      guard let provider = key["provider"] as? String else { continue }
      order.append(provider)

      let title = NSTextField(labelWithString: key["label"] as? String ?? provider)
      title.font = .systemFont(ofSize: 12, weight: .medium)
      let link = NSButton(title: "Get a key", target: self, action: #selector(openKeyPage(_:)))
      link.bezelStyle = .inline
      link.controlSize = .small
      link.identifier = NSUserInterfaceItemIdentifier(key["keyUrl"] as? String ?? "")
      let spacer = NSView()
      let head = NSStackView(views: [title, spacer, link])
      head.orientation = .horizontal
      head.spacing = 8

      let field = NSSecureTextField()
      field.placeholderString = "paste your key here"
      field.controlSize = .regular
      // No action of its own: Return goes to Save, the default button, from whichever field has focus.
      fields[provider] = field

      let remove = NSButton(title: "Remove", target: self, action: #selector(removeKey(_:)))
      remove.bezelStyle = .rounded
      remove.controlSize = .small
      remove.identifier = NSUserInterfaceItemIdentifier(provider)
      remove.isHidden = true
      removeButtons[provider] = remove

      let entry = NSStackView(views: [field, remove])
      entry.orientation = .horizontal
      entry.spacing = 8

      let note = NSTextField(wrappingLabelWithString: "")
      note.font = .systemFont(ofSize: 11)
      note.textColor = .secondaryLabelColor
      status[provider] = note

      let row = NSStackView(views: [head, entry, note])
      row.orientation = .vertical
      row.alignment = .leading
      row.spacing = 4
      rows.addArrangedSubview(row)

      row.translatesAutoresizingMaskIntoConstraints = false
      NSLayoutConstraint.activate([
        row.widthAnchor.constraint(equalToConstant: 520),
        head.widthAnchor.constraint(equalTo: row.widthAnchor),
        entry.widthAnchor.constraint(equalTo: row.widthAnchor),
        note.widthAnchor.constraint(equalTo: row.widthAnchor),
        field.widthAnchor.constraint(equalToConstant: 430),
      ])
    }
  }

  /// Whether each key is set, and where the file is. Never the key itself.
  private func apply(_ state: [String: Any]) {
    for key in state["keys"] as? [[String: Any]] ?? [] {
      guard let provider = key["provider"] as? String, let field = fields[provider] else { continue }
      let isSet = key["set"] as? Bool ?? false
      let masked = key["masked"] as? String ?? ""
      field.placeholderString = isSet ? "saved: \(masked) — paste a new one to replace it" : "paste your key here"
      removeButtons[provider]?.isHidden = !isSet
      if let note = key["note"] as? String {
        status[provider]?.stringValue = note
        status[provider]?.textColor = .systemOrange
      } else if status[provider]?.textColor == .secondaryLabelColor || (status[provider]?.stringValue.isEmpty ?? true) {
        status[provider]?.stringValue = isSet ? "" : "not set"
        status[provider]?.textColor = .secondaryLabelColor
      }
    }
    let file = state["file"] as? String ?? "~/.cos/.env"
    let ready = state["ready"] as? Bool ?? false
    footer.stringValue = ready
      ? "Kept in \(file), readable only by you."
      : "Nothing is set yet, so it answers from its own notes only. Kept in \(file), readable only by you."
  }

  // MARK: actions

  @objc private func openKeyPage(_ sender: NSButton) {
    guard let s = sender.identifier?.rawValue, let url = URL(string: s) else { return }
    NSWorkspace.shared.open(url)
  }

  @objc private func removeKey(_ sender: NSButton) {
    guard let provider = sender.identifier?.rawValue else { return }
    post(provider, value: "")
  }

  /// Every field that was typed in, one after another, so each answer lands on its own row.
  @objc private func save() {
    let typed = order.filter { !(fields[$0]?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
    guard !typed.isEmpty else {
      footer.stringValue = "Paste a key into one of the boxes first."
      return
    }
    saveButton.isEnabled = false
    for provider in typed {
      status[provider]?.stringValue = "checking…"
      status[provider]?.textColor = .secondaryLabelColor
    }
    postNext(Array(typed))
  }

  private func postNext(_ queue: [String]) {
    guard let provider = queue.first else {
      saveButton.isEnabled = true
      refresh()
      return
    }
    let value = fields[provider]?.stringValue ?? ""
    post(provider, value: value) { [weak self] in self?.postNext(Array(queue.dropFirst())) }
  }

  private func post(_ provider: String, value: String, then: (() -> Void)? = nil) {
    server.postJSON("api/keys", ["provider": provider, "value": value]) { [weak self] obj in
      guard let self else { return }
      let result = obj as? [String: Any]
      if let error = result?["error"] as? String {
        self.status[provider]?.stringValue = error
        self.status[provider]?.textColor = .systemRed
      } else if let result {
        let works = result["works"] as? Bool ?? false
        let message = result["message"] as? String ?? "Saved"
        self.status[provider]?.stringValue = works ? "\(message). \(result["detail"] as? String ?? "")" : message
        self.status[provider]?.textColor = works ? .systemGreen : .systemOrange
        if works || (result["ok"] as? Bool ?? false) { self.fields[provider]?.stringValue = "" }
        if !works, let detail = result["detail"] as? String, result["ok"] as? Bool ?? false {
          Log.write("key for \(provider) saved but unverified: \(detail.prefix(120))")
        }
        self.apply(result)
      } else {
        self.status[provider]?.stringValue = "The app's server didn't answer. See ~/.cos/logs/menubar-server.log."
        self.status[provider]?.textColor = .systemRed
      }
      if let then { then() } else { self.refresh() }
    }
  }
}
