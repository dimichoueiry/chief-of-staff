/**
 * Your browser favorites and bookmarks, so "open Campuswire from my UIUC
 * favorites" opens exactly what you saved, in the browser you saved it in.
 * Read-only, from the Chromium browsers' Bookmarks files (Edge, Chrome, Brave,
 * Arc, Vivaldi) across every profile.
 *
 * macOS may block the app from reading another app's data ("Operation not
 * permitted"). That is reported per browser, with the setting that fixes it,
 * never silently treated as "no bookmarks".
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { nameScore } from "./folders.js";

export interface Bookmark {
  name: string;
  url: string;
  /** Folder path inside the browser, e.g. "Favorites Bar / UIUC". */
  folder: string;
  browser: string;
  /** App name to open it with, e.g. "Microsoft Edge". */
  app: string;
  profile: string;
}

export interface BookmarkRead {
  bookmarks: Bookmark[];
  /** Browsers whose data macOS wouldn't let the app read. */
  blocked: string[];
  /** Browsers found, whether or not they could be read. */
  browsers: string[];
}

export const BROWSERS = [
  { browser: "Edge", app: "Microsoft Edge", dir: "Library/Application Support/Microsoft Edge" },
  { browser: "Chrome", app: "Google Chrome", dir: "Library/Application Support/Google/Chrome" },
  { browser: "Brave", app: "Brave Browser", dir: "Library/Application Support/BraveSoftware/Brave-Browser" },
  { browser: "Arc", app: "Arc", dir: "Library/Application Support/Arc/User Data" },
  { browser: "Vivaldi", app: "Vivaldi", dir: "Library/Application Support/Vivaldi" },
];

interface Node {
  type?: string;
  name?: string;
  url?: string;
  children?: Node[];
}

function walk(node: Node, folder: string[], out: Omit<Bookmark, "browser" | "app" | "profile">[]): void {
  if (node.type === "url" && node.url && /^https?:/i.test(node.url)) {
    out.push({ name: node.name ?? node.url, url: node.url, folder: folder.join(" / ") });
    return;
  }
  const inside = node.type === "folder" && node.name ? [...folder, node.name] : folder;
  for (const child of node.children ?? []) walk(child, inside, out);
}

export async function readBookmarks(home: string = homedir()): Promise<BookmarkRead> {
  const result: BookmarkRead = { bookmarks: [], blocked: [], browsers: [] };
  for (const b of BROWSERS) {
    const root = join(home, b.dir);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        result.browsers.push(b.browser);
        result.blocked.push(b.browser);
      }
      continue; // ENOENT: not installed
    }
    result.browsers.push(b.browser);
    for (const profile of entries.filter((e) => e === "Default" || /^Profile \d+$/.test(e))) {
      let raw: string;
      try {
        raw = await readFile(join(root, profile, "Bookmarks"), "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code === "EPERM" || code === "EACCES") && !result.blocked.includes(b.browser)) result.blocked.push(b.browser);
        continue;
      }
      let roots: Record<string, Node>;
      try {
        roots = (JSON.parse(raw) as { roots?: Record<string, Node> }).roots ?? {};
      } catch {
        continue;
      }
      const found: Omit<Bookmark, "browser" | "app" | "profile">[] = [];
      for (const r of Object.values(roots)) if (r && typeof r === "object") walk(r, [], found);
      result.bookmarks.push(...found.map((f) => ({ ...f, browser: b.browser, app: b.app, profile })));
    }
  }
  return result;
}

const FILLER = /\b(?:open|my|the|in|on|from|inside|under|folder|favorites?|favourites?|bookmarks?|bookmarked|saved|edge|chrome|brave|arc|browser|microsoft|google|page|site|link|please|called|named|that|you'?ll|see|it|as|bar)\b/gi;

/** Best matches for what was said: the bookmark's name counts most, its folder helps ("UIUC" or a misheard "UIC"). */
export function findBookmarks(bookmarks: Bookmark[], query: string, limit = 8): Array<Bookmark & { score: number }> {
  const words = query.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  if (!words) return [];
  const browserWanted = BROWSERS.find((b) => new RegExp(`\\b${b.browser}\\b`, "i").test(query));
  const scored = bookmarks.map((b) => {
    const byName = nameScore(words, b.name);
    const folders = b.folder.split(" / ").filter(Boolean);
    const inFolder = folders.some((f) => query.toLowerCase().split(/\W+/).some((w) => w.length >= 3 && nameScore(w, f) >= 0.7));
    // "campus wire uiuc": try the name against what's left once a folder word is taken out.
    const withoutFolder = folders.reduce((q, f) => q.replace(new RegExp(`\\b${f.replace(/[^\w]/g, "")}\\b`, "i"), " "), words).trim();
    const byRest = withoutFolder && withoutFolder !== words ? nameScore(withoutFolder, b.name) : 0;
    const score = Math.max(byName, byRest) + (inFolder ? 0.1 : 0) + (browserWanted && browserWanted.browser === b.browser ? 0.05 : 0);
    return { ...b, score };
  });
  return scored
    .filter((b) => b.score >= 0.7)
    .sort((a, b) => b.score - a.score)
    .filter((b, i, all) => all.findIndex((x) => x.url === b.url) === i)
    .slice(0, limit);
}

export function blockedMessage(blocked: string[]): string {
  return `macOS won't let Chief of Staff read ${blocked.join(" and ")}'s favorites. Turn on Chief of Staff in System Settings › Privacy & Security › Full Disk Access, then ask again.`;
}

export function formatBookmarks(read: BookmarkRead, matches: Array<Bookmark & { score: number }>, query: string): string {
  const lines: string[] = [];
  if (matches.length) {
    lines.push(`${matches.length} bookmark${matches.length === 1 ? "" : "s"} close to "${query}", best first:`);
    for (const m of matches) lines.push(`- ${m.name} (${m.browser}${m.profile === "Default" ? "" : `, ${m.profile}`} › ${m.folder || "top level"}) ${m.url}`);
  } else {
    lines.push(`No bookmark close to "${query}" among ${read.bookmarks.length} bookmarks${read.browsers.length ? ` in ${read.browsers.join(", ")}` : ""}.`);
  }
  if (read.blocked.length) lines.push(blockedMessage(read.blocked));
  return lines.join("\n");
}
