import { promises as fs } from "node:fs";
import path from "node:path";
import type { AssetResult } from "./assets.js";
import { VERSION } from "./version.js";

export interface ManifestEntry {
  /** Source file relative to the site dir. */
  source: string;
  kind: "video" | "image" | "poster" | "captions" | "css" | "og";
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
 * When nothing but timestamps and cache hits changed, the file is left alone so re-runs are
 * byte-for-byte idempotent.
 */
export async function writeManifest(
  file: string,
  entries: ManifestEntry[],
  outDir: string,
): Promise<Manifest> {
  const byHash = new Map<string, ManifestEntry>();
  let previous: Manifest | undefined;
  try {
    previous = JSON.parse(await fs.readFile(file, "utf8")) as Manifest;
    for (const e of previous.assets ?? []) byHash.set(e.hash, e);
  } catch {
    // no previous manifest
  }
  for (const e of entries) {
    const old = byHash.get(e.hash);
    // A cache hit for an asset the manifest already describes is not news.
    byHash.set(e.hash, old && e.cached ? { ...e, cached: old.cached } : e);
  }
  const manifest: Manifest = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    outDir,
    assets: [...byHash.values()].sort(
      (a, b) => a.source.localeCompare(b.source) || a.hash.localeCompare(b.hash),
    ),
  };
  if (
    previous &&
    previous.version === manifest.version &&
    previous.outDir === manifest.outDir &&
    JSON.stringify(previous.assets) === JSON.stringify(manifest.assets)
  ) {
    return previous;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
