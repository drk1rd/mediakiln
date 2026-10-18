import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MEDIAKILN_CACHE_VERSION,
  imageSettingsFor,
  videoSettingsFor,
  type AssetJob,
  type PosterResult,
} from "../../src/assets.js";
import { assetKey, materialize } from "../../src/cache.js";
import { resolveConfig } from "../../src/config.js";

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), "mk-cache-"));
}

describe("assetKey", () => {
  it("is stable for identical input and settings", async () => {
    const dir = await tmp();
    const file = path.join(dir, "a.mp4");
    await writeFile(file, "same bytes");
    const job: AssetJob = {
      kind: "video",
      file,
      settings: videoSettingsFor(resolveConfig({}), { noHls: false }),
    };
    const a = await assetKey(job);
    const b = await assetKey({
      ...job,
      settings: videoSettingsFor(resolveConfig({}), { noHls: false }),
    });
    expect(a).toEqual(b);
    expect(a.hash).toBe(a.key.slice(0, 12));
    expect(a.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with settings, content and kind, but not file path", async () => {
    const dir = await tmp();
    const file = path.join(dir, "a.jpg");
    const copy = path.join(dir, "b.jpg");
    await writeFile(file, "pixels");
    await writeFile(copy, "pixels");
    const settings = imageSettingsFor(resolveConfig({}));
    const base = (await assetKey({ kind: "image", file, settings })).key;
    expect((await assetKey({ kind: "image", file: copy, settings })).key).toBe(base);
    const q = imageSettingsFor(resolveConfig({ images: { quality: { avif: 60 } } }));
    expect((await assetKey({ kind: "image", file, settings: q })).key).not.toBe(base);
    const noHls = videoSettingsFor(resolveConfig({}), { noHls: true });
    const hls = videoSettingsFor(resolveConfig({}), { noHls: false });
    expect((await assetKey({ kind: "video", file, settings: noHls })).key).not.toBe(
      (await assetKey({ kind: "video", file, settings: hls })).key,
    );
    await writeFile(file, "pixels!");
    expect((await assetKey({ kind: "image", file, settings })).key).not.toBe(base);
  });
});

describe("materialize", () => {
  const result: PosterResult = {
    kind: "poster",
    width: 1,
    height: 1,
    sourceBytes: 1,
    file: { path: "p.webp", bytes: 1 },
  };

  it("builds once, then serves from the site folder and the shared cache", async () => {
    const root = await tmp();
    const cacheDir = path.join(root, "cache");
    const opts = {
      outRoot: path.join(root, "siteA/_mediakiln"),
      cacheDir,
      key: "k".repeat(64),
      hash: "kkkkkkkkkkkk",
      source: "x",
    };
    let builds = 0;
    const build = async (dir: string) => {
      builds++;
      await writeFile(path.join(dir, "p.webp"), "data");
      return result;
    };
    expect((await materialize(opts, build)).origin).toBe("built");
    expect((await materialize(opts, build)).origin).toBe("site");
    const other = await materialize(
      { ...opts, outRoot: path.join(root, "siteB/_mediakiln") },
      build,
    );
    expect(other.origin).toBe("cache");
    expect(builds).toBe(1);
    expect(await readFile(path.join(other.outDir, "p.webp"), "utf8")).toBe("data");
    const meta = JSON.parse(await readFile(path.join(cacheDir, opts.key, "meta.json"), "utf8"));
    expect(meta.cacheVersion).toBe(MEDIAKILN_CACHE_VERSION);
  });

  it("leaves nothing behind when a build fails midway", async () => {
    const root = await tmp();
    const outRoot = path.join(root, "_mediakiln");
    const cacheDir = path.join(root, "cache");
    await expect(
      materialize(
        { outRoot, cacheDir, key: "f".repeat(64), hash: "ffffffffffff", source: "x" },
        async (dir) => {
          await writeFile(path.join(dir, "half.mp4"), "partial");
          throw new Error("ffmpeg crashed");
        },
      ),
    ).rejects.toThrow("ffmpeg crashed");
    expect(existsSync(outRoot) ? readdirSync(outRoot) : []).toEqual([]);
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
  });

  it("rebuilds when meta.json has a different key or cache version", async () => {
    const root = await tmp();
    const opts = {
      outRoot: path.join(root, "_mediakiln"),
      key: "a".repeat(64),
      hash: "aaaaaaaaaaaa",
      source: "x",
    };
    await materialize(opts, async () => result);
    const metaFile = path.join(opts.outRoot, opts.hash, "meta.json");
    const meta = JSON.parse(await readFile(metaFile, "utf8"));
    await writeFile(metaFile, JSON.stringify({ ...meta, cacheVersion: "0" }));
    expect((await materialize(opts, async () => result)).origin).toBe("built");
  });
});
