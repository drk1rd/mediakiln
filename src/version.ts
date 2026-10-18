import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readVersion(): string {
  // Works from both src/ (tests) and dist/ (built): package.json is one or two levels up.
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require(rel) as { name?: string; version?: string };
      if (pkg.name === "mediakiln" && pkg.version) return pkg.version;
    } catch {
      // keep looking
    }
  }
  return "0.0.0";
}

export const VERSION: string = readVersion();
