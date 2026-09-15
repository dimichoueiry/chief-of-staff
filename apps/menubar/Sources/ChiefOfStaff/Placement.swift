import CoreGraphics

/// Where the pill's window sits: bottom-centre of the screen by default, or where it was dragged to.
///
/// The window is wider than what's drawn in it (the bar is centred, and compact it's a small mic), so it
/// may hang off the side of the screen as long as its middle stays on it. It never hangs off the top or
/// bottom: the bar is at the bottom of the window and the chat grows upward from it.
enum Placement {
  /// How close to a side edge the middle of the window may go.
  static let sideReach: CGFloat = 60
  static let bottomMargin: CGFloat = 14

  /// The default spot: centred, just above the bottom of the screen.
  static func home(size: CGSize, in visible: CGRect) -> CGRect {
    CGRect(x: visible.midX - size.width / 2, y: visible.minY + bottomMargin, width: size.width, height: size.height)
  }

  /// A frame moved just enough to be on screen: middle between the sides, top and bottom inside.
  static func clamp(_ frame: CGRect, into visible: CGRect) -> CGRect {
    var f = frame
    f.size.height = min(f.height, visible.height)
    let mid = min(max(f.midX, visible.minX + sideReach), visible.maxX - sideReach)
    f.origin.x = mid - f.width / 2
    if f.maxY > visible.maxY { f.origin.y = visible.maxY - f.height }
    if f.minY < visible.minY { f.origin.y = visible.minY }
    return f
  }

  /// The frame for a saved spot (the window's bottom-centre), on the screen it was left on; home when that
  /// screen is gone or nothing was saved.
  static func frame(saved: CGPoint?, size: CGSize, screens: [CGRect], fallback: CGRect) -> CGRect {
    guard let saved, let screen = screens.first(where: { $0.insetBy(dx: -1, dy: -1).contains(saved) }) else {
      return home(size: size, in: fallback)
    }
    return clamp(CGRect(x: saved.x - size.width / 2, y: saved.y, width: size.width, height: size.height), into: screen)
  }
}
