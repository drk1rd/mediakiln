import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import sharp from "sharp";
import { optimize } from "../../src/index.js";
import { silentLogger } from "../../src/util/logger.js";
import { generateAll } from "../helpers/genMedia.js";

const TMP = path.resolve(import.meta.dirname, "../.tmp");
let media: Awaited<ReturnType<typeof generateAll>>;
let root: string;

beforeAll(async () => {
  media = await generateAll();
  mkdirSync(TMP, { recursive: true });
  root = mkdtempSync(path.join(TMP, "v11-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function site(name: string) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "img"), { recursive: true });
  mkdirSync(path.join(dir, "css"), { recursive: true });
  cpSync(media.hero, path.join(dir, "img/hero.jpg"));
  cpSync(media.small, path.join(dir, "img/small.png"));
  cpSync(media.oriented, path.join(dir, "img/portrait.jpg"));
  return dir;
}

describe("images beyond <img>", () => {
  let dir: string;
  let html: string;
  let css: string;
  beforeAll(async () => {
    dir = site("images");
    await sharp(media.hero).resize(1200).jpeg().toFile(path.join(dir, "img/hero-1x.jpg"));
    await sharp(media.hero).resize(2400).jpeg().toFile(path.join(dir, "img/hero-2x.jpg"));
    writeFileSync(
      path.join(dir, "css/site.css"),
      `.banner { background: url(../img/hero.jpg) center / cover; }\n.logo { background-image: url("/img/missing.png"); }\n`,
    );
    writeFileSync(
      path.join(dir, "index.html"),
      `<!doctype html>
<html><head>
<meta property="og:image" content="https://example.com/img/hero.jpg">
<meta name="twitter:image" content="/img/small.png">
<link rel="stylesheet" href="/css/site.css">
<style>.card { background-image: url('/img/small.png'); }</style>
</head><body>
<picture>
  <source media="(max-width: 600px)" srcset="/img/portrait.jpg">
  <img src="/img/hero.jpg" alt="Art directed">
</picture>
<img src="/img/hero-1x.jpg" srcset="/img/hero-1x.jpg 1x, /img/hero-2x.jpg 2x" alt="Density">
<div class="x" style="background-image: url(/img/small.png); height: 40px"></div>
</body></html>
`,
    );
    const s = await optimize({
      dir,
      configFile: false,
      cache: false,
      site: "https://example.com/",
      report: true,
      logger: silentLogger,
    });
    expect(s.failures).toEqual([]);
    expect(s.stylesheets).toEqual({ scanned: 1, rewritten: 1 });
    html = readFileSync(path.join(dir, "index.html"), "utf8");
    css = readFileSync(path.join(dir, "css/site.css"), "utf8");
  });

  it("expands art-directed <picture> sources per format, keeping media", () => {
    const pic = /<picture>[\s\S]*?<\/picture>/.exec(html)![0];
    const sources = [...pic.matchAll(/<source [^>]*>/g)].map((m) => m[0]);
    // portrait: avif + fallback (its WebP lost to the JPEG and was dropped), both with media;
    // then the <img>'s avif/webp
    expect(sources).toHaveLength(4);
    for (const s of sources.slice(0, 2)) expect(s).toContain('media="(max-width: 600px)"');
    expect(sources[0]).toContain('type="image/avif"');
    expect(sources[1]).not.toContain("type=");
    expect(sources[1]).toMatch(/srcset="\/_mediakiln\/[0-9a-f]{12}\/img-480\.jpg 480w, [^"]+768w"/);
    expect(sources[0]).toContain('width="800" height="1200"');
    expect(sources[2]).not.toContain("media=");
    expect(sources[3]).toContain('type="image/webp"');
    expect(pic).toMatch(/<img src="\/_mediakiln\/[0-9a-f]{12}\/img-1080\.jpg" alt="Art directed"/);
  });

  it("adds converted sources for an x-descriptor srcset", () => {
    expect(html).toMatch(
      /<picture><source type="image\/avif" srcset="\/_mediakiln\/[0-9a-f]{12}\/image\.avif 1x, \/_mediakiln\/[0-9a-f]{12}\/image\.avif 2x">/,
    );
    expect(html).toContain(
      'srcset="/img/hero-1x.jpg 1x, /img/hero-2x.jpg 2x" alt="Density" width="1200" height="800"',
    );
  });

  it("rewrites og:image to an absolute 1200px JPEG with dimensions", () => {
    expect(html).toMatch(
      /<meta property="og:image" content="https:\/\/example\.com\/_mediakiln\/[0-9a-f]{12}\/og\.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="800">/,
    );
    expect(html).toMatch(
      /<meta name="twitter:image" content="https:\/\/example\.com\/_mediakiln\/[0-9a-f]{12}\/og\.jpg">/,
    );
  });

  it("adds image-set() to stylesheets, <style> blocks and style attributes", () => {
    expect(css).toMatch(
      /\.banner \{ background: url\(\.\.\/img\/hero\.jpg\) center \/ cover; background-image: image-set\(url\('\/_mediakiln\/[0-9a-f]{12}\/image\.avif'\) type\('image\/avif'\), url\('\/_mediakiln\/[0-9a-f]{12}\/image\.webp'\) type\('image\/webp'\), url\('\.\.\/img\/hero\.jpg'\) type\('image\/jpeg'\)\); \}/,
    );
    expect(css).toContain(`.logo { background-image: url("/img/missing.png"); }`);
    expect(html).toMatch(
      /<style>\.card \{ background-image: url\('\/img\/small\.png'\); background-image: image-set\(/,
    );
    expect(html).toMatch(
      /style="background-image: url\(\/img\/small\.png\); background-image: image-set\(url\('\/_mediakiln\/[^)]+\) type\('image\/avif'\)/,
    );
  });

  it("writes _headers and the report", () => {
    expect(readFileSync(path.join(dir, "_headers"), "utf8")).toContain(
      "/_mediakiln/*\n  Cache-Control: public, max-age=31536000, immutable",
    );
    const report = readFileSync(path.join(dir, "_mediakiln/report.html"), "utf8");
    expect(report).toContain("<code>img/hero.jpg</code>");
    expect(report).toContain("og");
  });

  it("is idempotent", async () => {
    const files = [
      "index.html",
      "css/site.css",
      "_headers",
      "_mediakiln/report.html",
      "_mediakiln/manifest.json",
    ];
    const before = files.map((f) => readFileSync(path.join(dir, f), "utf8"));
    const s = await optimize({
      dir,
      configFile: false,
      cache: false,
      site: "https://example.com",
      report: true,
      logger: silentLogger,
    });
    expect(s.pages.rewritten).toBe(0);
    expect(s.stylesheets.rewritten).toBe(0);
    expect(files.map((f) => readFileSync(path.join(dir, f), "utf8"))).toEqual(before);
  });
});

describe("remote cache (mock S3)", () => {
  it("uploads new entries and lets a fresh machine skip encoding", async () => {
    const store = new Map<string, Buffer>();
    const auth: string[] = [];
    const server = http.createServer((req, res) => {
      auth.push(req.headers.authorization ?? "");
      const key = req.url!;
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          store.set(key, Buffer.concat(chunks));
          res.writeHead(200).end();
        });
        return;
      }
      const body = store.get(key);
      if (!body) return void res.writeHead(404).end();
      if (req.method === "HEAD")
        return void res.writeHead(200, { "content-length": body.length }).end();
      res.writeHead(200, { "content-length": body.length }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const env = { ...process.env };
    process.env.MEDIAKILN_S3_ACCESS_KEY_ID = "test";
    process.env.MEDIAKILN_S3_SECRET_ACCESS_KEY = "secret";
    try {
      const remoteCache = { bucket: "media", endpoint: `http://127.0.0.1:${port}`, prefix: "ci/" };
      const a = site("remote-a");
      writeFileSync(path.join(a, "index.html"), `<img src="/img/hero.jpg" alt="">`);
      const first = await optimize({
        dir: a,
        configFile: false,
        cacheDir: path.join(root, "cache-a"),
        remoteCache,
        logger: silentLogger,
      });
      expect(first.images.processed).toBe(1);
      expect([...store.keys()]).toHaveLength(1);
      expect([...store.keys()][0]).toMatch(/^\/media\/ci\/[0-9a-f]{64}\.mkpack$/);
      expect(auth.every((h) => h.startsWith("AWS4-HMAC-SHA256 Credential=test/"))).toBe(true);

      // Different machine: empty local cache, same remote.
      const b = site("remote-b");
      writeFileSync(path.join(b, "index.html"), `<img src="/img/hero.jpg" alt="">`);
      const second = await optimize({
        dir: b,
        configFile: false,
        cacheDir: path.join(root, "cache-b"),
        remoteCache,
        logger: silentLogger,
      });
      expect(second.images.processed).toBe(0);
      expect(second.images.cached).toBe(1);
      expect(readFileSync(path.join(b, "index.html"), "utf8")).toBe(
        readFileSync(path.join(a, "index.html"), "utf8"),
      );
      expect(existsSync(path.join(root, "cache-b"))).toBe(true); // stored locally for next time
    } finally {
      process.env = env;
      server.close();
    }
  });
});

describe("markdown mode", () => {
  it("rewrites ![]() images and videos, raw HTML, but never code", async () => {
    const dir = site("markdown");
    mkdirSync(path.join(dir, "posts/hello"), { recursive: true });
    cpSync(media.small, path.join(dir, "posts/hello/shot.png"));
    cpSync(media.short, path.join(dir, "posts/hello/clip.mp4"));
    const md = [
      "# Hello",
      "",
      '![A screenshot](shot.png "Look")',
      "",
      "![Demo clip](clip.mp4)",
      "",
      '<img src="/img/hero.jpg" alt="raw html">',
      "",
      "```md",
      "![not me](shot.png)",
      "```",
      "",
    ].join("\n");
    writeFileSync(path.join(dir, "posts/hello/index.md"), md);
    const opts = {
      dir,
      configFile: false as const,
      cache: false,
      markdown: { enabled: true },
      video: { mp4: { preset: "ultrafast" as const } },
      logger: silentLogger,
    };
    const s = await optimize(opts);
    expect(s.failures).toEqual([]);
    const out = readFileSync(path.join(dir, "posts/hello/index.md"), "utf8");
    expect(out).toMatch(
      /^# Hello\n\n<picture><source type="image\/avif"[^\n]*<img src="\/_mediakiln\/[0-9a-f]{12}\/img-768\.png" alt="A screenshot" title="Look"[^\n]*<\/picture>\n/,
    );
    expect(out).toMatch(
      /<video controls aria-label="Demo clip" preload="none" width="1280" height="720"[^\n]*<source src="\/_mediakiln\/[0-9a-f]{12}\/video\.mp4" type="video\/mp4"><\/video>/,
    );
    expect(out).toMatch(/<picture>[^\n]*alt="raw html"/);
    expect(out).toContain("```md\n![not me](shot.png)\n```");
    expect(out).toMatch(
      /<script type="module" src="\/_mediakiln\/runtime\/loader\.[0-9a-f]{8}\.js"><\/script>\n$/,
    );
    const again = await optimize(opts);
    expect(again.pages.rewritten).toBe(0);
  });
});

describe("watch mode", () => {
  it("re-optimizes when pages change, then settles", async () => {
    const { watch } = await import("../../src/index.js");
    const dir = site("watch");
    writeFileSync(path.join(dir, "index.html"), `<img src="/img/hero.jpg" alt="">`);
    const runs: number[] = [];
    const w = watch({
      dir,
      configFile: false,
      cache: false,
      debounceMs: 100,
      logger: silentLogger,
      onRun: (s) => runs.push(s.pages.rewritten),
    });
    try {
      const until = async (cond: () => boolean) => {
        for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 100));
        await w.idle;
      };
      await until(() => runs.length >= 1);
      expect(runs[0]).toBe(1);
      writeFileSync(path.join(dir, "about.html"), `<img src="/img/small.png" alt="">`);
      await until(() => readFileSync(path.join(dir, "about.html"), "utf8").includes("<picture>"));
      expect(readFileSync(path.join(dir, "about.html"), "utf8")).toContain("<picture>");
      await new Promise((r) => setTimeout(r, 600));
      await w.idle;
      const settled = runs.length;
      await new Promise((r) => setTimeout(r, 600));
      expect(runs.length).toBe(settled); // no feedback loop from our own writes
    } finally {
      await w.close();
    }
  });
});

describe("docusaurus plugin", () => {
  it("runs on postBuild with baseUrl and url", async () => {
    const { default: plugin } = await import("../../src/plugins/docusaurus.js");
    const dir = site("docusaurus");
    writeFileSync(
      path.join(dir, "index.html"),
      `<head><meta property="og:image" content="/docs/img/hero.jpg"></head><img src="/docs/img/hero.jpg" alt="">`,
    );
    const p = plugin({ siteDir: dir }, { configFile: false, cache: false, logger: silentLogger });
    expect(p.name).toBe("mediakiln");
    await p.postBuild({
      outDir: dir,
      siteConfig: { baseUrl: "/docs/", url: "https://example.com" },
    });
    const html = readFileSync(path.join(dir, "index.html"), "utf8");
    expect(html).toMatch(
      /content="https:\/\/example\.com\/docs\/_mediakiln\/[0-9a-f]{12}\/og\.jpg"/,
    );
    expect(html).toMatch(/src="\/docs\/_mediakiln\/[0-9a-f]{12}\/img-1080\.jpg"/);
  });
});
