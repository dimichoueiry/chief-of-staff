/**
 * The macOS a Swift build has to run on.
 *
 * swiftc with no -target stamps whatever the installed toolchain happens to default to, which is
 * newer than the app claims and newer than anyone's Mac. A build stamped that way launches
 * nowhere but the machine that made it: dyld refuses it. So every helper names its target.
 *
 * 14.0 is the real floor, not a guess: cos-screen uses SCScreenshotManager and
 * NSScreen.pointPixelScale, both macOS 14. Below that it doesn't compile at all. Keep
 * LSMinimumSystemVersion (apps/menubar/Info.plist) and Package.swift's platform in step with it.
 */
export const MIN_MACOS = "14.0";

/** The architecture name lipo, codesign and Apple's targets use for this process. */
export function appleArch(nodeArch: string = process.arch): string {
  return nodeArch === "x64" ? "x86_64" : nodeArch;
}

/** "arm64-apple-macosx14.0" — what swiftc needs so the result runs on more than this Mac. */
export function swiftTarget(arch: string = appleArch(), minMacOS: string = MIN_MACOS): string {
  return `${arch}-apple-macosx${minMacOS}`;
}

/** The flags every swiftc call in this project starts with. */
export function swiftFlags(): string[] {
  return ["-O", "-target", swiftTarget()];
}
