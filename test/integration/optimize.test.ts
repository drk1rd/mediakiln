import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { optimize, type Summary } from "../../src/index.js";
import type { Manifest } from "../../src/manifest.js";
import { silentLogger } from "../../src/util/logger.js";
import { isFaststart, topLevelAtoms } from "../helpers/atoms.js";
import { makeSite } from "../helpers/site.js";

const FAST = { mp4: { preset: "ultrafast" as const } };

describe("optimize() on the fixture site", () => {
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
