import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import type { VideoResult } from "../../src/assets.js";
import { resolveConfig } from "../../src/config.js";
import { applyEdits } from "../../src/html.js";
import { rewriteVideo } from "../../src/rewrite/video.js";
import { injectRuntime } from "../../src/rewrite/inject.js";
import { scanPage } from "../../src/scan.js";
import { silentLogger } from "../../src/util/logger.js";

const result: VideoResult = {
  kind: "video",
  width: 1920,
  height: 1080,
  duration: 20,
  hasAudio: true,
  sourceBytes: 1000,
  mp4: { path: "video.mp4", bytes: 500, mode: "remux" },
  poster: { path: "poster.webp", bytes: 10, width: 1920, height: 1080 },
};
const hlsResult: VideoResult = {
  ...result,
  hls: { master: "hls/master.m3u8", variants: [], bytes: 0 },
};

async function rewrite(html: string, opts: { result?: VideoResult; config?: object } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mk-rw-"));
  await mkdir(path.join(dir, "media"));
  await writeFile(path.join(dir, "media/a.mp4"), "x");
  await writeFile(path.join(dir, "media/a.webm"), "x");
  await writeFile(path.join(dir, "media/p.jpg"), "x");
  await writeFile(path.join(dir, "index.html"), html);
  const config = resolveConfig(opts.config ?? {});
  const page = await scanPage(path.join(dir, "index.html"), {
    dir,
    base: config.base,
    config,
    logger: silentLogger,
  });
  const edits = page.videos.flatMap((ref) =>
    rewriteVideo(
      html,
      ref,
      { result: opts.result ?? result, baseUrl: `${config.base}_mediakiln/a1b2c3d4e5f6/` },
      config,
    ),
  );
  if (page.videos.length > 0 && !page.hasRuntime) {
    edits.push(injectRuntime(html, page.injectAt, config.base, "_mediakiln/runtime/loader.js"));
  }
  return { html: applyEdits(html, edits), page };
}

describe("video rewrite", () => {
  it("rewrites the spec example (HLS case)", async () => {
    const { html } = await rewrite(`<body><video src="/media/a.mp4" controls></video></body>`, {
      result: hlsResult,
    });
    expect(html).toMatchInlineSnapshot(
      `"<body><video controls preload="none" width="1920" height="1080" poster="/_mediakiln/a1b2c3d4e5f6/poster.webp" data-mk-hls="/_mediakiln/a1b2c3d4e5f6/hls/master.m3u8" data-mk-lazy><source src="/_mediakiln/a1b2c3d4e5f6/video.mp4" type="video/mp4"></video><script type="module" src="/_mediakiln/runtime/loader.js"></script></body>"`,
    );
  });

  it("MP4-only case has no data-mk-hls", async () => {
    const { html } = await rewrite(`<video src="/media/a.mp4" controls></video>`);
    expect(html).not.toContain("data-mk-hls");
    expect(html).toContain('<source src="/_mediakiln/a1b2c3d4e5f6/video.mp4" type="video/mp4">');
  });

  it("preserves attributes exactly and keeps existing dimensions", async () => {
    const { html } = await rewrite(
      `<video id=v1 class='a  b' style="width:100%" aria-label="Demo &amp; more" width=640 height=360 controls src="/media/a.mp4"></video>`,
    );
    expect(html).toContain(
      `<video id=v1 class='a  b' style="width:100%" aria-label="Demo &amp; more" width=640 height=360 controls preload="none" poster=`,
    );
    expect(html).not.toContain('width="1920"');
  });

  it("autoplay gets playsinline and preload=metadata, no lazy", async () => {
    const { html } = await rewrite(`<video autoplay muted loop src="/media/a.mp4"></video>`);
    expect(html).toContain('<video autoplay muted loop playsinline preload="metadata"');
    expect(html).not.toContain("data-mk-lazy");
  });

  it("data-mk-eager disables lazy and is removed", async () => {
    const { html } = await rewrite(
      `<video data-mk-eager controls preload="auto" src="/media/a.mp4"></video>`,
    );
    expect(html).toContain('<video controls preload="metadata" width=');
    expect(html).not.toContain("data-mk-eager");
    expect(html).not.toContain("data-mk-lazy");
  });

  it("replaces local sources, keeps tracks, external sources and fallback text", async () => {
    const input = [
      `<video controls>`,
      `  <source src="/media/a.webm" type="video/webm">`,
      `  <source src="media/a.mp4" type="video/mp4">`,
      `  <source src="https://cdn.example.com/a.mp4" type="video/mp4">`,
      `  <track kind="captions" src="/subs.vtt">`,
      `  Fallback text.`,
      `</video>`,
    ].join("\n");
    const { html } = await rewrite(input);
    expect(html.replace(/<script.*<\/script>/, "")).toMatchInlineSnapshot(`
      "<video controls preload="none" width="1920" height="1080" poster="/_mediakiln/a1b2c3d4e5f6/poster.webp" data-mk-lazy>
        <source src="/_mediakiln/a1b2c3d4e5f6/video.mp4" type="video/mp4">
        <source src="https://cdn.example.com/a.mp4" type="video/mp4">
        <track kind="captions" src="/subs.vtt">
        Fallback text.
      </video>"
    `);
  });

  it("uses an optimized author poster when provided", async () => {
    const dir = "/_mediakiln/ffffffffffff/";
    const html = `<video poster="/media/p.jpg" src="/media/a.mp4"></video>`;
    const { page } = await rewrite(html);
    expect(page.videos[0]?.posterFile).toMatch(/p\.jpg$/);
    const config = resolveConfig({});
    const out = applyEdits(
      html,
      rewriteVideo(
        html,
        page.videos[0]!,
        { result, baseUrl: "/_mediakiln/a1b2c3d4e5f6/", posterUrl: dir + "poster.webp" },
        config,
      ),
    );
    expect(out).toContain(`poster="${dir}poster.webp"`);
  });

  it("keeps a remote poster", async () => {
    const { html } = await rewrite(`<video poster="https://x/p.jpg" src="/media/a.mp4"></video>`);
    expect(html).toContain('poster="https://x/p.jpg"');
    expect(html).not.toContain("poster.webp");
  });

  it("emits base-prefixed URLs", async () => {
    const { html } = await rewrite(`<video src="/blog/media/a.mp4"></video>`, {
      config: { base: "/blog/" },
    });
    expect(html).toContain('src="/blog/_mediakiln/a1b2c3d4e5f6/video.mp4"');
    expect(html).toContain('src="/blog/_mediakiln/runtime/loader.js"');
  });

  it("skips data-mk-skip, external, missing and unsupported videos", async () => {
    const { page } = await rewrite(
      `<video data-mk-skip src="/media/a.mp4"></video>` +
        `<video src="https://x/a.mp4"></video>` +
        `<video src="/media/missing.mp4"></video>` +
        `<video src="/media/p.jpg"></video>` +
        `<video></video>`,
    );
    expect(page.videos).toHaveLength(0);
  });

  it("is idempotent: a rewritten page is left alone", async () => {
    const first = await rewrite(`<body>\n  <video src="/media/a.mp4" controls></video>\n</body>`, {
      result: hlsResult,
    });
    const second = await rewrite(first.html, { result: hlsResult });
    expect(second.page.videos).toHaveLength(0);
    expect(second.page.hasProcessedVideo).toBe(true);
    expect(second.page.hasRuntime).toBe(true);
    expect(second.html).toBe(first.html);
  });

  it("injects the runtime on its own line before an indented </body>", async () => {
    const { html } = await rewrite(
      `<html>\n  <body>\n    <video src="/media/a.mp4"></video>\n  </body>\n</html>`,
    );
    expect(
      html.endsWith(
        `  <script type="module" src="/_mediakiln/runtime/loader.js"></script>\n  </body>\n</html>`,
      ),
    ).toBe(true);
  });
});
