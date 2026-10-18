import { promises as fs } from "node:fs";
import path from "node:path";
import type { AssetResult } from "./assets.js";
import { VERSION } from "./version.js";

export interface ManifestEntry {
  /** Source file relative to the site dir. */
  source: string;
  kind: "video" | "image" | "poster";
  hash: string;
  cached: boolean;
  bytesBefore: number;
  bytesAfter: number;
  result: AssetResult;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  outDir: string;
  assets: ManifestEntry[];
}

/**
 * Write `<dir>/<outDirName>/manifest.json`. Entries from earlier runs that this run didn't
 * touch are kept (keyed by hash), so re-running on an already-processed site doesn't lose them.
 */
export async function writeManifest(
  file: string,
  entries: ManifestEntry[],
  outDir: string,
): Promise<Manifest> {
  const byHash = new Map<string, ManifestEntry>();
  try {
    const previous = JSON.parse(await fs.readFile(file, "utf8")) as Manifest;
    for (const e of previous.assets ?? []) byHash.set(e.hash, e);
  } catch {
    // no previous manifest
  }
  for (const e of entries) byHash.set(e.hash, e);
  const manifest: Manifest = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    outDir,
    assets: [...byHash.values()].sort(
      (a, b) => a.source.localeCompare(b.source) || a.hash.localeCompare(b.hash),
    ),
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
