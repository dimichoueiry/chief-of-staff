import AppKit
import Carbon.HIToolbox

/// Two ways to summon the pill from any app:
/// - double-tap Control (left or right) → listen. Watching keys globally needs Accessibility permission.
/// - ⌥Space → type. Registered through Carbon; works with no permission at all.
///
/// A "tap" is Control pressed and released on its own, quickly. Control used as a
/// modifier (⌃C, ⌃-click, ⌃⇧…) never counts, so normal shortcuts don't summon the pill.
final class HotkeyMonitor {
  var onDoubleTap: () -> Void = {}
  var onShortcut: () -> Void = {}

  /// Max gap between the two taps, and max length of a press that still counts as a tap.
  var doubleTapWindow: TimeInterval = 0.4
  var maxTapLength: TimeInterval = 0.3

  private static let controlKeys: Set<UInt16> = [UInt16(kVK_Control), UInt16(kVK_RightControl)]

  private var down = false
  private var usedAsModifier = false
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
        Log.write("accessibility granted; control monitor reinstalled")
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
    // Any key or click while Control is down makes it a modifier, not a tap; any key between taps cancels.
    let other: (NSEvent) -> Void = { [weak self] _ in
      guard let self else { return }
      if self.down { self.usedAsModifier = true }
      self.lastTapAt = 0
    }
    let mice: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    if let m = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: flags) { monitors.append(m) }
    if let m = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: other) { monitors.append(m) }
    if let m = NSEvent.addGlobalMonitorForEvents(matching: mice, handler: other) { monitors.append(m) }
    if let m = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged, handler: { e in flags(e); return e }) { monitors.append(m) }
    if let m = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { e in other(e); return e }) { monitors.append(m) }
  }

  private func removeKeyMonitors() {
    for m in monitors { NSEvent.removeMonitor(m) }
    monitors.removeAll()
  }

  private func handleFlags(_ e: NSEvent) {
    let now = ProcessInfo.processInfo.systemUptime
    guard HotkeyMonitor.controlKeys.contains(e.keyCode) else {
      // Another modifier (⇧ ⌥ ⌘ fn) changed: a combo, not a tap.
      if down { usedAsModifier = true }
      lastTapAt = 0
      return
    }
    let isDown = e.modifierFlags.contains(.control)
    // Only Control may be held: ⌃ with ⌘/⌥/⇧ already down is a combo.
    let others: NSEvent.ModifierFlags = [.command, .option, .shift, .function]
    if isDown && !down {
      down = true
      pressedAt = now
      usedAsModifier = !e.modifierFlags.intersection(others).isEmpty
    } else if !isDown && down {
      down = false
      let wasTap = !usedAsModifier && now - pressedAt <= maxTapLength
      usedAsModifier = false
      guard wasTap else {
        lastTapAt = 0
        return
      }
      if lastTapAt > 0 && now - lastTapAt <= doubleTapWindow {
        lastTapAt = 0
        onDoubleTap()
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
