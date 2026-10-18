import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { optimize, type Summary } from "../../src/index.js";
import type { Manifest } from "../../src/manifest.js";
import { silentLogger } from "../../src/util/logger.js";
import { isFaststart, topLevelAtoms } from "../helpers/atoms.js";
import { makeSite } from "../helpers/site.js";

const FAST = { mp4: { preset: "ultrafast" as const } };

describe("optimize() on the fixture site (video)", () => {
  let site: Awaited<ReturnType<typeof makeSite>>;
  let first: Summary;
  let firstHtml: { index: string; post: string };

  const read = (rel: string) => readFileSync(path.join(site.dir, rel), "utf8");
  const manifest = () => JSON.parse(read("_mediakiln/manifest.json")) as Manifest;
  const outFile = (url: string) => path.join(site.dir, url.replace(/^\//, ""));

  beforeAll(async () => {
    site = await makeSite();
    first = await optimize({
      dir: site.dir,
      configFile: false,
      cache: false,
      images: { enabled: false },
      video: FAST,
      logger: silentLogger,
    });
    firstHtml = { index: read("index.html"), post: read("blog/post.html") };
  });
  afterAll(() => site.cleanup());

  it("processes every referenced video once per distinct setting", () => {
    expect(first.failures).toEqual([]);
    // long (HLS-eligible), long (data-mk-no-hls), short, rotated, webm
    expect(first.videos.processed).toBe(5);
    expect(first.pages.rewritten).toBe(2);
  });

  it("writes faststart MP4s (moov before mdat) and posters", () => {
    const sources = [...firstHtml.index.matchAll(/<source src="([^"]+video\.mp4)"/g)].map(
      (m) => m[1]!,
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) {
      const file = outFile(src);
      expect(isFaststart(file), `${src}: ${topLevelAtoms(file).join(",")}`).toBe(true);
    }
    for (const m of firstHtml.index.matchAll(/poster="([^"]+)"/g)) {
      expect(existsSync(outFile(m[1]!))).toBe(true);
    }
  });

  it("the source fixture really has moov at the end", () => {
    expect(isFaststart(path.join(site.dir, "media/short.mp4"))).toBe(false);
  });

  it("handles rotation, remux and re-encode", () => {
    const m = manifest();
    const rotated = m.assets.find((a) => a.source === "media/rotated.mov")!;
    expect(rotated.result).toMatchObject({ width: 1080, height: 1920, mp4: { mode: "reencode" } });
    const short = m.assets.find((a) => a.source === "media/short.mp4")!;
    expect(short.result).toMatchObject({ mp4: { mode: "remux" }, hasAudio: false });
    const webm = m.assets.find((a) => a.source === "media/clip.webm")!;
    expect(webm.result).toMatchObject({ mp4: { mode: "reencode" }, hasAudio: true });
    expect(post()).toContain('width="1080" height="1920"');
  });

  const post = () => firstHtml.post;

  it("leaves skipped and external videos alone", () => {
    expect(firstHtml.index).toContain(
      '<video controls data-mk-skip src="/media/short.mp4"></video>',
    );
    expect(firstHtml.index).toContain(
      '<video controls src="https://example.com/remote.mp4"></video>',
    );
  });

  it("uses the optimized author poster and keeps tracks", () => {
    expect(post()).toMatch(
      /<video controls poster="\/_mediakiln\/[0-9a-f]{12}\/poster\.webp" id="clip"/,
    );
    expect(post()).toContain('<track kind="captions" src="/subs.vtt" srclang="en">');
    expect(post()).not.toContain("clip.webm");
  });

  it("injects the runtime once per page with videos", () => {
    expect(firstHtml.index.match(/_mediakiln\/runtime\/loader\.js/g)).toHaveLength(1);
    expect(post().match(/_mediakiln\/runtime\/loader\.js/g)).toHaveLength(1);
  });

  it("generates HLS only when warranted", () => {
    const m = manifest();
    const longHls = m.assets.filter(
      (a) => a.source === "media/long.mp4" && a.result.kind === "video" && a.result.hls,
    );
    expect(longHls).toHaveLength(1); // the data-mk-no-hls copy has none
    const hash = longHls[0]!.hash;
    const master = read(`_mediakiln/${hash}/hls/master.m3u8`);
    expect(master.match(/#EXT-X-STREAM-INF/g)).toHaveLength(3);
    expect(master).toContain("RESOLUTION=640x360");
    expect(master).toContain("RESOLUTION=1920x1080");
    for (const v of ["v0", "v1", "v2"]) {
      const playlist = read(`_mediakiln/${hash}/hls/${v}/index.m3u8`);
      expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
      expect(existsSync(path.join(site.dir, `_mediakiln/${hash}/hls/${v}/seg_000.ts`))).toBe(true);
    }
    expect(firstHtml.index).toContain(`data-mk-hls="/_mediakiln/${hash}/hls/master.m3u8"`);
    // short clip under both thresholds → MP4 only
    const short = m.assets.find((a) => a.source === "media/short.mp4")!;
    expect(short.result.kind === "video" && short.result.hls).toBeFalsy();
    expect(post()).not.toMatch(/data-mk-no-hls|data-mk-eager/);
  });

  it("copies the runtime with the hls.js license", () => {
    for (const f of ["loader.js", "hls.light.min.js", "LICENSE-hls.js.txt"]) {
      expect(existsSync(path.join(site.dir, "_mediakiln/runtime", f))).toBe(true);
    }
    expect(read("_mediakiln/runtime/LICENSE-hls.js.txt")).toContain("Apache License");
  });

  it("writes a manifest", () => {
    const m = manifest();
    expect(m.assets.filter((a) => a.kind === "video")).toHaveLength(5);
    expect(m.assets.every((a) => a.bytesAfter > 0)).toBe(true);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before = readdirSync(path.join(site.dir, "_mediakiln")).sort();
    const second = await optimize({
      dir: site.dir,
      configFile: false,
      cache: false,
      images: { enabled: false },
      video: FAST,
      logger: silentLogger,
    });
    expect(second.videos.processed + second.videos.cached).toBe(0);
    expect(second.pages.rewritten).toBe(0);
    expect(read("index.html")).toBe(firstHtml.index);
    expect(read("blog/post.html")).toBe(firstHtml.post);
    expect(readdirSync(path.join(site.dir, "_mediakiln")).sort()).toEqual(before);
    expect(manifest().assets.filter((a) => a.kind === "video")).toHaveLength(5);
  });
});

describe("optimize() on the fixture site (images)", () => {
  let site: Awaited<ReturnType<typeof makeSite>>;
  let summary: Summary;
  let html: string;
  const read = (rel: string) => readFileSync(path.join(site.dir, rel), "utf8");

  beforeAll(async () => {
    site = await makeSite();
    summary = await optimize({
      dir: site.dir,
      configFile: false,
      cache: false,
      video: { enabled: false },
      logger: silentLogger,
    });
    html = read("index.html");
  });
  afterAll(() => site.cleanup());

  it("processes each local raster image once", () => {
    expect(summary.failures).toEqual([]);
    // hero.jpg (twice in HTML, once with srcset → skipped), small.png, oriented.jpg
    expect(summary.images.processed).toBe(3);
    expect(summary.videos.processed).toBe(0);
  });

  it("writes every format at every width", () => {
    const m = JSON.parse(read("_mediakiln/manifest.json")) as Manifest;
    const hero = m.assets.find((a) => a.source === "img/hero.jpg")!;
    expect(hero.result.kind).toBe("image");
    if (hero.result.kind !== "image") return;
    expect(hero.result.variants.map((v) => `${v.width}.${v.format}`).sort()).toEqual(
      [480, 768, 1080, 1600, 2400].flatMap((w) => [`${w}.avif`, `${w}.jpeg`, `${w}.webp`]).sort(),
    );
    for (const v of hero.result.variants) {
      expect(existsSync(path.join(site.dir, "_mediakiln", hero.hash, v.path))).toBe(true);
    }
    const small = m.assets.find((a) => a.source === "img/small.png")!;
    expect(small.result.kind === "image" && small.result.fallbackFormat).toBe("png");
  });

  it("applies EXIF orientation", () => {
    expect(html).toContain('alt="Oriented" srcset=');
    expect(html).toMatch(/alt="Oriented"[^>]*width="800" height="1200"/);
  });

  it("first image is eager, later ones lazy", () => {
    const imgs = [...html.matchAll(/<picture>.*?<img ([^>]*)><\/picture>/g)]
      .map((m) => m[1]!)
      .filter((attrs) => attrs.includes("/_mediakiln/"));
    expect(imgs).toHaveLength(3);
    expect(imgs[0]).not.toContain("loading=");
    expect(imgs[1]).toContain('loading="lazy"');
    expect(imgs[2]).toContain('loading="lazy"');
  });

  it("shrinks image bytes substantially", () => {
    expect(summary.images.bytesAfter).toBeLessThan(summary.images.bytesBefore / 5);
  });

  it("leaves unprocessable images untouched and needs no runtime", () => {
    expect(html).toContain(
      '<img src="/img/hero.jpg" alt="Already responsive" srcset="/img/hero.jpg 3000w">',
    );
    expect(html).toContain('<picture><img src="/img/small.png" alt="In picture"></picture>');
    expect(html).toContain('<img src="/img/missing.jpg" alt="Missing">');
    expect(html).not.toContain("loader.js");
  });
});
