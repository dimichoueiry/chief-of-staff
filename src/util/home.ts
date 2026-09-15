import { homedir } from "node:os";
import { join } from "node:path";

/** Where the app keeps its own state (not your memory): ~/.cos, or COS_HOME. Read on every call so tests can redirect it. */
export function cosHome(): string {
  return process.env.COS_HOME || join(homedir(), ".cos");
}
