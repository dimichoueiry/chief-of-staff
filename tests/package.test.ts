import { describe, expect, it } from "vitest";
import { appleArch, dmgName, parseArchs } from "../src/cli/package.js";

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
