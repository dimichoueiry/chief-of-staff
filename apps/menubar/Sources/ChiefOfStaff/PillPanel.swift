import AppKit
import WebKit

/// A borderless, non-activating floating panel hosting the pill page: bottom-centre
/// of the screen the mouse is on, or wherever it was dragged to (the page sends the
/// drag; see Placement). Transparent, so only the pill and its cards show. Grows
/// upward as the page content grows.
final class PillPanel: NSPanel, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
  static let width: CGFloat = 700
  static let minHeight: CGFloat = 90
  private static let placementKey = "pillPlacement"

  let webView: WKWebView
  var onMessage: (([String: Any]) -> Void)?
  var onResignKey: (() -> Void)?
  private var loaded = false
  private var pendingJS: [String] = []

  init() {
    let config = WKWebViewConfiguration()
    config.userContentController.add(MessageProxy.shared, name: "shell")
    webView = WKWebView(frame: .zero, configuration: config)

    super.init(
      contentRect: NSRect(x: 0, y: 0, width: PillPanel.width, height: PillPanel.minHeight),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    MessageProxy.shared.owner = self

    level = .floating
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    hidesOnDeactivate = false
    isReleasedWhenClosed = false
    becomesKeyOnlyIfNeeded = false
    delegate = self

    webView.setValue(false, forKey: "drawsBackground")
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.autoresizingMask = [.width, .height]
    contentView = webView
    reposition()
  }

  required init?(coder: NSCoder) { fatalError("PillPanel is created in code") }

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  func load(_ url: URL) {
    loaded = false
    webView.load(URLRequest(url: url))
  }

  /// Keep the bottom edge where it is while the content grows or shrinks, and all of it on screen.
  func setHeight(_ h: CGFloat) {
    let maxH = (windowScreen()?.visibleFrame.height ?? 900) - 40
    let height = max(PillPanel.minHeight, min(h, maxH))
    guard abs(frame.height - height) > 0.5 else { return }
    var f = frame
    f.size.height = height
    if let visible = windowScreen()?.visibleFrame { f = Placement.clamp(f, into: visible) }
    setFrame(f, display: true, animate: false)
  }

  private func currentScreen() -> NSScreen? {
    let mouse = NSEvent.mouseLocation
    return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
  }

  /// The screen the window's bottom-centre is on (while dragging, or placed), else the mouse's.
  private func windowScreen() -> NSScreen? {
    let spot = CGPoint(x: frame.midX, y: frame.minY)
    return NSScreen.screens.first { $0.frame.insetBy(dx: -1, dy: -1).contains(spot) } ?? currentScreen()
  }

  /// Where it was dragged to, as the window's bottom-centre; nil for the default spot.
  var placement: CGPoint? {
    guard let p = UserDefaults.standard.dictionary(forKey: Self.placementKey), let x = p["x"] as? Double, let y = p["y"] as? Double else { return nil }
    return CGPoint(x: x, y: y)
  }

  func reposition() {
    guard let fallback = currentScreen()?.visibleFrame else { return }
    let f = Placement.frame(saved: placement, size: frame.size, screens: NSScreen.screens.map(\.visibleFrame), fallback: fallback)
    setFrame(f, display: true)
  }

  /// Follow a drag from the page: dx right, dy down, in points.
  func move(dx: CGFloat, dy: CGFloat) {
    var f = frame
    f.origin.x += dx
    f.origin.y -= dy // the page counts down, the screen counts up
    // Across screens: keep it on whichever one the mouse is on now.
    if let visible = currentScreen()?.visibleFrame { f = Placement.clamp(f, into: visible) }
    setFrame(f, display: true, animate: false)
  }

  /// The drag ended: remember the spot for next time it's summoned.
  func savePlacement() {
    UserDefaults.standard.set(["x": Double(frame.midX), "y": Double(frame.minY)], forKey: Self.placementKey)
  }

  /// Back to bottom-centre, and forget the spot.
  func resetPlacement() {
    UserDefaults.standard.removeObject(forKey: Self.placementKey)
    reposition()
  }

  func show() {
    reposition()
    makeKeyAndOrderFront(nil)
    makeFirstResponder(webView)
    eval("window.cosShell && cosShell.focus()")
  }

  func hide() { orderOut(nil) }

  func eval(_ js: String) {
    guard loaded else { pendingJS.append(js); return }
    webView.evaluateJavaScript(js) { _, error in
      if let error { Log.write("js error: \(error.localizedDescription) in \(js.prefix(80))") }
    }
  }

  func receive(_ body: Any) {
    guard let dict = body as? [String: Any] else { return }
    onMessage?(dict)
  }

  // MARK: NSWindowDelegate

  func windowDidResignKey(_ notification: Notification) { onResignKey?() }

  // MARK: WKNavigationDelegate

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    loaded = true
    let queued = pendingJS
    pendingJS.removeAll()
    for js in queued { eval(js) }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    Log.write("page failed: \(error.localizedDescription)")
  }

  // MARK: WKUIDelegate — listening is native, so the page never gets the browser mic.

  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(.deny)
  }
}

/// WKUserContentController retains its handlers strongly; route through a
/// shared proxy that holds the panel weakly, so there is no retain cycle.
final class MessageProxy: NSObject, WKScriptMessageHandler {
  static let shared = MessageProxy()
  weak var owner: PillPanel?

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    owner?.receive(message.body)
  }
}
