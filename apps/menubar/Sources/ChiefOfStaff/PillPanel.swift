import AppKit
import WebKit

/// A borderless, non-activating floating panel anchored bottom-centre of the
/// screen the mouse is on, hosting the pill page. Transparent, so only the
/// pill and its cards show. Grows upward as the page content grows.
final class PillPanel: NSPanel, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
  static let width: CGFloat = 700
  static let minHeight: CGFloat = 90
  static let bottomMargin: CGFloat = 14

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

  /// Keep the bottom edge where it is while the content grows or shrinks.
  func setHeight(_ h: CGFloat) {
    let maxH = (currentScreen()?.visibleFrame.height ?? 900) - 40
    let height = max(PillPanel.minHeight, min(h, maxH))
    guard abs(frame.height - height) > 0.5 else { return }
    var f = frame
    f.size.height = height
    setFrame(f, display: true, animate: false)
  }

  private func currentScreen() -> NSScreen? {
    let mouse = NSEvent.mouseLocation
    return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
  }

  func reposition() {
    guard let screen = currentScreen()?.visibleFrame else { return }
    var f = frame
    f.origin.x = screen.midX - f.width / 2
    f.origin.y = screen.minY + PillPanel.bottomMargin
    setFrame(f, display: true)
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
