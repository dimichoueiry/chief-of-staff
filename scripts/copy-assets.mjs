// tsc only emits .ts; copy the non-code assets the runtime reads next to the compiled files.
import { cp } from "node:fs/promises";

const assets = [
  ["src/brain/prompts", "dist/brain/prompts"],
  ["src/sensors/eventkit", "dist/sensors/eventkit"],
  ["src/sensors/screen", "dist/sensors/screen"],
  ["src/ui/web", "dist/ui/web"],
];
for (const [from, to] of assets) {
  try {
    await cp(from, to, { recursive: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
