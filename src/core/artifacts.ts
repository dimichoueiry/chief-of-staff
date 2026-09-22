/**
 * Things the assistant made for you: an image, a post, a page, a document. They are files in
 * ~/.cos/artifacts, not memory, because they are drafts — you look at one, ask for a
 * change, save the one you want and forget the rest.
 *
 * Each artifact is two files: the thing itself (<id>.png, <id>.html, <id>.md) and <id>.json beside
 * it saying what it is and what it was made from. Ids arrive from the page's address bar,
 * so they are checked against a strict shape before anything is read.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { todayISO } from "../util/dates.js";
import { cosHome } from "../util/home.js";

export type ArtifactKind = "image" | "page" | "doc";

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  /** A few words, shown on the card and in the window title. */
  title: string;
  /** File name inside the artifacts folder, e.g. "2026-09-20-3f9c2a.png". */
  file: string;
  mediaType: string;
  createdAt: string;
  /** image: what it was asked for, kept so "same but at night" has something to work from. */
  prompt?: string;
  /** image: provider:model that drew it. */
  model?: string;
  /** image: the artifact this one was a change to. */
  from?: string;
}

/** What a reply carries back to the page: enough to draw the card, not the file itself. */
export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  title: string;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "text/html": "html",
  "text/markdown": "md",
};

const DEFAULT_TITLES: Record<ArtifactKind, string> = { image: "Image", page: "Page", doc: "Document" };

/** Ids are used as file names and come back from URLs: only these characters, ever. */
const ID = /^[0-9a-z-]{10,40}$/;

export function artifactsDir(): string {
  return join(cosHome(), "artifacts");
}

export function isArtifactId(id: string): boolean {
  return ID.test(id);
}

export function ref(a: Artifact): ArtifactRef {
  return { id: a.id, kind: a.kind, title: a.title };
}

function newId(today = todayISO()): string {
  return `${today}-${randomBytes(3).toString("hex")}`;
}

export interface SaveArtifact {
  kind: ArtifactKind;
  title: string;
  data: Buffer | string;
  mediaType: string;
  prompt?: string;
  model?: string;
  from?: string;
}

export function saveArtifact(o: SaveArtifact, dir = artifactsDir()): Artifact {
  const ext = EXTENSIONS[o.mediaType];
  if (!ext) throw new Error(`Nothing here can hold a ${o.mediaType}.`);
  const id = newId();
  const artifact: Artifact = {
    id,
    kind: o.kind,
    title: o.title.trim() || DEFAULT_TITLES[o.kind],
    file: `${id}.${ext}`,
    mediaType: o.mediaType,
    createdAt: new Date().toISOString(),
    ...(o.prompt ? { prompt: o.prompt } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.from ? { from: o.from } : {}),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, artifact.file), o.data);
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

export function getArtifact(id: string, dir = artifactsDir()): Artifact | null {
  if (!isArtifactId(id)) return null;
  try {
    const a = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as Artifact;
    return a && a.id === id ? a : null;
  } catch {
    return null;
  }
}

/** The artifact and its bytes, or null when either is missing. */
export function readArtifact(id: string, dir = artifactsDir()): { artifact: Artifact; data: Buffer } | null {
  const artifact = getArtifact(id, dir);
  if (!artifact) return null;
  try {
    return { artifact, data: readFileSync(join(dir, artifact.file)) };
  } catch {
    return null;
  }
}

/** Newest first. */
export function listArtifacts(dir = artifactsDir()): Artifact[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => getArtifact(f.slice(0, -5), dir))
    .filter((a): a is Artifact => Boolean(a))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteArtifact(id: string, dir = artifactsDir()): boolean {
  const a = getArtifact(id, dir);
  if (!a) return false;
  rmSync(join(dir, a.file), { force: true });
  rmSync(join(dir, `${a.id}.json`), { force: true });
  return true;
}
