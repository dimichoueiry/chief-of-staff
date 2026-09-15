import AppKit
import Carbon.HIToolbox

/// Two ways to summon the pill from any app:
/// - double-tap Fn → listen. Watching keys globally needs Accessibility permission.
/// - ⌥Space → type. Registered through Carbon; works with no permission at all.
final class HotkeyMonitor {
  var onFnDoubleTap: () -> Void = {}
  var onShortcut: () -> Void = {}

  /// Max gap between the two presses, and max length of a press that still counts as a tap.
  var doubleTapWindow: TimeInterval = 0.4
  var maxTapLength: TimeInterval = 0.35

  private var fnDown = false
  private var pressedAt: TimeInterval = 0
  private var lastTapAt: TimeInterval = 0
  private var monitors: [Any] = []
  private var hotKeyRef: EventHotKeyRef?
  private var handlerRef: EventHandlerRef?
  private var trustTimer: Timer?

  static func accessibilityTrusted(prompt: Bool) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
  }

  func start() {
    registerShortcut()
    installKeyMonitors()
    // Global monitors installed before the permission is granted stay deaf,
    // so reinstall them the moment Accessibility is switched on.
    if !HotkeyMonitor.accessibilityTrusted(prompt: false) {
      trustTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] timer in
        guard HotkeyMonitor.accessibilityTrusted(prompt: false) else { return }
        timer.invalidate()
        self?.installKeyMonitors()
        Log.write("accessibility granted; fn monitor reinstalled")
      }
    }
  }

  func stop() {
    trustTimer?.invalidate()
    removeKeyMonitors()
    if let ref = hotKeyRef { UnregisterEventHotKey(ref) }
    if let ref = handlerRef { RemoveEventHandler(ref) }
  }

  private func installKeyMonitors() {
    removeKeyMonitors()
    let flags: (NSEvent) -> Void = { [weak self] e in self?.handleFlags(e) }
    let keys: (NSEvent) -> Void = { [weak self] _ in self?.lastTapAt = 0 } // fn+arrow etc. is not a tap
    if let m = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: flags) { monitors.append(m) }
    if let m = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: keys) { monitors.append(m) }
    if let m = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged, handler: { e in flags(e); return e }) { monitors.append(m) }
  }

  private func removeKeyMonitors() {
    for m in monitors { NSEvent.removeMonitor(m) }
    monitors.removeAll()
  }

  private func handleFlags(_ e: NSEvent) {
    guard e.keyCode == UInt16(kVK_Function) else {
      lastTapAt = 0 // another modifier in between breaks the double tap
      return
    }
    let now = ProcessInfo.processInfo.systemUptime
    let down = e.modifierFlags.contains(.function)
    if down && !fnDown {
      fnDown = true
      pressedAt = now
    } else if !down && fnDown {
      fnDown = false
      guard now - pressedAt <= maxTapLength else { lastTapAt = 0; return } // a hold, not a tap
      if lastTapAt > 0 && now - lastTapAt <= doubleTapWindow {
        lastTapAt = 0
        onFnDoubleTap()
      } else {
        lastTapAt = now
      }
    }
  }

  // MARK: ⌥Space via Carbon

  private func registerShortcut() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let selfPtr = Unmanaged.passUnretained(self).toOpaque()
    InstallEventHandler(GetApplicationEventTarget(), { _, _, userData -> OSStatus in
      guard let userData else { return noErr }
      let monitor = Unmanaged<HotkeyMonitor>.fromOpaque(userData).takeUnretainedValue()
      DispatchQueue.main.async { monitor.onShortcut() }
      return noErr
    }, 1, &spec, selfPtr, &handlerRef)
    let id = EventHotKeyID(signature: OSType(0x434F_5321), id: 1) // "COS!"
    let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
    if status != noErr { Log.write("⌥Space is taken by another app (status \(status))") }
  }
}
