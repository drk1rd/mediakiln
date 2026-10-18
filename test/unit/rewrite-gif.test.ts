import { beforeAll, describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GifResult } from "../../src/assets.js";
import { resolveConfig } from "../../src/config.js";
import { gifToMp4Args, vfrArgs } from "../../src/ffmpeg/gif.js";
import { applyEdits } from "../../src/html.js";
import { rewriteGif } from "../../src/rewrite/gif.js";
import { scanPage } from "../../src/scan.js";
import { silentLogger } from "../../src/util/logger.js";
import { animatedGif, stillGif } from "../helpers/genMedia.js";

const result: GifResult = {
  kind: "gif",
  width: 321,
  height: 241,
  frames: 30,
  duration: 3,
  sourceBytes: 200_000,
  mp4: { path: "video.mp4", bytes: 60_000 },
  poster: { path: "poster.webp", bytes: 5_000, width: 321, height: 241 },
};

let media: { anim: string; still: string };
beforeAll(async () => {
  media = { anim: await animatedGif(), still: await stillGif() };
});

async function rewrite(html: string, opts: { result?: GifResult; config?: object } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mk-gif-"));
  await mkdir(path.join(dir, "img"));
  await copyFile(media.anim, path.join(dir, "img/anim.gif"));
  await copyFile(media.still, path.join(dir, "img/still.gif"));
  await writeFile(path.join(dir, "img/a.jpg"), "x");
  await writeFile(path.join(dir, "index.html"), html);
  const config = resolveConfig(opts.config ?? {});
  const page = await scanPage(path.join(dir, "index.html"), {
    dir,
    base: config.base,
    config,
    logger: silentLogger,
  });
  const edits = page.gifs.flatMap((ref) =>
    rewriteGif(
      html,
      ref,
      { result: opts.result ?? result, baseUrl: `${config.base}_mediakiln/a1b2c3d4e5f6/` },
      config,
    ),
  );
  return { html: applyEdits(html, edits), page };
}

// A non-GIF image first, so the GIF isn't the "first image" (LCP) unless a test wants it.
const LEAD = `<img src="https://example.com/hero.jpg" alt="">`;

describe("GIF → video rewrite", () => {
  it("turns an animated GIF <img> into a looping muted <video>", async () => {
    const { html } = await rewrite(
      `${LEAD}<img src="/img/anim.gif" alt="Spinning logo" class="logo" style="max-width:100%">`,
    );
    expect(html.slice(LEAD.length)).toMatchInlineSnapshot(
      `"<video class="logo" style="max-width:100%" autoplay muted loop playsinline aria-label="Spinning logo" width="321" height="241" poster="/_mediakiln/a1b2c3d4e5f6/poster.webp" preload="none" data-mk-lazy><source src="/_mediakiln/a1b2c3d4e5f6/video.mp4" type="video/mp4"></video>"`,
    );
  });

  it("keeps author dimensions, other attributes verbatim, and drops <img>-only ones", async () => {
    const { html: out } = await rewrite(
      `${LEAD}<img id=g src="img/anim.gif" width=160 height='120' data-x="1" title="T" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="A" />`,
    );
    expect(out).toContain(`<video id=g width=160 height='120' data-x="1" title="T" autoplay`);
    expect(out.slice(LEAD.length)).not.toMatch(
      /loading=|decoding=|referrerpolicy=|alt=|width="321"| \/>/,
    );
    expect(out).toMatch(/<\/video>$/);
  });

  it("maps alt text to aria-label without overriding an existing label", async () => {
    const decorative = await rewrite(`${LEAD}<img src="/img/anim.gif" alt="">`);
    expect(decorative.html).toContain('aria-hidden="true"');
    expect(decorative.html).not.toContain("aria-label");

    const labelled = await rewrite(`${LEAD}<img src="/img/anim.gif" alt="Alt" aria-label="Label">`);
    expect(labelled.html).toContain('aria-label="Label"');
    expect(labelled.html).not.toContain('aria-label="Alt"');

    const quoted = await rewrite(`${LEAD}<img src="/img/anim.gif" alt='Say "hi" & wave'>`);
    expect(quoted.html).toContain('aria-label="Say &quot;hi&quot; &amp; wave"');
  });

  it("data-mk-eager, fetchpriority=high and the first image load right away", async () => {
    for (const html of [
      `${LEAD}<img src="/img/anim.gif" alt="" data-mk-eager>`,
      `${LEAD}<img src="/img/anim.gif" alt="" fetchpriority="high">`,
      `<img src="/img/anim.gif" alt="">`,
    ]) {
      const { html: out } = await rewrite(html);
      expect(out).toContain('preload="auto"');
      expect(out).not.toContain("data-mk-lazy");
      expect(out).not.toContain("data-mk-eager");
      expect(out).not.toContain("fetchpriority");
    }
    const { html: noLazy } = await rewrite(`${LEAD}<img src="/img/anim.gif" alt="">`, {
      config: { images: { lazy: false } },
    });
    expect(noLazy).toContain('preload="auto"');
  });

  it("leaves data-mk-skip, single-frame and missing GIFs as images", async () => {
    const input = [
      `<img src="/img/anim.gif" alt="" data-mk-skip>`,
      `<img src="/img/still.gif" alt="">`,
      `<img src="/img/missing.gif" alt="">`,
      `<picture><img src="/img/anim.gif" alt=""></picture>`,
    ].join("\n");
    const { html, page } = await rewrite(input);
    expect(page.gifs).toEqual([]);
    expect(page.images).toEqual([]);
    expect(html).toBe(input);
  });

  it("is controlled by images.gifToVideo, video.enabled and images.skip", async () => {
    const html = `<img src="/img/anim.gif" alt="">`;
    for (const config of [
      { images: { gifToVideo: false } },
      { video: { enabled: false } },
      { images: { skip: ["**/*.gif"] } },
    ]) {
      const { page } = await rewrite(html, { config });
      expect(page.gifs, JSON.stringify(config)).toEqual([]);
      expect(page.images).toEqual([]);
    }
    expect((await rewrite(html)).page.gifs).toHaveLength(1);
  });

  it("makes no edit when the MP4 didn't beat the GIF", async () => {
    const input = `<img src="/img/anim.gif" alt="x">`;
    const passthrough: GifResult = {
      ...result,
      mp4: undefined,
      poster: undefined,
      passthrough: true,
    };
    expect((await rewrite(input, { result: passthrough })).html).toBe(input);
  });

  it("a re-scan of the output sees an already-processed video, not a GIF", async () => {
    const { html } = await rewrite(`<body><img src="/img/anim.gif" alt="A"></body>`);
    const dir = await mkdtemp(path.join(os.tmpdir(), "mk-gif-"));
    await writeFile(path.join(dir, "index.html"), html);
    const config = resolveConfig({});
    const page = await scanPage(path.join(dir, "index.html"), {
      dir,
      base: config.base,
      config,
      logger: silentLogger,
    });
    expect(page.gifs).toEqual([]);
    expect(page.videos).toEqual([]);
    expect(page.hasProcessedVideo).toBe(true);
  });
});

describe("GIF → MP4 ffmpeg arguments", () => {
  const settings = { crf: 23, preset: "medium" as const, maxHeight: 1080 };

  it("encodes silent H.264 yuv420p with even dimensions and faststart", () => {
    const args = gifToMp4Args("in.gif", "out.mp4", settings, { width: 321, height: 241 });
    const s = args.join(" ");
    expect(s).toContain("-c:v libx264");
    expect(s).toContain("-pix_fmt yuv420p");
    expect(s).toContain("-an");
    expect(s).toContain("-movflags +faststart");
    expect(s).toContain("scale=-2:'min(1080,trunc(ih/2)*2)'");
    expect(args.at(-1)).toBe("out.mp4");
  });

  it("keeps GIF frame timing with the flag the ffmpeg version understands", () => {
    expect(vfrArgs("ffmpeg version 6.0-static https://johnvansickle.com")).toEqual([
      "-fps_mode",
      "vfr",
    ]);
    expect(vfrArgs("ffmpeg version n5.1.2")).toEqual(["-fps_mode", "vfr"]);
    expect(vfrArgs("ffmpeg version 4.4.2-0ubuntu0.22.04.1")).toEqual(["-vsync", "vfr"]);
    expect(vfrArgs("ffmpeg version 5.0.1")).toEqual(["-vsync", "vfr"]);
    expect(vfrArgs("ffmpeg version N-112345-gabcdef")).toEqual(["-fps_mode", "vfr"]);
  });
});
