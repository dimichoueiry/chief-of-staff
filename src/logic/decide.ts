/** Answer a keep / park / kill question. Shared by the CLI and the UI. */
import { Ledger } from "../core/ledger.js";

export type Choice = "keep" | "park" | "kill";
export const CHOICES: readonly Choice[] = ["keep", "park", "kill"];

export function isChoice(s: string): s is Choice {
  return (CHOICES as readonly string[]).includes(s);
}

export async function decide(
  ledger: Ledger,
  project: string,
  choice: Choice,
  today: string,
): Promise<{ project: string; status: string; message: string }> {
  const p = await ledger.find(project);
  if (!p) throw new Error(`No project matches "${project}".`);
  if (choice === "keep") {
    await ledger.writeProject(p.name, { status: "active", lastTouched: today }, `cos: keep "${p.name}"`);
    return {
      project: p.name,
      status: "active",
      message: `Keeping ${p.name}. Last touched reset to today; it will resurface if it goes quiet again.`,
    };
  }
  const status = choice === "park" ? "parked" : "killed";
  await ledger.writeProject(p.name, { status, lastTouched: today }, `cos: ${choice} "${p.name}"`);
  return {
    project: p.name,
    status,
    message: `${p.name} → ${status}.${choice === "park" ? " It comes back for review in a month." : ""}`,
  };
}
