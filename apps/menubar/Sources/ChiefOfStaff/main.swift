import AppKit

// A menubar-only app: no dock icon, no main window. The pill is a floating
// panel summoned by double-tapping Fn (or ⌥Space), hosting the local page
// that `cos ui` serves.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
