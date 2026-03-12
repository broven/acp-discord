import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

let cached: string | undefined;

export function getVersion(): string {
  if (cached) return cached;
  const dir = dirname(fileURLToPath(import.meta.url));
  // Works from both src/ (dev) and dist/ (published)
  const pkg = JSON.parse(readFileSync(join(dir, "../../package.json"), "utf-8"));
  cached = pkg.version;
  return cached!;
}
