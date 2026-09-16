/**
 * The audio player. A small Swift helper (compiled in the background on first use,
 * like the screen one) plays each file and exits as soon as it has played out.
 * afplay, the fallback while it builds or if it can't, lingers about a second after
 * every file: a pause after each sentence, and a late chime and mic after the last.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cosHome } from "../util/home.js";
import { swiftFlags } from "../util/swift.js";

const exec = promisify(execFile);
export const PLAYER_SRC = join(dirname(fileURLToPath(import.meta.url)), "player", "cos-play.swift");

export type Compile = (src: string, bin: string) => Promise<void>;

const swiftc: Compile = async (src, bin) => {
  await exec("swiftc", [...swiftFlags(), "-o", bin, src], { timeout: 180_000 });
};

/** Where the build for this source lives; a changed source gets a new build. */
export function playerBin(src: string = PLAYER_SRC): string {
  const version = createHash("sha1").update(readFileSync(src)).digest("hex").slice(0, 8);
  return join(cosHome(), "bin", `cos-play-${version}`);
}

let building: Promise<void> | null = null;
let failed = false;

/**
 * The native player if it's built. If not, starts building it in the background and
 * returns null, so this sentence plays with afplay rather than waiting on a compile.
 * A failed build isn't retried until the app restarts.
 */
export function readyPlayer(compile: Compile = swiftc, src: string = PLAYER_SRC): string | null {
  if (process.platform !== "darwin") return null;
  let bin: string;
  try {
    bin = playerBin(src);
  } catch {
    return null;
  }
  if (existsSync(bin)) return bin;
  if (!building && !failed) {
    const partial = `${bin}.${process.pid}.building`;
    building = mkdir(dirname(bin), { recursive: true })
      .then(() => compile(src, partial))
      .then(() => {
        renameSync(partial, bin);
        // Older builds of the player are no longer used.
        for (const old of readdirSync(dirname(bin))) {
          if (old.startsWith("cos-play-") && join(dirname(bin), old) !== bin && !old.endsWith(".building")) rmSync(join(dirname(bin), old), { force: true });
        }
      })
      .catch(() => {
        failed = true;
        rmSync(partial, { force: true });
      })
      .finally(() => {
        building = null;
      });
  }
  return null;
}

/** Wait for a build in progress (tests, and the voice test command). */
export async function playerBuilt(): Promise<void> {
  await building;
}

/** Forget a failed build so the next call tries again (tests). */
export function resetPlayer(): void {
  building = null;
  failed = false;
}
