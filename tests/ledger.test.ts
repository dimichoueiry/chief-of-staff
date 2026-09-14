import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, findProject, normalizeStatus, parseLedger, serializeLedger } from "../src/core/ledger.js";
import { git } from "../src/core/git.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

const SAMPLE = `# Projects

Some intro text I wrote by hand.

## MLGuerrilla
- why: teach ML the way I wish I'd been taught; audience I already have
- status: active          # active | parked | done | killed
- cadence: Thursday       # or "weekly", "daily", "none"
- next: record the intro video for lesson 3
- Last Touched: 2026-09-02
- deadline: none
- notes: video setup lives in ~/Desktop/mlguerrilla-teach
- a free-form bullet the parser has never seen
Plain prose under the project.

## drawcal
- why: ship the calendar tool
- status: parked
`;

describe("parseLedger / serializeLedger", () => {
  it("parses fields case-insensitively and strips trailing comments", () => {
    const doc = parseLedger(SAMPLE);
    expect(doc.projects).toHaveLength(2);
    const [ml, dc] = doc.projects;
    expect(ml.name).toBe("MLGuerrilla");
    expect(ml.status).toBe("active");
    expect(ml.cadence).toBe("Thursday");
    expect(ml.lastTouched).toBe("2026-09-02");
    expect(ml.notes).toContain("~/Desktop/mlguerrilla-teach");
    expect(dc.status).toBe("parked");
    expect(doc.preamble).toEqual(["# Projects", "Some intro text I wrote by hand."]);
  });

  it("preserves unknown lines verbatim across a round trip", () => {
    const doc = parseLedger(SAMPLE);
    expect(doc.projects[0].extra).toEqual([
      "- a free-form bullet the parser has never seen",
      "Plain prose under the project.",
    ]);
    const again = parseLedger(serializeLedger(doc));
    expect(again).toEqual(doc);
  });

  it("keeps an unrecognised status as written but normalises it for logic", () => {
    const doc = parseLedger("## X\n- status: On Hold\n");
    expect(doc.projects[0].status).toBe("On Hold");
    expect(normalizeStatus(doc.projects[0].status)).toBe("active");
    expect(serializeLedger(doc)).toContain("- status: On Hold");
  });

  it("finds projects by loose name", () => {
    const { projects } = parseLedger(SAMPLE);
    expect(findProject(projects, "mlguerrilla")?.name).toBe("MLGuerrilla");
    expect(findProject(projects, "ML Guerrilla")?.name).toBe("MLGuerrilla");
    expect(findProject(projects, "nope")).toBeUndefined();
  });
});

describe("Ledger (on disk, git-backed)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await makeTmpSelfhub()));
  afterEach(() => cleanup());

  it("returns an empty ledger when the file does not exist", async () => {
    expect(await new Ledger(dir).read()).toEqual([]);
  });

  it("upserts a project and commits every write", async () => {
    const ledger = new Ledger(dir);
    const first = await ledger.writeProject("Fampy Academy", { why: "course revenue", next: "outline" });
    expect(first.created).toBe(true);
    expect(first.commit).toMatch(/^[0-9a-f]{7,}$/);

    const second = await ledger.writeProject("fampy academy", { status: "parked" });
    expect(second.created).toBe(false);
    expect(second.project.why).toBe("course revenue");
    expect(second.project.status).toBe("parked");

    const file = await readFile(ledger.paths.ledger, "utf8");
    expect(file).toContain("## Fampy Academy");
    expect(file).toContain("- status: parked");

    const log = await git(dir, ["log", "--format=%s"]);
    expect(log.trim().split("\n")).toEqual([
      'cos: update project "Fampy Academy"',
      'cos: add project "Fampy Academy"',
    ]);
  });

  it("does not create a commit when nothing changed", async () => {
    const ledger = new Ledger(dir);
    await ledger.writeProject("A", { why: "x" });
    const again = await ledger.writeProject("A", { why: "x" });
    expect(again.commit).toBeNull();
  });

  it("touch only moves lastTouched forward", async () => {
    const ledger = new Ledger(dir);
    await ledger.writeProject("A", { lastTouched: "2026-09-10" });
    expect(await ledger.touch("A", "2026-09-05")).toBe(false);
    expect(await ledger.touch("A", "2026-09-12")).toBe(true);
    expect((await ledger.find("A"))?.lastTouched).toBe("2026-09-12");
    expect(await ledger.touch("missing", "2026-09-12")).toBe(false);
  });
});
