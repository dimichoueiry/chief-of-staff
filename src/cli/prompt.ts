import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, yes = false): Promise<boolean> {
  if (yes) return true;
  if (!stdin.isTTY) throw new Error(`${question} — not a terminal; pass --yes to proceed.`);
  const a = (await ask(`${question} [y/N] `)).toLowerCase();
  return a === "y" || a === "yes";
}
