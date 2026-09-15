/**
 * How much the assistant may do on its own, per capability:
 * - off:  it can't use it at all
 * - ask:  it looks around freely; anything that changes something waits for your OK (default)
 * - auto: it just does it; only the riskiest things still ask, and some things are never allowed
 * Saved in ~/.cos/access.json; `cos access` changes it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cosHome } from "../util/home.js";

export const ACCESS_MODES = ["off", "ask", "auto"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export interface Access {
  terminal: AccessMode;
  agents: AccessMode;
  /** Web pages the model finds or builds an address for: auto opens them, ask waits for an OK, off never opens them. */
  links: AccessMode;
}

export const DEFAULT_ACCESS: Access = { terminal: "ask", agents: "ask", links: "auto" };

export function accessFile(): string {
  return join(cosHome(), "access.json");
}

export function isAccessMode(s: string): s is AccessMode {
  return (ACCESS_MODES as readonly string[]).includes(s);
}

export function readAccess(file: string = accessFile()): Access {
  let saved: Partial<Record<keyof Access, string>> = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* defaults */
  }
  return {
    terminal: saved.terminal && isAccessMode(saved.terminal) ? saved.terminal : DEFAULT_ACCESS.terminal,
    agents: saved.agents && isAccessMode(saved.agents) ? saved.agents : DEFAULT_ACCESS.agents,
    links: saved.links && isAccessMode(saved.links) ? saved.links : DEFAULT_ACCESS.links,
  };
}

export function saveAccess(patch: Partial<Access>, file: string = accessFile()): Access {
  const next = { ...readAccess(file), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}
