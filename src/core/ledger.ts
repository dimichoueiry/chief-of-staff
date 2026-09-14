/**
 * The commitments ledger: one markdown block per project in goals/projects.md.
 *
 *   ## MLGuerrilla
 *   - why: teach ML the way I wish I'd been taught
 *   - status: active          # active | parked | done | killed
 *   - cadence: Thursday
 *   - next: record the intro video for lesson 3
 *   - last touched: 2026-09-02
 *   - deadline: none
 *   - notes: video setup lives in ~/Desktop/mlguerrilla-teach
 *
 * The parser is tolerant: unknown lines inside a block are preserved verbatim,
 * field keys are case-insensitive, and trailing `# comments` on a field line are
 * ignored. Every write is a git commit in the selfhub repo.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { commitPaths, ensureRepo } from "./git.js";
import { selfhubPaths } from "./paths.js";

export type ProjectStatus = "active" | "parked" | "done" | "killed";
export const PROJECT_STATUSES: readonly ProjectStatus[] = ["active", "parked", "done", "killed"];

export interface Project {
  name: string;
  why?: string;
  /** Raw status text as written. Use normalizeStatus() for logic. */
  status: string;
  cadence?: string;
  next?: string;
  /** YYYY-MM-DD */
  lastTouched?: string;
  deadline?: string;
  notes?: string;
  /** Folder on disk, used to map git activity to this project. */
  path?: string;
  /** Cadence nudges are suppressed until this YYYY-MM-DD (set by "not this week"). */
  skipUntil?: string;
  /** Unknown lines inside the block, preserved verbatim on write. */
  extra: string[];
}

export type ProjectPatch = Partial<Omit<Project, "name" | "extra">>;

export interface LedgerDoc {
  preamble: string[];
  projects: Project[];
}

type FieldKey = Exclude<keyof Project, "name" | "extra">;

/** Canonical write order and the label used in the file. */
const FIELDS: ReadonlyArray<[FieldKey, string]> = [
  ["why", "why"],
  ["status", "status"],
  ["cadence", "cadence"],
  ["next", "next"],
  ["lastTouched", "last touched"],
  ["deadline", "deadline"],
  ["notes", "notes"],
  ["path", "path"],
  ["skipUntil", "skip until"],
];

const KEY_ALIASES: Record<string, FieldKey> = Object.fromEntries(
  FIELDS.flatMap(([key, label]) => [
    [label.replace(/\s+/g, ""), key],
    [key.toLowerCase(), key],
  ]),
);

const FIELD_LINE = /^\s*[-*]\s*([A-Za-z][A-Za-z _-]*?)\s*:\s*(.*)$/;
const HEADING = /^##\s+(.+?)\s*$/;

function stripComment(value: string): string {
  // "active   # active | parked" -> "active". A '#' glued to text is kept.
  return value.replace(/\s+#.*$/, "").trim();
}

export function normalizeStatus(status: string | undefined): ProjectStatus {
  const s = (status ?? "").trim().toLowerCase();
  return (PROJECT_STATUSES as readonly string[]).includes(s) ? (s as ProjectStatus) : "active";
}

export function parseLedger(markdown: string): LedgerDoc {
  const doc: LedgerDoc = { preamble: [], projects: [] };
  let current: Project | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const heading = HEADING.exec(line);
    if (heading) {
      current = { name: heading[1], status: "active", extra: [] };
      doc.projects.push(current);
      continue;
    }
    if (!current) {
      if (line.trim()) doc.preamble.push(line);
      continue;
    }
    const field = FIELD_LINE.exec(line);
    const key = field ? KEY_ALIASES[field[1].toLowerCase().replace(/[\s_-]+/g, "")] : undefined;
    if (field && key) {
      const value = stripComment(field[2]);
      if (key === "status") current.status = value || "active";
      else if (value) current[key] = value;
      continue;
    }
    if (line.trim()) current.extra.push(line);
  }
  return doc;
}

export function serializeLedger(doc: LedgerDoc): string {
  const out: string[] = [];
  out.push(...(doc.preamble.length ? doc.preamble : ["# Projects"]));
  for (const p of doc.projects) {
    out.push("", `## ${p.name}`);
    for (const [key, label] of FIELDS) {
      const value = p[key];
      if (value !== undefined && value !== "") out.push(`- ${label}: ${value}`);
    }
    out.push(...p.extra);
  }
  return out.join("\n") + "\n";
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Case-insensitive match on name, then on a punctuation-free slug. */
export function findProject(projects: Project[], name: string): Project | undefined {
  const lower = name.trim().toLowerCase();
  return (
    projects.find((p) => p.name.toLowerCase() === lower) ??
    projects.find((p) => slug(p.name) === slug(name))
  );
}

export class Ledger {
  readonly paths;

  constructor(readonly selfhubDir: string) {
    this.paths = selfhubPaths(selfhubDir);
  }

  async readDoc(): Promise<LedgerDoc> {
    try {
      return parseLedger(await readFile(this.paths.ledger, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { preamble: [], projects: [] };
      throw err;
    }
  }

  async read(): Promise<Project[]> {
    return (await this.readDoc()).projects;
  }

  async find(name: string): Promise<Project | undefined> {
    return findProject(await this.read(), name);
  }

  /** Create or update a project, then commit. Returns the resulting project. */
  async writeProject(
    name: string,
    patch: ProjectPatch,
    message?: string,
  ): Promise<{ project: Project; created: boolean; commit: string | null }> {
    const doc = await this.readDoc();
    let project = findProject(doc.projects, name);
    const created = !project;
    if (!project) {
      project = { name: name.trim(), status: "active", extra: [] };
      doc.projects.push(project);
    }
    for (const [key, value] of Object.entries(patch) as [keyof ProjectPatch, string | undefined][]) {
      if (value === undefined) continue;
      if (key === "status") project.status = value;
      else project[key] = value;
    }
    const commit = await this.writeDoc(
      doc,
      message ?? `cos: ${created ? "add" : "update"} project "${project.name}"`,
    );
    return { project, created, commit };
  }

  async touch(name: string, dateISO: string): Promise<boolean> {
    const doc = await this.readDoc();
    const project = findProject(doc.projects, name);
    if (!project) return false;
    if (project.lastTouched && project.lastTouched >= dateISO) return false;
    project.lastTouched = dateISO;
    await this.writeDoc(doc, `cos: touch "${project.name}" (${dateISO})`);
    return true;
  }

  async writeDoc(doc: LedgerDoc, message: string): Promise<string | null> {
    await ensureRepo(this.selfhubDir);
    await mkdir(dirname(this.paths.ledger), { recursive: true });
    await writeFile(this.paths.ledger, serializeLedger(doc), "utf8");
    return commitPaths(this.selfhubDir, [relative(this.selfhubDir, this.paths.ledger)], message);
  }
}
