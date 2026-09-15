import AppKit
import AVFoundation
import CoreGraphics
import Speech

/// The macOS permissions the app uses: whether each is on, how to ask for it, and its page in System Settings.
/// They belong to this bundle, so the server and the helpers it starts get the same ones.
/// macOS ties them to the exact build: after a rebuild a switch can show "on" and still not apply.
enum Permission: String, CaseIterable {
  case accessibility, microphone, speech, screen, fullDisk

  var name: String {
    switch self {
    case .accessibility: return "Accessibility"
    case .microphone: return "Microphone"
    case .speech: return "Speech Recognition"
    case .screen: return "Screen & System Audio Recording"
    case .fullDisk: return "Full Disk Access"
    }
  }

  /// What it's for, in the menu and the setup.
  var why: String {
    switch self {
    case .accessibility: return "double-tap Control from any app"
    case .microphone: return "talking to it"
    case .speech: return "understanding what you say"
    case .screen: return "\u{201C}look at this\u{201D}"
    case .fullDisk: return "opening your browser favorites"
    }
  }

  var granted: Bool {
    switch self {
    case .accessibility: return HotkeyMonitor.accessibilityTrusted(prompt: false)
    case .microphone: return AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    case .speech: return SFSpeechRecognizer.authorizationStatus() == .authorized
    case .screen: return CGPreflightScreenCaptureAccess()
    case .fullDisk: return Permission.canReadProtectedData()
    }
  }

  var settingsURL: URL {
    let anchor: String
    switch self {
    case .accessibility: anchor = "Privacy_Accessibility"
    case .microphone: anchor = "Privacy_Microphone"
    case .speech: anchor = "Privacy_SpeechRecognition"
    case .screen: anchor = "Privacy_ScreenCapture"
    case .fullDisk: anchor = "Privacy_AllFiles"
    }
    return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
  }

  /// macOS's own prompt when it still has one to show; otherwise its page in System Settings.
  /// `done(true)` means a page was opened and they have to switch Chief of Staff on there.
  func request(_ done: @escaping (Bool) -> Void) {
    switch self {
    case .microphone where AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined:
      AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async { done(false) } }
      return
    case .speech where SFSpeechRecognizer.authorizationStatus() == .notDetermined:
      SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async { done(false) } }
      return
    case .accessibility:
      _ = HotkeyMonitor.accessibilityTrusted(prompt: true) // also puts the app in the list
    case .screen:
      _ = CGRequestScreenCaptureAccess() // also puts the app in the list
    case .fullDisk:
      // No prompt exists for this one, and the app isn't listed until added: show it in Finder to drag in.
      NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    default:
      break
    }
    NSWorkspace.shared.open(settingsURL)
    done(true)
  }

  /// What to do on the page that just opened.
  var instructions: String {
    var steps = "Switch on Chief of Staff in the list System Settings just opened."
    if self == .fullDisk { steps += " If it isn't there, drag Chief of Staff in from the Finder window (or click +)." }
    if self == .screen || self == .fullDisk { steps += " If macOS offers Quit & Reopen, choose it: setup carries on when the app is back." }
    return steps + "\n\nAlready on? That switch is from an older build: select it, remove it with −, and add it back."
  }

  /// There's no call that says whether Full Disk Access is on, so try reading data only it unlocks.
  private static func canReadProtectedData() -> Bool {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let safari = home.appendingPathComponent("Library/Safari").path
    if FileManager.default.fileExists(atPath: safari) {
      return (try? FileManager.default.contentsOfDirectory(atPath: safari)) != nil
    }
    return FileHandle(forReadingAtPath: home.appendingPathComponent("Library/Application Support/com.apple.TCC/TCC.db").path) != nil
  }

  /// Changes with every build of the app, when macOS forgets its permissions.
  static var build: String {
    let path = Bundle.main.executablePath ?? ""
    let date = (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
    return String(Int(date?.timeIntervalSince1970 ?? 0))
  }
}
