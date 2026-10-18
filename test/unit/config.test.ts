import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  ConfigError,
  deepMerge,
  findUnknownKeys,
  loadConfigFile,
  normalizeBase,
  resolveConfig,
} from "../../src/config.js";
import { createLogger } from "../../src/util/logger.js";
import { flagsToOverrides } from "../../src/cliFlags.js";

describe("resolveConfig", () => {
  it("returns defaults for empty input", () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("deep-merges nested values and replaces arrays", () => {
    const c = resolveConfig({
      video: {
        hls: { minDurationSec: 30, renditions: [{ height: 480, videoKbps: 1200, audioKbps: 96 }] },
      },
      images: { widths: [640] },
    });
    expect(c.video.hls.minDurationSec).toBe(30);
    expect(c.video.hls.segmentSec).toBe(4);
    expect(c.video.hls.renditions).toHaveLength(1);
    expect(c.images.widths).toEqual([640]);
    expect(c.images.formats).toEqual(["avif", "webp"]);
  });

  it("warns on unknown keys instead of failing", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (l) => lines.push(l) });
    const c = resolveConfig({ bogus: 1, video: { nope: true } }, logger);
    expect(c.video.enabled).toBe(true);
    expect(lines.join("\n")).toContain('"bogus"');
    expect(lines.join("\n")).toContain('"video.nope"');
  });

  it("rejects invalid values", () => {
    expect(() => resolveConfig({ video: { mp4: { reencode: "sometimes" } } })).toThrow(ConfigError);
    expect(() => resolveConfig({ images: { widths: [] } })).toThrow(/images.widths/);
    expect(() => resolveConfig({ outDirName: "a/b" })).toThrow(ConfigError);
    expect(() => resolveConfig("nope")).toThrow(ConfigError);
  });

  it("normalizes base", () => {
    expect(normalizeBase("")).toBe("/");
    expect(normalizeBase("blog")).toBe("/blog/");
    expect(normalizeBase("/blog")).toBe("/blog/");
    expect(resolveConfig({ base: "docs/" }).base).toBe("/docs/");
  });
});

describe("helpers", () => {
  it("deepMerge leaves base untouched", () => {
    const base = { a: { b: 1, c: [1] } };
    const out = deepMerge(base, { a: { b: 2 } });
    expect(out).toEqual({ a: { b: 2, c: [1] } });
    expect(base.a.b).toBe(1);
  });

  it("findUnknownKeys reports dotted paths", () => {
    expect(findUnknownKeys({ a: 1, x: { y: 1, z: 2 } }, { a: 0, x: { y: 0 } })).toEqual(["x.z"]);
  });
});

describe("loadConfigFile", () => {
  it("discovers mediakiln.config.json and mjs in cwd", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mk-config-"));
    expect(await loadConfigFile(undefined, dir)).toBeUndefined();
    await writeFile(path.join(dir, "mediakiln.config.mjs"), "export default { base: '/x/' };");
    const loaded = await loadConfigFile(undefined, dir);
    expect(loaded?.config).toEqual({ base: "/x/" });
    await writeFile(path.join(dir, "other.json"), '{"keepOriginals": false}');
    expect((await loadConfigFile("other.json", dir))?.config).toEqual({ keepOriginals: false });
  });

  it("throws for an explicit missing file", async () => {
    await expect(loadConfigFile("missing.json", os.tmpdir())).rejects.toThrow(ConfigError);
  });
});

describe("flagsToOverrides", () => {
  it("only sets flags that were passed", () => {
    expect(flagsToOverrides({ cache: true, video: true, images: true, hls: true })).toEqual({});
    expect(
      flagsToOverrides({ base: "/b/", cache: false, hls: false, images: false, concurrency: "2" }),
    ).toEqual({
      base: "/b/",
      cache: false,
      concurrency: 2,
      video: { hls: { enabled: false } },
      images: { enabled: false },
    });
    expect(flagsToOverrides({ video: false, hls: false })).toEqual({
      video: { enabled: false, hls: { enabled: false } },
    });
    expect(() => flagsToOverrides({ concurrency: "0" })).toThrow();
  });
});

describe("logger", () => {
  it("respects level", () => {
    const write = vi.fn();
    const l = createLogger({ level: "warn", write });
    l.info("x");
    l.debug("x");
    l.warn("w");
    expect(write).toHaveBeenCalledTimes(1);
  });
});
