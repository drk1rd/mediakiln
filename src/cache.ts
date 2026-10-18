import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import {
  MEDIAKILN_CACHE_VERSION,
  type AssetJob,
  type AssetMeta,
  type AssetResult,
} from "./assets.js";
import { commitDir, exists, linkOrCopyDir, tempSibling } from "./util/fs.js";
import type { RemoteCache } from "./remoteCache.js";

export const META_FILE = "meta.json";

/** sha256(fileBytes + JSON(settings) + cache version). Streams the file. */
export async function assetKey(job: AssetJob): Promise<{ key: string; hash: string }> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(job.file);
    stream.on("data", (chunk) => h.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  h.update("\0" + job.kind + "\0" + JSON.stringify(job.settings) + "\0" + MEDIAKILN_CACHE_VERSION);
  const key = h.digest("hex");
  return { key, hash: key.slice(0, 12) };
}

async function readMeta(dir: string, key: string): Promise<AssetMeta | undefined> {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, META_FILE), "utf8")) as AssetMeta;
    return meta.key === key && meta.cacheVersion === MEDIAKILN_CACHE_VERSION ? meta : undefined;
  } catch {
    return undefined;
  }
}

export interface MaterializeOptions {
  /** Absolute `<dir>/<outDirName>`. */
  outRoot: string;
  /** Absolute cache dir, or undefined when the cache is disabled. */
  cacheDir?: string;
  /** Shared S3-compatible cache, consulted after the local one. */
  remote?: RemoteCache;
  key: string;
  hash: string;
  source: string;
}

export interface Materialized<R extends AssetResult> {
  meta: AssetMeta<R>;
  outDir: string;
  /** Where the output came from: already in the site, a cache (local or remote), or built. */
  origin: "site" | "cache" | "remote" | "built";
}

/**
 * Make sure `<outRoot>/<hash>/` holds this asset's outputs. Reuses an existing folder in the
 * site, then the shared cache; otherwise runs `build` in a temp folder and renames it into
 * place atomically, so an interrupted encode never leaves a half-written entry behind.
 */
export async function materialize<R extends AssetResult>(
  opts: MaterializeOptions,
  build: (tmpDir: string) => Promise<R>,
): Promise<Materialized<R>> {
  const outDir = path.join(opts.outRoot, opts.hash);

  const inSite = await readMeta(outDir, opts.key);
  if (inSite) {
    if (opts.cacheDir) await storeInCache(outDir, path.join(opts.cacheDir, opts.key));
    await seedRemote(opts, outDir);
    return { meta: inSite as AssetMeta<R>, outDir, origin: "site" };
  }
  if (await exists(outDir)) await fs.rm(outDir, { recursive: true, force: true });

  if (opts.cacheDir) {
    const entry = path.join(opts.cacheDir, opts.key);
    const cached = await readMeta(entry, opts.key);
    if (cached) {
      const tmp = tempSibling(outDir);
      await linkOrCopyDir(entry, tmp);
      await commitDir(tmp, outDir);
      await seedRemote(opts, outDir);
      return { meta: cached as AssetMeta<R>, outDir, origin: "cache" };
    }
  }

  if (opts.remote) {
    const tmp = tempSibling(outDir);
    try {
      if (await opts.remote.get(opts.key, tmp)) {
        const meta = await readMeta(tmp, opts.key);
        if (meta) {
          await commitDir(tmp, outDir);
          if (opts.cacheDir) await storeInCache(outDir, path.join(opts.cacheDir, opts.key));
          return { meta: meta as AssetMeta<R>, outDir, origin: "remote" };
        }
      }
    } catch {
      // A flaky remote must never fail the build; fall through to encoding locally.
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const tmp = tempSibling(outDir);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const result = await build(tmp);
    const meta: AssetMeta<R> = {
      key: opts.key,
      hash: opts.hash,
      cacheVersion: MEDIAKILN_CACHE_VERSION,
      source: opts.source,
      result,
    };
    await fs.writeFile(path.join(tmp, META_FILE), JSON.stringify(meta, null, 2));
    await commitDir(tmp, outDir);
    if (opts.cacheDir) await storeInCache(outDir, path.join(opts.cacheDir, opts.key));
    if (opts.remote?.write) await upload(opts.remote, opts.key, outDir);
    return { meta, outDir, origin: "built" };
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** Upload entries that exist locally but not remotely (e.g. built before the remote was set up). */
async function seedRemote(opts: MaterializeOptions, outDir: string): Promise<void> {
  if (!opts.remote?.write) return;
  try {
    if (!(await opts.remote.has(opts.key))) await upload(opts.remote, opts.key, outDir);
  } catch {
    // best effort
  }
}

async function upload(remote: RemoteCache, key: string, dir: string): Promise<void> {
  try {
    await remote.put(key, dir);
  } catch {
    // The remote cache is an optimization; a failed upload just means another encode later.
  }
}

async function storeInCache(outDir: string, entry: string): Promise<void> {
  if (await exists(path.join(entry, META_FILE))) return;
  const tmp = tempSibling(entry);
  try {
    await linkOrCopyDir(outDir, tmp);
    await commitDir(tmp, entry);
  } catch {
    // The cache is an optimization; never fail a build because it couldn't be written.
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
