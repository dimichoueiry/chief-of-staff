/**
 * Named places you open often, kept with your memory in ~/selfhub/links/shortcuts.md:
 *
 *   # Shortcuts
 *   - gmail: https://mail.google.com
 *   - drawcal repo: https://github.com/dimichoueiry/drawcal
 *   - notes folder: ~/Documents/notes
 *
 * Names are matched loosely ("open my gmail" finds "gmail"). Every change is a git commit.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { commitPaths, ensureRepo } from "../core/git.js";

export interface Shortcut {
  name: string;
  target: string;
}

export function shortcutsFile(selfhubDir: string): string {
  return join(selfhubDir, "links", "shortcuts.md");
}

const LINE = /^\s*[-*]\s*(.+?)\s*:\s+(\S.*?)\s*$/;

export function parseShortcuts(markdown: string): Shortcut[] {
  const out: Shortcut[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) out.push({ name: m[1], target: m[2] });
  }
  return out;
}

export function serializeShortcuts(shortcuts: Shortcut[]): string {
  return ["# Shortcuts", "", ...shortcuts.map((s) => `- ${s.name}: ${s.target}`)].join("\n") + "\n";
}

const norm = (s: string) => s.toLowerCase().replace(/^(my|the)\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();

export function findShortcut(shortcuts: Shortcut[], name: string): Shortcut | undefined {
  const q = norm(name);
  return shortcuts.find((s) => norm(s.name) === q) ?? shortcuts.find((s) => norm(s.name).replace(/ /g, "") === q.replace(/ /g, ""));
}

export class Shortcuts {
  constructor(readonly selfhubDir: string) {}

  get file(): string {
    return shortcutsFile(this.selfhubDir);
  }

  async list(): Promise<Shortcut[]> {
    try {
      return parseShortcuts(await readFile(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  async find(name: string): Promise<Shortcut | undefined> {
    return findShortcut(await this.list(), name);
  }

  async set(name: string, target: string): Promise<{ created: boolean }> {
    const all = await this.list();
    const existing = findShortcut(all, name);
    if (existing) existing.target = target.trim();
    else all.push({ name: name.trim(), target: target.trim() });
    await this.write(all, `cos: shortcut "${name.trim()}"`);
    return { created: !existing };
  }

  async remove(name: string): Promise<boolean> {
    const all = await this.list();
    const hit = findShortcut(all, name);
    if (!hit) return false;
    await this.write(all.filter((s) => s !== hit), `cos: remove shortcut "${hit.name}"`);
    return true;
  }

  private async write(shortcuts: Shortcut[], message: string): Promise<void> {
    await ensureRepo(this.selfhubDir);
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, serializeShortcuts(shortcuts), "utf8");
    await commitPaths(this.selfhubDir, [relative(this.selfhubDir, this.file)], message);
  }
}
