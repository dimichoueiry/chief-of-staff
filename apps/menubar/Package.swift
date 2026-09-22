// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "ChiefOfStaff",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "ChiefOfStaff",
      path: "Sources/ChiefOfStaff",
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("WebKit"),
        .linkedFramework("Speech"),
        .linkedFramework("AVFoundation"),
        .linkedFramework("Carbon"),
        .linkedFramework("UserNotifications"),
      ]
    )
  ]
)
