import AppKit

/// Where someone adds the other tools they use: Gmail, Notion, GitHub, their own thing.
///
/// A connection is an MCP server — a command on this Mac, or an address someone hosts. The list,
/// the services worth naming and the warning all come from the server (api/connections), so adding
/// a service to the catalogue needs no change here. Saving checks the connection straight away and
/// the row says what came back, which is the same bargain as the keys window: nothing is claimed
/// to work until it has answered once.
final class ConnectionsWindow: NSObject, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
  private let server: ServerManager
  private var window: NSWindow?
  private let table = NSTableView()
  private var rows: [[String: Any]] = []
  private var catalogue: [[String: Any]] = []
  private var registry = "https://modelcontextprotocol.io/registry"
  private var trust = ""
  private var addButton: NSPopUpButton!
  private var statusLine: NSTextField!
  private var trustLine: NSTextField!

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
      contentRect: NSRect(x: 0, y: 0, width: 640, height: 460),
      styleMask: [.titled, .closable, .resizable],
      backing: .buffered,
      defer: false
    )
    w.title = "Connections"
    w.delegate = self
    w.isReleasedWhenClosed = false
    w.minSize = NSSize(width: 560, height: 360)

    let heading = NSTextField(labelWithString: "The other tools you use.")
    heading.font = .systemFont(ofSize: 13, weight: .semibold)
    let sub = NSTextField(wrappingLabelWithString: "Add one and it is checked straight away. Turn one off and it costs nothing.")
    sub.font = .systemFont(ofSize: 11)
    sub.textColor = .secondaryLabelColor

    // The list
    table.dataSource = self
    table.delegate = self
    table.rowHeight = 46
    table.usesAlternatingRowBackgroundColors = true
    table.headerView = nil
    table.allowsMultipleSelection = false
    let only = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("connection"))
    only.width = 580
    table.addTableColumn(only)
    let scroll = NSScrollView()
    scroll.documentView = table
    scroll.hasVerticalScroller = true
    scroll.borderType = .bezelBorder
    scroll.translatesAutoresizingMaskIntoConstraints = false

    // Add: the named services, then your own
    addButton = NSPopUpButton(frame: .zero, pullsDown: true)
    addButton.translatesAutoresizingMaskIntoConstraints = false

    statusLine = NSTextField(wrappingLabelShrinkingTo: "")
    trustLine = NSTextField(wrappingLabelShrinkingTo: "")
    trustLine.textColor = .secondaryLabelColor

    let findMore = NSButton(title: "Find servers", target: self, action: #selector(openRegistry))
    findMore.bezelStyle = .rounded
    let close = NSButton(title: "Close", target: self, action: #selector(closeWindow))
    close.bezelStyle = .rounded
    close.keyEquivalent = "\u{1b}"

    let buttons = NSStackView(views: [addButton, findMore, NSView(), close])
    buttons.orientation = .horizontal
    buttons.spacing = 10
    buttons.translatesAutoresizingMaskIntoConstraints = false

    let header = NSStackView(views: [heading, sub])
    header.orientation = .vertical
    header.alignment = .leading
    header.spacing = 4
    header.translatesAutoresizingMaskIntoConstraints = false

    let footer = NSStackView(views: [statusLine, trustLine])
    footer.orientation = .vertical
    footer.alignment = .leading
    footer.spacing = 4
    footer.translatesAutoresizingMaskIntoConstraints = false

    let root = NSView()
    for v in [header, scroll, footer, buttons] { root.addSubview(v) }
    NSLayoutConstraint.activate([
      header.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
      header.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
      header.topAnchor.constraint(equalTo: root.topAnchor, constant: 20),

      scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
      scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
      scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 12),

      footer.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
      footer.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
      footer.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 10),

      buttons.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
      buttons.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
      buttons.topAnchor.constraint(equalTo: footer.bottomAnchor, constant: 12),
      buttons.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -16),
    ])
    w.contentView = root
    window = w
  }

  @objc private func closeWindow() { window?.close() }
  @objc private func openRegistry() {
    if let url = URL(string: registry) { NSWorkspace.shared.open(url) }
  }

  // MARK: state

  private func refresh() {
    server.getJSON("api/connections") { [weak self] obj in
      guard let self, let state = obj as? [String: Any] else { return }
      self.apply(state)
    }
  }

  private func apply(_ state: [String: Any]) {
    rows = state["connections"] as? [[String: Any]] ?? rows
    catalogue = state["catalogue"] as? [[String: Any]] ?? catalogue
    registry = state["registry"] as? String ?? registry
    trust = state["trust"] as? String ?? trust
    trustLine.stringValue = trust
    if let usable = state["usable"] as? Bool, !usable, !rows.isEmpty {
      statusLine.stringValue = "Saved and checked. The assistant doesn't call these yet — that's the next piece of work."
      statusLine.textColor = .systemOrange
    } else if rows.isEmpty {
      statusLine.stringValue = "Nothing added yet."
      statusLine.textColor = .secondaryLabelColor
    }
    rebuildAddMenu()
    table.reloadData()
  }

  private func rebuildAddMenu() {
    let menu = NSMenu()
    menu.addItem(withTitle: "Add…", action: nil, keyEquivalent: "") // the pull-down's own title
    for entry in catalogue {
      guard let label = entry["label"] as? String else { continue }
      let item = NSMenuItem(title: label, action: #selector(addFromCatalogue(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = entry
      menu.addItem(item)
    }
    if !catalogue.isEmpty { menu.addItem(.separator()) }
    let own = NSMenuItem(title: "Something else…", action: #selector(addYourOwn), keyEquivalent: "")
    own.target = self
    menu.addItem(own)
    addButton.menu = menu
  }

  // MARK: the list

  func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    let c = rows[row]
    let id = c["id"] as? String ?? ""
    let enabled = c["enabled"] as? Bool ?? false
    let missing = c["missing"] as? [String] ?? []

    let on = NSButton(checkboxWithTitle: c["label"] as? String ?? id, target: self, action: #selector(toggle(_:)))
    on.state = enabled ? .on : .off
    on.identifier = NSUserInterfaceItemIdentifier(id)
    on.font = .systemFont(ofSize: 12, weight: .medium)

    let detail = NSTextField(labelWithString: c["address"] as? String ?? "")
    detail.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
    detail.textColor = .secondaryLabelColor
    detail.lineBreakMode = .byTruncatingMiddle

    let left = NSStackView(views: [on, detail])
    left.orientation = .vertical
    left.alignment = .leading
    left.spacing = 1

    let warn = NSTextField(labelWithString: missing.isEmpty ? "" : "needs \(missing.joined(separator: ", "))")
    warn.font = .systemFont(ofSize: 10)
    warn.textColor = .systemOrange

    let check = NSButton(title: "Check", target: self, action: #selector(check(_:)))
    check.bezelStyle = .rounded
    check.controlSize = .small
    check.identifier = NSUserInterfaceItemIdentifier(id)

    let remove = NSButton(title: "Remove", target: self, action: #selector(remove(_:)))
    remove.bezelStyle = .rounded
    remove.controlSize = .small
    remove.identifier = NSUserInterfaceItemIdentifier(id)

    let stack = NSStackView(views: [left, NSView(), warn, check, remove])
    stack.orientation = .horizontal
    stack.spacing = 8
    stack.edgeInsets = NSEdgeInsets(top: 4, left: 6, bottom: 4, right: 6)
    return stack
  }

  // MARK: actions

  @objc private func toggle(_ sender: NSButton) {
    guard let id = sender.identifier?.rawValue else { return }
    post("api/connections/enable", ["id": id, "enabled": sender.state == .on])
  }

  @objc private func check(_ sender: NSButton) {
    guard let id = sender.identifier?.rawValue else { return }
    say("checking \(id)…", .secondaryLabelColor)
    post("api/connections/check", ["id": id])
  }

  @objc private func remove(_ sender: NSButton) {
    guard let id = sender.identifier?.rawValue, let c = rows.first(where: { ($0["id"] as? String) == id }) else { return }
    let a = NSAlert()
    a.messageText = "Remove \(c["label"] as? String ?? id)?"
    a.informativeText = "The assistant stops using it. Any token it used stays under API keys, so adding it back is quick."
    a.addButton(withTitle: "Remove")
    a.addButton(withTitle: "Cancel")
    a.buttons.first?.hasDestructiveAction = true
    guard a.runModal() == .alertFirstButtonReturn else { return }
    post("api/connections/remove", ["id": id])
  }

  @objc private func addFromCatalogue(_ sender: NSMenuItem) {
    guard let entry = sender.representedObject as? [String: Any] else { return }
    let label = entry["label"] as? String ?? ""
    let transport = entry["transport"] as? String ?? "stdio"
    let env = (entry["env"] as? [String] ?? []).joined(separator: " ")
    ask(
      title: "Add \(label)",
      message: "\(label) is usually \(entry["hint"] as? String ?? "a command or an address"). Find the exact one in the MCP registry, then paste it here.",
      label: label, transport: transport, address: "", env: env
    )
  }

  @objc private func addYourOwn() {
    ask(
      title: "Add a connection",
      message: "A command this Mac can run, or an https address someone hosts. Whatever it needs a token for, name the variable and put the value under API keys.",
      label: "", transport: "stdio", address: "", env: ""
    )
  }

  /// One sheet for both paths: a name, a command or an address, and the variables it needs.
  private func ask(title: String, message: String, label: String, transport: String, address: String, env: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = message

    let form = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 132))
    let nameField = NSTextField(frame: NSRect(x: 0, y: 104, width: 420, height: 24))
    nameField.placeholderString = "Name, e.g. Notion"
    nameField.stringValue = label

    let kind = NSSegmentedControl(labels: ["A command", "An address"], trackingMode: .selectOne, target: nil, action: nil)
    kind.frame = NSRect(x: 0, y: 72, width: 420, height: 24)
    kind.selectedSegment = transport == "http" ? 1 : 0

    let addressField = NSTextField(frame: NSRect(x: 0, y: 40, width: 420, height: 24))
    addressField.placeholderString = transport == "http" ? "https://mcp.example.com/mcp" : "npx -y some-mcp-server"
    addressField.stringValue = address

    let envField = NSTextField(frame: NSRect(x: 0, y: 8, width: 420, height: 24))
    envField.placeholderString = "Variables it needs, space separated, e.g. NOTION_TOKEN"
    envField.stringValue = env

    for v in [nameField, kind, addressField, envField] { form.addSubview(v) }
    a.accessoryView = form
    a.addButton(withTitle: "Add and check")
    a.addButton(withTitle: "Cancel")
    a.window.initialFirstResponder = nameField.stringValue.isEmpty ? nameField : addressField
    NSApp.activate(ignoringOtherApps: true)
    guard a.runModal() == .alertFirstButtonReturn else { return }

    let http = kind.selectedSegment == 1
    let typed = addressField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    var payload: [String: Any] = [
      "label": nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
      "transport": http ? "http" : "stdio",
      "env": envField.stringValue,
      "enabled": true,
    ]
    if http {
      payload["url"] = typed
    } else {
      // "npx -y thing" is one line to a person and a command plus arguments to a process.
      let parts = typed.split(separator: " ").map(String.init).filter { !$0.isEmpty }
      payload["command"] = parts.first ?? ""
      payload["args"] = Array(parts.dropFirst())
    }
    say("checking…", .secondaryLabelColor)
    post("api/connections", payload)
  }

  private func post(_ path: String, _ body: [String: Any]) {
    server.postJSON(path, body) { [weak self] obj in
      guard let self else { return }
      guard let result = obj as? [String: Any] else {
        self.say("The app's server didn't answer. See ~/.cos/logs/menubar-server.log.", .systemRed)
        return
      }
      if let error = result["error"] as? String {
        self.say(error, .systemRed)
      } else {
        let works = result["works"] as? Bool
        let message = result["message"] as? String ?? ""
        let detail = result["detail"] as? String ?? ""
        let colour: NSColor = works == false ? .systemOrange : (works == true ? .systemGreen : .secondaryLabelColor)
        self.say([message, detail].filter { !$0.isEmpty }.joined(separator: " "), colour)
      }
      self.apply(result)
    }
  }

  private func say(_ text: String, _ colour: NSColor) {
    statusLine.stringValue = text
    statusLine.textColor = colour
  }
}

private extension NSTextField {
  /// A wrapping label that doesn't stretch the window when the text is long.
  convenience init(wrappingLabelShrinkingTo text: String) {
    self.init(wrappingLabelWithString: text)
    font = .systemFont(ofSize: 11)
    setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
  }
}
