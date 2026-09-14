import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "../src/core/journal.js";
import { git } from "../src/core/git.js";
import { makeTmpSelfhub } from "./helpers/tmp-selfhub.js";

describe("Journal", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await makeTmpSelfhub()));
  afterEach(() => cleanup());

  it("creates a dated file with a header, appends, and commits", async () => {
    const j = new Journal(dir);
    await j.append("2026-09-14", "Touched drawcal. Next: cut export.");
    await j.append("2026-09-14", "Also replied to the design review.");
    const [entry] = await j.entries(1, "2026-09-14");
    expect(entry.date).toBe("2026-09-14");
    expect(entry.text).toBe(
      "# 2026-09-14\n\nTouched drawcal. Next: cut export.\n\nAlso replied to the design review.",
    );
    const log = await git(dir, ["log", "--format=%s"]);
    expect(log.trim().split("\n")).toEqual(["cos: journal 2026-09-14", "cos: journal 2026-09-14"]);
  });

  it("reads the last n days oldest-first and skips missing days", async () => {
    const j = new Journal(dir);
    await j.append("2026-09-10", "ten");
    await j.append("2026-09-13", "thirteen");
    const entries = await j.entries(7, "2026-09-14");
    expect(entries.map((e) => e.date)).toEqual(["2026-09-10", "2026-09-13"]);
    expect(await j.read(2, "2026-09-14")).toBe("# 2026-09-13\n\nthirteen");
  });
});
