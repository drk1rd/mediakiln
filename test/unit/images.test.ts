import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ImageResult } from "../../src/assets.js";
import { resolveConfig } from "../../src/config.js";
import { applyEdits } from "../../src/html.js";
import { fallbackFormat, selectWidths } from "../../src/images/process.js";
import { pickFallbackWidth, rewriteImage } from "../../src/rewrite/image.js";
import { scanPage } from "../../src/scan.js";
import { silentLogger } from "../../src/util/logger.js";

describe("image helpers", () => {
  it("selectWidths keeps configured widths that fit, or the original", () => {
    expect(selectWidths([480, 768, 1080, 1600, 2400], 3000)).toEqual([480, 768, 1080, 1600, 2400]);
    expect(selectWidths([1600, 480, 1080], 1200)).toEqual([480, 1080]);
    expect(selectWidths([480, 768], 300)).toEqual([300]);
    expect(selectWidths([480], 480)).toEqual([480]);
  });

  it("fallbackFormat", () => {
    expect(fallbackFormat("jpeg", false)).toBe("jpeg");
    expect(fallbackFormat("png", false)).toBe("png");
    expect(fallbackFormat("webp", true)).toBe("png");
    expect(fallbackFormat("tiff", false)).toBe("jpeg");
  });

  it("pickFallbackWidth prefers the largest width up to 1080", () => {
    expect(pickFallbackWidth([480, 768, 1080, 1600])).toBe(1080);
    expect(pickFallbackWidth([480, 768, 1600])).toBe(768);
    expect(pickFallbackWidth([1600, 2400])).toBe(1600);
    expect(pickFallbackWidth([300])).toBe(300);
  });
});

const result: ImageResult = {
  kind: "image",
  width: 2400,
  height: 1350,
  sourceBytes: 1000,
  fallbackFormat: "jpeg",
  variants: [480, 1080].flatMap((w) =>
    (["avif", "webp", "jpeg"] as const).map((format) => ({
      format,
      width: w,
      bytes: 1,
      path: `img-${w}.${format === "jpeg" ? "jpg" : format}`,
    })),
  ),
};

async function rewrite(html: string, config: object = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mk-img-"));
  await mkdir(path.join(dir, "img"));
  for (const f of ["a.jpg", "b.png", "c.svg", "d.gif", "skip/e.jpg"]) {
    await mkdir(path.dirname(path.join(dir, "img", f)), { recursive: true });
    await writeFile(path.join(dir, "img", f), "x");
  }
  await writeFile(path.join(dir, "index.html"), html);
  const cfg = resolveConfig(config);
  const page = await scanPage(path.join(dir, "index.html"), {
    dir,
    base: cfg.base,
    config: cfg,
    logger: silentLogger,
  });
  const edits = page.images.flatMap((ref) =>
    rewriteImage(html, ref, { result, baseUrl: `${cfg.base}_mediakiln/9f8e7d6c5b4a/` }, cfg),
  );
  return { html: applyEdits(html, edits), page };
}

describe("image rewrite", () => {
  it("wraps the spec example in <picture> (first image is not lazy)", async () => {
    const { html } = await rewrite(`<img src="/img/a.jpg" alt="Hero">`);
    expect(html).toMatchInlineSnapshot(
      `"<picture><source type="image/avif" srcset="/_mediakiln/9f8e7d6c5b4a/img-480.avif 480w, /_mediakiln/9f8e7d6c5b4a/img-1080.avif 1080w" sizes="100vw"><source type="image/webp" srcset="/_mediakiln/9f8e7d6c5b4a/img-480.webp 480w, /_mediakiln/9f8e7d6c5b4a/img-1080.webp 1080w" sizes="100vw"><img src="/_mediakiln/9f8e7d6c5b4a/img-1080.jpg" alt="Hero" srcset="/_mediakiln/9f8e7d6c5b4a/img-480.jpg 480w, /_mediakiln/9f8e7d6c5b4a/img-1080.jpg 1080w" sizes="100vw" width="2400" height="1350" decoding="async"></picture>"`,
    );
  });

  it("lazy-loads later images, keeps class/style on <img>", async () => {
    const { html } = await rewrite(
      `<img src="/img/a.jpg" alt="1"><p>x</p><img class=photo style="float:left" src="img/b.png" alt="2">`,
    );
    const second = html.slice(html.indexOf("<p>x</p>"));
    expect(second).toMatch(/^<p>x<\/p><picture><source /);
    expect(second).toContain(
      `<img class=photo style="float:left" src="/_mediakiln/9f8e7d6c5b4a/img-1080.jpg" alt="2"`,
    );
    expect(second).toContain('loading="lazy" decoding="async"></picture>');
    expect(html.indexOf('loading="lazy"')).toBe(html.lastIndexOf('loading="lazy"'));
  });

  it("the LCP heuristic counts the first <img> even when it is skipped", async () => {
    const { page } = await rewrite(`<img src="https://x/a.jpg"><img src="/img/a.jpg">`);
    expect(page.images[0]?.first).toBe(false);
  });

  it("data-mk-eager and fetchpriority=high are never lazy", async () => {
    const { html } = await rewrite(
      `<img src="/img/a.jpg"><img data-mk-eager src="/img/a.jpg"><img fetchpriority="high" src="/img/a.jpg">`,
    );
    expect(html).not.toContain('loading="lazy"');
    expect(html).not.toContain("data-mk-eager");
    expect(html).toContain('fetchpriority="high"');
  });

  it("sizes: data-mk-sizes > existing sizes > config default", async () => {
    const { html } = await rewrite(
      `<img src="/img/a.jpg" data-mk-sizes="50vw"><img src="/img/a.jpg" sizes="33vw"><img src="/img/a.jpg">`,
      { images: { sizes: "(min-width: 60em) 60em, 100vw" } },
    );
    expect(html.match(/sizes="50vw"/g)).toHaveLength(3);
    expect(html.match(/sizes="33vw"/g)).toHaveLength(3);
    expect(html.match(/sizes="\(min-width: 60em\) 60em, 100vw"/g)).toHaveLength(3);
    expect(html).not.toContain("data-mk-sizes");
  });

  it("keeps author width/height and loading", async () => {
    const { html } = await rewrite(
      `<img src="/img/a.jpg"><img src="/img/a.jpg" width="300" loading="eager">`,
    );
    const second = html.slice(html.lastIndexOf("<img "));
    expect(second).toContain('width="300"');
    expect(second).not.toContain("height=");
    expect(second).not.toContain('loading="lazy"');
  });

  it("skips srcset, <picture>, svg/gif, skip globs, data-mk-skip and external images", async () => {
    const { page, html } = await rewrite(
      [
        `<img src="/img/a.jpg" srcset="/img/a.jpg 2x">`,
        `<picture><img src="/img/a.jpg"></picture>`,
        `<img src="/img/c.svg">`,
        `<img src="/img/d.gif">`,
        `<img src="/img/skip/e.jpg">`,
        `<img data-mk-skip src="/img/a.jpg">`,
        `<img src="https://cdn.example.com/a.jpg">`,
        `<img src="/img/missing.jpg">`,
        `<img>`,
      ].join("\n"),
      { images: { skip: ["**/*.svg", "**/*.gif", "img/skip/**"] } },
    );
    expect(page.images).toHaveLength(0);
    expect(html).toContain("data-mk-skip");
  });

  it("is idempotent", async () => {
    const first = await rewrite(`<p><img src="/img/a.jpg" alt="x"></p>`);
    const second = await rewrite(first.html);
    expect(second.page.images).toHaveLength(0);
    expect(second.html).toBe(first.html);
  });

  it("uses base in URLs and handles self-closing tags", async () => {
    const { html } = await rewrite(`<img src="/blog/img/a.jpg" alt="x" />`, { base: "/blog/" });
    expect(html).toContain('src="/blog/_mediakiln/9f8e7d6c5b4a/img-1080.jpg"');
    expect(html).toMatch(/decoding="async" \/><\/picture>$/);
  });

  it("png fallback", async () => {
    const png: ImageResult = {
      ...result,
      fallbackFormat: "png",
      variants: result.variants.map((v) =>
        v.format === "jpeg" ? { ...v, format: "png", path: v.path.replace(".jpg", ".png") } : v,
      ),
    };
    const cfg = resolveConfig({});
    const { page } = await rewrite(`<img src="/img/b.png">`);
    const out = applyEdits(
      `<img src="/img/b.png">`,
      rewriteImage(`<img src="/img/b.png">`, page.images[0]!, { result: png, baseUrl: "/x/" }, cfg),
    );
    expect(out).toContain('<img src="/x/img-1080.png"');
    expect(out).not.toContain("image/png");
  });
});
