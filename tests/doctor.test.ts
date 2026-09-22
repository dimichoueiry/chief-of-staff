import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MIN_NODE, atLeast, checkBrowser, checkBuild, checkCalendar, checkCosHome, checkInstall, checkKeys, checkNode, checkScheduler,
  exitCode, formatReport, parseVersion, type Check,
} from "../src/cli/doctor.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cos-doctor-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("versions", () => {
  it("parses node-style versions and rejects junk", () => {
    expect(parseVersion("v22.12.0")).toEqual([22, 12, 0]);
    expect(parseVersion("24.1.3-nightly")).toEqual([24, 1, 3]);
    expect(parseVersion("twenty")).toBeNull();
  });

  it("compares by number, not by string", () => {
    expect(atLeast("22.12.0", "22.12.0")).toBe(true);
    expect(atLeast("22.11.9", "22.12.0")).toBe(false);
    expect(atLeast("22.100.0", "22.12.0")).toBe(true);
    expect(atLeast("24.0.0", "22.12.0")).toBe(true);
    expect(atLeast("20.19.0", "22.12.0")).toBe(false);
    expect(atLeast("garbage", "22.12.0")).toBe(false);
  });

  it("fails Node below the minimum and says how to fix it", () => {
    expect(checkNode("22.12.0").status).toBe("pass");
    const old = checkNode("22.11.0");
    expect(old.status).toBe("fail");
    expect(old.fix).toMatch(/22\.12\.0/);
  });

  it("keeps package.json engines in step with the doctor's minimum", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${MIN_NODE}`);
  });
});

describe("install and build", () => {
  it("names the missing packages", () => {
    const c = checkInstall("/repo", (p) => p !== "openai");
    expect(c).toMatchObject({ status: "fail", detail: "missing: openai" });
    expect(c.fix).toContain("npm install");
    expect(checkInstall("/repo", () => true).status).toBe("pass");
  });

  it("finds packages in the project's node_modules, including ones whose exports hide package.json", () => {
    expect(checkInstall(resolve(".")).status).toBe("pass");
    expect(checkInstall(tmp()).status).toBe("fail");
  });

  it("only warns when the build is missing", () => {
    expect(checkBuild(tmp()).status).toBe("warn");
  });
});

describe("~/.cos", () => {
  it("warns when it doesn't exist yet", () => {
    expect(checkCosHome(join(tmp(), "nope")).status).toBe("warn");
  });

  it("passes a healthy folder and names settings files that no longer parse", () => {
    const d = tmp();
    writeFileSync(join(d, "models.json"), "{}");
    expect(checkCosHome(d).status).toBe("pass");
    writeFileSync(join(d, "voice.json"), "{ half");
    const c = checkCosHome(d);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("voice.json");
    expect(c.detail).not.toContain("models.json");
  });

  it("fails when the path is a file", () => {
    const f = join(tmp(), "cos");
    writeFileSync(f, "");
    expect(checkCosHome(f).status).toBe("fail");
  });
});

describe("keys", () => {
  it("names the providers with a key and never prints the key", () => {
    const secret = "sk-ant-THIS-MUST-NOT-APPEAR";
    const c = checkKeys({ ANTHROPIC_API_KEY: secret, OPENROUTER_API_KEY: "or-secret-too" }, "/x/.env");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("Anthropic");
    expect(c.detail).toContain("OpenRouter");
    const text = formatReport([c]);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("or-secret-too");
  });

  it("warns with the fix when no provider has a key", () => {
    const c = checkKeys({}, join(tmp(), ".env"));
    expect(c.status).toBe("warn");
    expect(c.fix).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe("scheduler", () => {
  const job = (label: string, installed: boolean, loaded: boolean) => ({ label, installed, loaded });

  it("warns off macOS and when nothing is installed", () => {
    expect(checkScheduler("linux", []).status).toBe("warn");
    expect(checkScheduler("darwin", [job("a", false, false)]).fix).toBe("cos scheduler install");
  });

  it("fails an installed job launchd isn't running", () => {
    const c = checkScheduler("darwin", [job("a", true, true), job("b", true, false)]);
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("b");
  });

  it("passes when every job is loaded, warns when some are missing", () => {
    expect(checkScheduler("darwin", [job("a", true, true), job("b", true, true)]).status).toBe("pass");
    expect(checkScheduler("darwin", [job("a", true, true), job("b", false, false)]).status).toBe("warn");
  });
});

describe("calendar and browser", () => {
  it("fails an unknown pinned provider and warns when no reader is found", () => {
    expect(checkCalendar("outlook", null).status).toBe("fail");
    expect(checkCalendar(undefined, "none").status).toBe("warn");
    expect(checkCalendar("none", "none").status).toBe("pass");
    expect(checkCalendar(undefined, "icalbuddy").status).toBe("pass");
  });

  it("needs Playwright MCP and a Chrome-family browser", () => {
    expect(checkBrowser({ chrome: true, edge: false, playwright: false }).status).toBe("fail");
    expect(checkBrowser({ chrome: false, edge: false, playwright: true }).status).toBe("warn");
    expect(checkBrowser({ chrome: false, edge: true, playwright: true }).status).toBe("pass");
    expect(checkBrowser({ channel: "chromium", chrome: false, edge: false, playwright: true }).detail).toContain("COS_BROWSER");
  });
});

describe("report and exit code", () => {
  const pass: Check = { name: "A", status: "pass", detail: "ok" };
  const warn: Check = { name: "B", status: "warn", detail: "meh", fix: "do b" };
  const fail: Check = { name: "C", status: "fail", detail: "bad", fix: "do c" };

  it("exits 1 only when something failed", () => {
    expect(exitCode([pass, warn])).toBe(0);
    expect(exitCode([pass, warn, fail])).toBe(1);
  });

  it("shows each check with its fix and a one-line summary", () => {
    const text = formatReport([pass, warn, fail]);
    expect(text).toContain("do b");
    expect(text).toContain("do c");
    expect(text).toContain("1 to fix, 1 to look at.");
    expect(formatReport([pass])).toContain("Ready.");
  });
});
