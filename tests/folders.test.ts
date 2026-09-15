import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findFolders, formatFolderSearch, nameScore } from "../src/actions/folders.js";
import { git } from "../src/core/git.js";

describe("nameScore", () => {
  it("forgives misspelling, mishearing, spacing and filler words", () => {
    expect(nameScore("ML gorilla", "mlguerilla")).toBeGreaterThanOrEqual(0.8);
    expect(nameScore("the ML gorilla codebase", "mlguerilla")).toBeGreaterThanOrEqual(0.8);
    expect(nameScore("ML gorilla", "mlguerrilla-teach")).toBeGreaterThanOrEqual(0.6);
    expect(nameScore("agent grid", "AgentGrid")).toBe(1);
    expect(nameScore("goated professor", "TheGoatedProfessor")).toBe(0.9);
    expect(nameScore("ML gorilla", "flutter")).toBeLessThan(0.3);
    expect(nameScore("x", "x-files")).toBe(0);
  });
});

describe("findFolders", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cos-folders-"));
  });
  afterEach(async () => {
    await chmod(join(home, "Locked"), 0o755).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });

  async function repo(path: string, readme: string) {
    await mkdir(path, { recursive: true });
    await git(path, ["init", "-q"]);
    await git(path, ["config", "user.email", "t@example.com"]);
    await git(path, ["config", "user.name", "T"]);
    await writeFile(join(path, "README.md"), readme);
    await mkdir(join(path, "app"));
    await git(path, ["add", "."]);
    await git(path, ["commit", "-q", "-m", "init"]);
  }

  it("finds a misheard project across the usual places, best and git repos first, with what's inside", async () => {
    await repo(join(home, "Documents", "GitHub", "mlguerilla"), "# ML Guerilla\n\nA course platform for ML engineers.\n");
    await mkdir(join(home, "Desktop", "mlguerrilla-teach", "module-6"), { recursive: true });
    await mkdir(join(home, "Desktop", "flutter"), { recursive: true });
    await mkdir(join(home, "Documents", "a", "b", "c", "mlguerilla"), { recursive: true }); // four levels down: too deep
    await mkdir(join(home, "Documents", "GitHub", "mlguerilla", "app", "mlguerilla-inner"), { recursive: true }); // inside a repo

    const r = await findFolders("ML gorilla", { home });
    expect(r.matches.map((m) => m.path)).toEqual([join(home, "Documents", "GitHub", "mlguerilla"), join(home, "Desktop", "mlguerrilla-teach")]);
    expect(r.total).toBe(2);
    expect(r.matches[0]).toMatchObject({ git: true, readme: "ML Guerilla", entries: ["app/", "README.md"] });
    expect(r.matches[0].lastCommit).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.unreadable).toEqual([]);
    expect(r.truncated).toBe(false);

    const text = formatFolderSearch(r, home);
    expect(text.split("\n")[0]).toBe('2 folders close to "ML gorilla", best first:');
    expect(text).toMatch(/^1\. ~\/Documents\/GitHub\/mlguerilla \(mlguerilla\) — git repo, last commit \d{4}-\d{2}-\d{2}; README: "ML Guerilla"; contains app\/, README\.md$/m);
    expect(text).toMatch(/^2\. ~\/Desktop\/mlguerrilla-teach \(mlguerrilla-teach\) — folder, modified \d{4}-\d{2}-\d{2}; contains module-6\/$/m);
    expect(text).toContain("Searched ~/Desktop, ~/Documents, ~/Documents/GitHub, ~ (top level):");
  });

  it("says what it couldn't read and when it stopped early, and searches a given place first", async () => {
    await mkdir(join(home, "Locked", "secret-project"), { recursive: true });
    await chmod(join(home, "Locked"), 0o000);
    await mkdir(join(home, "work", "clients", "acme-portal"), { recursive: true });

    const found = await findFolders("acme portal", { home, roots: [join(home, "work"), join(home, "Locked")] });
    expect(found.matches.map((m) => m.path)).toEqual([join(home, "work", "clients", "acme-portal")]);
    if (process.getuid?.() !== 0) {
      expect(found.unreadable).toEqual(["~/Locked (EACCES)"]);
      expect(formatFolderSearch(found, home)).toContain("Couldn't read: ~/Locked (EACCES). If that's macOS privacy");
    }

    for (let i = 0; i < 30; i++) await mkdir(join(home, "Desktop", `folder-${i}`), { recursive: true });
    const cut = await findFolders("acme portal", { home, budget: 10 });
    expect(cut.truncated).toBe(true);
    expect(cut.scanned).toBe(10);
    expect(formatFolderSearch(cut, home)).toContain("Stopped early: too many folders. Results may be incomplete");

    const none = await findFolders("kubernetes", { home });
    expect(formatFolderSearch(none, home).split("\n")[0]).toBe('No folder name close to "kubernetes".');
  });
});
