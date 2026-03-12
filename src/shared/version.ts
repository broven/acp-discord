import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

let cached: string | undefined;

export function getVersion(): string {
  if (cached) return cached;
  // Walk up from the current file to find the package's own package.json.
  // Handles both src/shared/version.ts (dev) and dist/index.js (bundled).
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
      if (pkg.name === "acp-discord") {
        cached = pkg.version;
        return cached!;
      }
    }
    dir = dirname(dir);
  }
  return "0.0.0";
}
