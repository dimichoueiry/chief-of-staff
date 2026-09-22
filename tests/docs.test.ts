import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_MACOS } from "../src/util/swift.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens. */
const anchors = (md: string) =>
  new Set(
    [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
      m[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-"),
    ),
  );

describe("docs/INSTALL.md", () => {
  const install = read("docs/INSTALL.md");

  it("is linked from the README", () => {
    expect(read("README.md")).toContain("(docs/INSTALL.md)");
  });

  it("has no broken relative links or anchors", () => {
    for (const [, target] of install.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      const [path, hash] = target.split("#");
      const file = path ? resolve(ROOT, "docs", path) : join(ROOT, "docs/INSTALL.md");
      expect(existsSync(file), target).toBe(true);
      if (hash) expect(anchors(readFileSync(file, "utf8")).has(hash), target).toBe(true);
    }
  });

  it("names the real macOS floor", () => {
    expect(install).toContain(`macOS ${MIN_MACOS.replace(/\.0$/, "")}`);
  });

  it("names the real Node floor for the developer install", () => {
    const floor = JSON.parse(read("package.json")).engines.node.replace(/^>=/, "").replace(/\.0$/, "");
    expect(install).toContain(`Node ${floor}`);
  });

  it("never claims the build is notarized", () => {
    // Every mention of notarization must be a negation until there is a Developer ID (docs/DISTRIBUTION.md).
    for (const line of install.split("\n").filter((l) => /notari/i.test(l))) {
      expect(line, line).toMatch(/\bnot notarized\b|before a notarized release/i);
    }
  });
});
