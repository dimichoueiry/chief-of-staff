import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteArtifact, getArtifact, isArtifactId, listArtifacts, readArtifact, saveArtifact } from "../src/core/artifacts.js";
import { MAX_INSTRUCTIONS, PERSONA, persona, readInstructions, saveInstructions } from "../src/brain/persona.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("artifacts", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-artifacts-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("keeps the thing itself beside what it is, and reads both back", () => {
    const image = saveArtifact({ kind: "image", title: "launch post", data: PNG, mediaType: "image/png", prompt: "a lemon", model: "openrouter:x/y" }, dir);
    expect(image.file).toBe(`${image.id}.png`);
    expect(isArtifactId(image.id)).toBe(true);
    expect(getArtifact(image.id, dir)).toMatchObject({ title: "launch post", kind: "image", prompt: "a lemon", model: "openrouter:x/y" });
    expect(readArtifact(image.id, dir)!.data).toEqual(PNG);
    expect(readFileSync(join(dir, image.file))).toEqual(PNG);

    const page = saveArtifact({ kind: "page", title: "landing", data: "<!doctype html><p>hi", mediaType: "text/html" }, dir);
    expect(page.file.endsWith(".html")).toBe(true);
    expect(listArtifacts(dir).map((a) => a.title).sort()).toEqual(["landing", "launch post"]);

    expect(deleteArtifact(page.id, dir)).toBe(true);
    expect(getArtifact(page.id, dir)).toBeNull();
    expect(readArtifact(page.id, dir)).toBeNull();
    expect(deleteArtifact(page.id, dir)).toBe(false);
  });

  it("titles what was left untitled, and refuses a format it can't hold", () => {
    expect(saveArtifact({ kind: "image", title: "  ", data: PNG, mediaType: "image/png" }, dir).title).toBe("Image");
    expect(() => saveArtifact({ kind: "image", title: "x", data: PNG, mediaType: "image/gif" }, dir)).toThrow(/can hold/);
  });

  it("takes no id that could name a file outside the folder", () => {
    for (const id of ["../../etc/passwd", "a/b", "..", "short", "Upper-Case-Id", ""]) {
      expect(isArtifactId(id)).toBe(false);
      expect(getArtifact(id, dir)).toBeNull();
      expect(readArtifact(id, dir)).toBeNull();
    }
  });
});

describe("their own instructions", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cos-home-"));
    file = join(dir, "instructions.md");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("is added to the default, and deleting it leaves the default alone", () => {
    expect(readInstructions(file)).toBe("");
    expect(persona("")).toBe(PERSONA);

    saveInstructions("  Call me Dimitri. Three sentences, never more.  ", file);
    expect(readInstructions(file)).toBe("Call me Dimitri. Three sentences, never more.");
    const both = persona(readInstructions(file));
    expect(both.startsWith(PERSONA)).toBe(true);
    expect(both).toContain("# From them");
    expect(both).toContain("Call me Dimitri.");

    saveInstructions("   ", file);
    expect(readInstructions(file)).toBe("");
    expect(persona(readInstructions(file))).toBe(PERSONA);
  });

  it("stops at a page of instructions, saying how long theirs is", () => {
    expect(() => saveInstructions("x".repeat(MAX_INSTRUCTIONS + 1), file)).toThrow(new RegExp(`${MAX_INSTRUCTIONS.toLocaleString("en-US")}`));
    expect(readInstructions(file)).toBe("");
  });
});
