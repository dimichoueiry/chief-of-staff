// One still image of what's on screen, for Chief of Staff to look at.
//
//   cos-screen check                 {"permission": true|false}
//   cos-screen request               asks macOS for Screen Recording access (the system prompt)
//   cos-screen capture OUT [MAXSIDE] writes a JPEG of the display under the pointer, without
//                                    Chief of Staff's own windows, and prints what it captured
//
// Permission belongs to the app that started this helper (Chief of Staff), so no usage string here.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

func emit(_ object: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["error": code, "message": message])
  exit(code == "permission" ? 3 : 1)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage", "cos-screen check | request | capture OUT [MAXSIDE]") }

switch args[1] {
case "check":
  emit(["permission": CGPreflightScreenCaptureAccess()])
  exit(0)
case "request":
  emit(["permission": CGRequestScreenCaptureAccess()])
  exit(0)
case "capture":
  break
default:
  fail("usage", "cos-screen check | request | capture OUT [MAXSIDE]")
}

guard args.count >= 3 else { fail("usage", "cos-screen capture OUT [MAXSIDE]") }
let out = URL(fileURLWithPath: args[2])
let maxSide = args.count >= 4 ? (Double(args[3]) ?? 1600) : 1600
guard CGPreflightScreenCaptureAccess() else { fail("permission", "Screen Recording is off for Chief of Staff.") }

Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    // The display the pointer is on: where the pill shows, and where they're looking.
    let pointer = CGEvent(source: nil)?.location ?? .zero
    guard let display = content.displays.first(where: { $0.frame.contains(pointer) }) ?? content.displays.first else {
      fail("display", "No display to capture.")
    }
    let ours = content.applications.filter { $0.bundleIdentifier == "com.chief-of-staff.menubar" }
    let filter = SCContentFilter(display: display, excludingApplications: ours, exceptingWindows: [])

    let pixelScale = Double(filter.pointPixelScale)
    let widthPx = Double(display.width) * pixelScale
    let heightPx = Double(display.height) * pixelScale
    let shrink = min(1.0, maxSide / max(widthPx, heightPx))
    let config = SCStreamConfiguration()
    config.width = Int((widthPx * shrink).rounded())
    config.height = Int((heightPx * shrink).rounded())
    config.showsCursor = false

    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    guard let destination = CGImageDestinationCreateWithURL(out as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
      fail("write", "Could not create \(out.path).")
    }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.75] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { fail("write", "Could not write \(out.path).") }

    // What they're in: the frontmost app and its front window's title (the pill never takes focus).
    let front = NSWorkspace.shared.frontmostApplication
    let window = content.windows.first {
      $0.owningApplication?.processID == front?.processIdentifier && $0.isOnScreen && $0.windowLayer == 0 && !($0.title ?? "").isEmpty
    }
    emit([
      "path": out.path,
      "width": image.width,
      "height": image.height,
      "app": front?.bundleIdentifier == "com.chief-of-staff.menubar" ? "" : (front?.localizedName ?? ""),
      "window": window?.title ?? "",
    ])
    exit(0)
  } catch {
    fail("capture", error.localizedDescription)
  }
}
dispatchMain()
