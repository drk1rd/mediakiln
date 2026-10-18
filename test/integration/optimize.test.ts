import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
    expect(firstHtml.index.match(/_mediakiln\/runtime\/loader\.[0-9a-f]{8}\.js/g)).toHaveLength(1);
    expect(post().match(/_mediakiln\/runtime\/loader\.[0-9a-f]{8}\.js/g)).toHaveLength(1);
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
      expect(playlist).toMatch(/#EXT-X-MAP:URI="init_\d\.mp4"/);
      expect(playlist).toContain("#EXTINF:1.000000,"); // short first segment
      expect(existsSync(path.join(site.dir, `_mediakiln/${hash}/hls/${v}/seg_000.m4s`))).toBe(true);
    }
    expect(firstHtml.index).toContain(`data-mk-hls="/_mediakiln/${hash}/hls/master.m3u8"`);
    // short clip under both thresholds → MP4 only
    const short = m.assets.find((a) => a.source === "media/short.mp4")!;
    expect(short.result.kind === "video" && short.result.hls).toBeFalsy();
    expect(post()).not.toMatch(/data-mk-no-hls|data-mk-eager/);
  });

  it("copies the runtime with the hls.js license", () => {
    const files = readdirSync(path.join(site.dir, "_mediakiln/runtime")).sort();
    expect(files).toHaveLength(3);
    expect(files[0]).toBe("LICENSE-hls.js.txt");
    expect(files[1]).toMatch(/^hls\.light\.\d+\.\d+\.\d+\.min\.js$/);
    expect(files[2]).toMatch(/^loader\.[0-9a-f]{8}\.js$/);
    // The versioned loader imports the versioned hls.js next to it.
    expect(read(`_mediakiln/runtime/${files[2]}`)).toContain(files[1]!);
    expect(read("_mediakiln/runtime/LICENSE-hls.js.txt")).toContain("Apache License");
  });

  it("writes a manifest", () => {
    const m = manifest();
    expect(m.assets.filter((a) => a.kind === "video")).toHaveLength(5);
    expect(m.assets.every((a) => a.bytesAfter > 0)).toBe(true);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before = readdirSync(path.join(site.dir, "_mediakiln")).sort();
    const manifestBefore = read("_mediakiln/manifest.json");
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
    expect(read("_mediakiln/manifest.json")).toBe(manifestBefore);
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
    // responsive: hero.jpg, small.png (also the <picture> <img>), oriented.jpg;
    // convert: hero.jpg for the <img srcset>
    expect(summary.images.processed).toBe(4);
    expect(summary.videos.processed).toBe(0);
  });

  it("writes every format at every width", () => {
    const m = JSON.parse(read("_mediakiln/manifest.json")) as Manifest;
    const hero = m.assets.find((a) => a.source === "img/hero.jpg" && a.kind === "image")!;
    expect(hero.result.kind).toBe("image");
    if (hero.result.kind !== "image") return;
    expect(hero.result.variants.map((v) => `${v.width}.${v.format}`).sort()).toEqual(
      [480, 768, 1080, 1600, 2400].flatMap((w) => [`${w}.avif`, `${w}.jpeg`, `${w}.webp`]).sort(),
    );
    for (const v of hero.result.variants) {
      expect(existsSync(path.join(site.dir, "_mediakiln", hero.hash, v.path))).toBe(true);
    }
    const small = m.assets.find((a) => a.source === "img/small.png" && a.kind === "image")!;
    expect(small.result.kind === "image" && small.result.fallbackFormat).toBe("png");
  });

  it("applies EXIF orientation", () => {
    expect(html).toContain('alt="Oriented" srcset=');
    expect(html).toMatch(/alt="Oriented"[^>]*width="800" height="1200"/);
  });

  it("first image is eager, later ones lazy", () => {
    const imgs = [...html.matchAll(/<picture>.*?<img ([^>]*)><\/picture>/g)].map((m) => m[1]!);
    expect(imgs).toHaveLength(5);
    expect(imgs[0]).not.toContain("loading=");
    for (const attrs of imgs.slice(1)) expect(attrs).toContain('loading="lazy"');
  });

  it("shrinks image bytes substantially", () => {
    expect(summary.images.bytesAfter).toBeLessThan(summary.images.bytesBefore / 5);
  });

  it("adds modern formats to an existing srcset and <picture>", () => {
    // <img srcset> keeps its own candidates as the fallback; AVIF/WebP mirror the descriptors.
    expect(html).toMatch(
      /<picture><source type="image\/avif" srcset="\/_mediakiln\/[0-9a-f]{12}\/image\.avif 3000w"><source type="image\/webp" srcset="[^"]+ 3000w"><img src="\/img\/hero\.jpg" alt="Already responsive" srcset="\/img\/hero\.jpg 3000w" width="3000" height="2000" loading="lazy" decoding="async"><\/picture>/,
    );
    // an existing <picture> isn't double-wrapped; its <img> becomes responsive
    expect(html).toMatch(
      /<picture><source type="image\/avif" srcset="[^"]+"[^>]*><source type="image\/webp"[^>]*><img src="\/_mediakiln\/[0-9a-f]{12}\/img-768\.png" alt="In picture"/,
    );
    expect(html).not.toContain("<picture><picture>");
  });

  it("leaves unprocessable images untouched and needs no runtime", () => {
    expect(html).toContain('<img src="/img/missing.jpg" alt="Missing">');
    expect(html).not.toContain("loader.");
  });
});

describe("cache", () => {
  const sites: Array<Awaited<ReturnType<typeof makeSite>>> = [];
  afterAll(() => sites.forEach((s) => s.cleanup()));

  it("a second build of an unchanged site does zero encodes", async () => {
    const a = await makeSite();
    const b = await makeSite();
    sites.push(a, b);
    const cacheDir = path.join(a.root, "cache");
    const opts = { configFile: false as const, cacheDir, video: FAST, logger: silentLogger };

    const t1 = Date.now();
    const cold = await optimize({ ...opts, dir: a.dir });
    const coldMs = Date.now() - t1;
    expect(cold.failures).toEqual([]);
    expect(cold.videos.processed).toBeGreaterThan(0);
    expect(cold.images.processed).toBeGreaterThan(0);
    expect(existsSync(cacheDir)).toBe(true);

    // Fresh copy of the raw site (as in CI): everything comes from the cache.
    const t2 = Date.now();
    const warm = await optimize({ ...opts, dir: b.dir });
    const warmMs = Date.now() - t2;
    expect(warm.failures).toEqual([]);
    expect(warm.videos.processed).toBe(0);
    expect(warm.images.processed).toBe(0);
    expect(warm.videos.cached).toBe(cold.videos.processed);
    expect(warm.images.cached).toBe(cold.images.processed);
    expect(warmMs).toBeLessThan(coldMs);
    expect(warm.videos.bytesAfter).toBe(cold.videos.bytesAfter);

    const html = (d: string) => readFileSync(path.join(d, "index.html"), "utf8");
    expect(html(b.dir)).toBe(html(a.dir));
  });

  it("--no-cache writes no cache directory", async () => {
    const c = await makeSite();
    sites.push(c);
    const cacheDir = path.join(c.root, "nocache");
    await optimize({
      dir: c.dir,
      configFile: false,
      cache: false,
      cacheDir,
      video: { enabled: false },
      logger: silentLogger,
    });
    expect(existsSync(cacheDir)).toBe(false);
  });
});

describe("dry run", () => {
  it("reports what would change and writes nothing", async () => {
    const site = await makeSite();
    try {
      const snapshot = () =>
        readdirSync(site.dir, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => {
            const p = path.join(e.parentPath, e.name);
            return `${path.relative(site.dir, p)}:${readFileSync(p).length}`;
          })
          .sort();
      const before = snapshot();
      const html = readFileSync(path.join(site.dir, "index.html"), "utf8");
      const s = await optimize({
        dir: site.dir,
        configFile: false,
        dryRun: true,
        cacheDir: path.join(site.root, "c"),
        logger: silentLogger,
      });
      expect(s.dryRun).toBe(true);
      expect(s.videos.processed).toBe(5);
      expect(s.images.processed).toBe(5); // 3 images + 1 srcset conversion + 1 author poster
      expect(s.pages.rewritten).toBe(2);
      expect(s.videos.bytesBefore).toBeGreaterThan(0);
      expect(snapshot()).toEqual(before);
      expect(readFileSync(path.join(site.dir, "index.html"), "utf8")).toBe(html);
      expect(existsSync(path.join(site.root, "c"))).toBe(false);
    } finally {
      site.cleanup();
    }
  });
});

describe("captions and thumbnails", () => {
  it("adds local <track> captions to the HLS stream and a thumbnail track", async () => {
    const site = await makeSite();
    try {
      writeFileSync(
        path.join(site.dir, "subs-en.vtt"),
        "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n",
      );
      writeFileSync(
        path.join(site.dir, "cc.html"),
        `<video controls src="/media/long.mp4">\n  <track kind="captions" src="/subs-en.vtt" srclang="en" label="English" default>\n  <track kind="chapters" src="/subs-en.vtt">\n</video>`,
      );
      const s = await optimize({
        dir: site.dir,
        configFile: false,
        cache: false,
        include: ["cc.html"],
        images: { enabled: false },
        video: { ...FAST, thumbnails: { enabled: true } },
        logger: silentLogger,
      });
      expect(s.failures).toEqual([]);
      const html = readFileSync(path.join(site.dir, "cc.html"), "utf8");
      const master = /data-mk-hls="\/(_mediakiln\/[0-9a-f]{12}\/master\.m3u8)"/.exec(html)?.[1];
      expect(master).toBeDefined();
      expect(html).toContain(
        '<track kind="captions" src="/subs-en.vtt" srclang="en" label="English" default data-mk-in-hls>',
      );
      expect(html).toContain('<track kind="chapters" src="/subs-en.vtt">'); // not a subtitle kind
      expect(html).toMatch(
        /data-mk-thumbnails="\/_mediakiln\/[0-9a-f]{12}\/thumbnails\/thumbnails\.vtt"/,
      );

      const text = readFileSync(path.join(site.dir, master!), "utf8");
      expect(text).toContain(
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES',
      );
      expect(text.match(/SUBTITLES="subs"/g)).toHaveLength(3);
      // variant URIs point back into the video's folder and exist
      const dirOf = path.dirname(path.join(site.dir, master!));
      for (const uri of text
        .split("\n")
        .filter((l) => l.endsWith("index.m3u8") && !l.startsWith("#"))) {
        expect(existsSync(path.resolve(dirOf, uri)), uri).toBe(true);
      }
      const vtt = readFileSync(path.join(dirOf, "subs/0/subs.vtt"), "utf8");
      expect(vtt.split("\n").slice(0, 2)).toEqual([
        "WEBVTT",
        "X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000",
      ]);

      // idempotent
      const again = await optimize({
        dir: site.dir,
        configFile: false,
        cache: false,
        include: ["cc.html"],
        images: { enabled: false },
        video: { ...FAST, thumbnails: { enabled: true } },
        logger: silentLogger,
      });
      expect(again.pages.rewritten).toBe(0);
    } finally {
      site.cleanup();
    }
  });
});
