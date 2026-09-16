import { describe, expect, it } from "vitest";
import { appleArch, compareVersions, dmgName, parseArchs, parseMinOS } from "../src/cli/package.js";
import { MIN_MACOS, swiftFlags, swiftTarget } from "../src/util/swift.js";

describe("packaging the app", () => {
  it("reads lipo's architecture list, so a universal node gets thinned and a single-arch one is copied", () => {
    expect(parseArchs("x86_64 arm64\n")).toEqual(["x86_64", "arm64"]);
    expect(parseArchs("arm64\n")).toEqual(["arm64"]);
  });

  it("names architectures the way lipo does", () => {
    expect(appleArch("x64")).toBe("x86_64");
    expect(appleArch("arm64")).toBe("arm64");
  });

  it("names the disk image after the app, version and architecture", () => {
    expect(dmgName("0.1.0", "arm64")).toBe("Chief-of-Staff-0.1.0-arm64.dmg");
  });
});

describe("the macOS a build runs on", () => {
  it("names a target so swiftc can't stamp the toolchain's default", () => {
    expect(swiftTarget("arm64", "14.0")).toBe("arm64-apple-macosx14.0");
    expect(swiftFlags()).toContain("-target");
    // 14.0 is the floor because cos-screen uses macOS 14 APIs; below it, it doesn't compile.
    expect(MIN_MACOS).toBe("14.0");
  });

  it("reads what vtool says a binary needs, and compares versions properly", () => {
    expect(parseMinOS("    platform MACOS\n    minos 14.0\n    sdk 15.0")).toBe("14.0");
    expect(parseMinOS("no build version here")).toBeNull();
    expect(compareVersions("18.0", "14.0")).toBe(1);
    expect(compareVersions("14.0", "14.0")).toBe(0);
    expect(compareVersions("13.5", "14.0")).toBe(-1);
    expect(compareVersions("14", "14.0")).toBe(0);
  });
});
