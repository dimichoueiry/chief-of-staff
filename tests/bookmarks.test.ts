import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findBookmarks, formatBookmarks, readBookmarks } from "../src/actions/bookmarks.js";
import { resolveOpen } from "../src/actions/open.js";

const edgeFile = {
  roots: {
    bookmark_bar: {
      type: "folder", name: "Favorites Bar",
      children: [
        { type: "folder", name: "UIUC", children: [
          { type: "url", name: "Campuswire", url: "https://campuswire.com/c/G53D5855E/feed" },
          { type: "url", name: "Mail - Outlook", url: "https://outlook.office.com/mail/" },
        ] },
        { type: "url", name: "Slate", url: "https://slate-iota-lac.vercel.app/app" },
        { type: "url", name: "a script", url: "javascript:alert(1)" },
      ],
    },
    other: { type: "folder", name: "Other favorites", children: [] },
  },
};

describe("browser favorites", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cos-bm-"));
    const edge = join(home, "Library/Application Support/Microsoft Edge");
    await mkdir(join(edge, "Profile 2"), { recursive: true });
    await mkdir(join(edge, "Crashpad"), { recursive: true });
    await writeFile(join(edge, "Profile 2", "Bookmarks"), JSON.stringify(edgeFile));
  });
  afterEach(async () => {
    await chmod(join(home, "Library/Application Support/Google/Chrome"), 0o755).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });

  it("reads every profile's favorites with their folders, web addresses only", async () => {
    const r = await readBookmarks(home);
    expect(r.browsers).toEqual(["Edge"]);
    expect(r.blocked).toEqual([]);
    expect(r.bookmarks.map((b) => `${b.browser}/${b.profile} ${b.folder} › ${b.name}`)).toEqual([
      "Edge/Profile 2 Favorites Bar / UIUC › Campuswire",
      "Edge/Profile 2 Favorites Bar / UIUC › Mail - Outlook",
      "Edge/Profile 2 Favorites Bar › Slate",
    ]);
  });

  it("finds what was said, even misheard, and opens it in the browser it's saved in", async () => {
    const r = await readBookmarks(home);
    expect(findBookmarks(r.bookmarks, "open campus wire in my UIC folder in my favorites")[0]).toMatchObject({ name: "Campuswire" });
    expect(findBookmarks(r.bookmarks, "kubernetes docs")).toEqual([]);

    const opened = await resolveOpen({ target: "campus wire from my favorites", shortcuts: [], projects: [], bookmarks: () => readBookmarks(home) });
    expect(opened).toEqual({ ok: true, action: { kind: "url", url: "https://campuswire.com/c/G53D5855E/feed", label: "“Campuswire” from your Edge favorites", trusted: true, app: "Microsoft Edge" } });
    // Without saying "favorites", a bookmark is the last thing tried, after shortcuts, Slate, projects and apps.
    expect(await resolveOpen({ target: "open campuswire", shortcuts: [], projects: [], bookmarks: () => readBookmarks(home) })).toMatchObject({ ok: true, action: { url: "https://campuswire.com/c/G53D5855E/feed" } });
  });

  it("says plainly when macOS blocks a browser's data, instead of finding nothing", async () => {
    const chrome = join(home, "Library/Application Support/Google/Chrome");
    await mkdir(chrome, { recursive: true });
    await chmod(chrome, 0o000);
    const r = await readBookmarks(home);
    if (process.getuid?.() === 0) return;
    expect(r.blocked).toEqual(["Chrome"]);
    expect(formatBookmarks(r, [], "gmail")).toBe(
      'No bookmark close to "gmail" among 3 bookmarks in Edge, Chrome.\nmacOS won\'t let Chief of Staff read Chrome\'s favorites. Turn on Chief of Staff in System Settings › Privacy & Security › Full Disk Access, then ask again.',
    );
    const blockedOnly = await resolveOpen({ target: "open my gmail favorite", shortcuts: [], projects: [], bookmarks: async () => ({ bookmarks: [], blocked: ["Edge"], browsers: ["Edge"] }) });
    expect(blockedOnly).toMatchObject({ ok: false, reason: expect.stringMatching(/Full Disk Access/) });
  });
});
