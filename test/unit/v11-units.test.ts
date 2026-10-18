import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { parseSrcset, serializeSrcset } from "../../src/srcset.js";
import { addImageSets, findBackgroundUrls } from "../../src/css.js";
import { headersBlock, mergeHeaders } from "../../src/headers.js";
import { renderReport } from "../../src/report.js";
import { resolveConfig } from "../../src/config.js";
import { isRuntimeScript } from "../../src/scan.js";
import {
  encodeKeyPath,
  objectUrl,
  packStream,
  signV4,
  unpackStream,
} from "../../src/remoteCache.js";
import type { Manifest } from "../../src/manifest.js";

describe("srcset", () => {
  it("parses descriptors, bare URLs and commas inside URLs", () => {
    expect(parseSrcset("a.jpg 480w, b.jpg 1080w")).toEqual([
      { url: "a.jpg", descriptor: "480w" },
      { url: "b.jpg", descriptor: "1080w" },
    ]);
    expect(parseSrcset("a.jpg, b@2x.jpg 2x")).toEqual([
      { url: "a.jpg" },
      { url: "b@2x.jpg", descriptor: "2x" },
    ]);
    expect(parseSrcset("  img,1.jpg 1x ,\n img,2.jpg 2x ")).toEqual([
      { url: "img,1.jpg", descriptor: "1x" },
      { url: "img,2.jpg", descriptor: "2x" },
    ]);
    expect(parseSrcset("")).toEqual([]);
    expect(serializeSrcset([{ url: "a" }, { url: "b", descriptor: "2x" }])).toBe("a, b 2x");
  });
});

describe("css image-set", () => {
  const alt = (url: string) =>
    url.includes("missing")
      ? undefined
      : {
          modern: [
            { url: `/_mediakiln/h/${url.split("/").pop()}.avif`, mime: "image/avif" },
            { url: `/_mediakiln/h/${url.split("/").pop()}.webp`, mime: "image/webp" },
          ],
          originalMime: "image/jpeg",
        };

  it("adds image-set after background-image, keeping the original as fallback", () => {
    const css = `.hero {\n  background-image: url("../img/hero.jpg");\n  color: red;\n}\n`;
    expect(findBackgroundUrls(css)).toEqual(["../img/hero.jpg"]);
    expect(addImageSets(css, alt)).toBe(
      `.hero {\n  background-image: url("../img/hero.jpg");\n  background-image: image-set(url('/_mediakiln/h/hero.jpg.avif') type('image/avif'), url('/_mediakiln/h/hero.jpg.webp') type('image/webp'), url('../img/hero.jpg') type('image/jpeg'));\n  color: red;\n}\n`,
    );
  });

  it("handles single-image shorthands, skips gradients and multi-layer shorthands", () => {
    const out = addImageSets(`a{background:url(x.jpg) no-repeat center/cover}`, alt)!;
    expect(out).toBe(
      `a{background:url(x.jpg) no-repeat center/cover; background-image:image-set(url('/_mediakiln/h/x.jpg.avif') type('image/avif'), url('/_mediakiln/h/x.jpg.webp') type('image/webp'), url('x.jpg') type('image/jpeg'))}`,
    );
    expect(addImageSets(`a{background:linear-gradient(red,blue),url(x.jpg)}`, alt)).toBeUndefined();
    expect(addImageSets(`a{background-image:url(missing.jpg)}`, alt)).toBeUndefined();
  });

  it("is idempotent and leaves bad CSS alone", () => {
    const once = addImageSets(`a{background-image:url(x.jpg)}`, alt)!;
    expect(addImageSets(once, alt)).toBeUndefined();
    expect(addImageSets(`a{background-image:url(x.jpg)`, alt)).toBeUndefined(); // unclosed block
    expect(addImageSets(`a{{{`, alt)).toBeUndefined();
  });

  it("works on style attribute bodies", () => {
    expect(
      addImageSets(`background-image:url('/img/x.jpg'); height: 10px`, alt, { inline: true }),
    ).toBe(
      `background-image:url('/img/x.jpg'); background-image:image-set(url('/_mediakiln/h/x.jpg.avif') type('image/avif'), url('/_mediakiln/h/x.jpg.webp') type('image/webp'), url('/img/x.jpg') type('image/jpeg')); height: 10px`,
    );
  });
});

describe("_headers", () => {
  const block = headersBlock(resolveConfig({ base: "/docs/" }));
  it("uses base and outDirName", () => {
    expect(block).toBe(
      "# mediakiln:start\n/docs/_mediakiln/*\n  Cache-Control: public, max-age=31536000, immutable\n# mediakiln:end",
    );
  });
  it("appends once, then replaces in place", () => {
    const user = "/*\n  X-Frame-Options: DENY\n";
    const first = mergeHeaders(user, block);
    expect(first).toBe(user + "\n" + block + "\n");
    expect(mergeHeaders(first, block)).toBe(first);
    const changed = mergeHeaders(first, block.replace("31536000", "60"));
    expect(changed).toContain("max-age=60");
    expect(changed.match(/mediakiln:start/g)).toHaveLength(1);
    expect(mergeHeaders("", block)).toBe(block + "\n");
  });
});

describe("report", () => {
  it("renders a self-contained table", () => {
    const manifest: Manifest = {
      version: "1.1.0",
      generatedAt: "2026-10-18T00:00:00.000Z",
      outDir: "_mediakiln",
      assets: [
        {
          source: "img/<x>.jpg",
          kind: "image",
          hash: "abc",
          cached: false,
          bytesBefore: 1000,
          bytesAfter: 250,
          result: {
            kind: "image",
            width: 10,
            height: 5,
            sourceBytes: 1000,
            fallbackFormat: "jpeg",
            variants: [],
          },
        },
      ],
    };
    const html = renderReport(manifest);
    expect(html).toContain("<code>img/&lt;x&gt;.jpg</code>");
    expect(html).toContain(">75%<");
    expect(html).toContain('<meta name="robots" content="noindex">');
  });
});

describe("runtime script detection", () => {
  const config = resolveConfig({});
  it("matches old and versioned loaders only", () => {
    expect(isRuntimeScript("/_mediakiln/runtime/loader.js", config)).toBe(true);
    expect(isRuntimeScript("/blog/_mediakiln/runtime/loader.0a1b2c3d.js?x=1", config)).toBe(true);
    expect(isRuntimeScript("/_mediakiln/runtime/other.js", config)).toBe(false);
    expect(
      isRuntimeScript("/x_mediakiln/runtime/loader.js", resolveConfig({ outDirName: "x.y" })),
    ).toBe(false);
  });
});

describe("remote cache", () => {
  it("SigV4 matches AWS's documented GET Object example", () => {
    const headers = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      date: new Date("2013-05-24T00:00:00Z"),
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("builds virtual-hosted AWS URLs and path-style custom endpoints", () => {
    const base = { bucket: "b", prefix: "mk/", region: "auto", write: true, endpoint: "" };
    expect(objectUrl(base, "k").url.href).toBe("https://b.s3.us-east-1.amazonaws.com/mk/k.mkpack");
    expect(objectUrl({ ...base, region: "eu-west-1" }, "k").region).toBe("eu-west-1");
    const r2 = objectUrl({ ...base, endpoint: "https://acc.r2.cloudflarestorage.com/" }, "k");
    expect(r2.url.href).toBe("https://acc.r2.cloudflarestorage.com/b/mk/k.mkpack");
    expect(r2.region).toBe("auto");
    expect(encodeKeyPath("a b/c(1)")).toBe("a%20b/c%281%29");
  });

  it("packs and unpacks a folder, rejecting path traversal", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "mk-pack-"));
    await mkdir(path.join(src, "hls/v0"), { recursive: true });
    await writeFile(path.join(src, "meta.json"), "{}");
    await writeFile(path.join(src, "hls/v0/seg.m4s"), Buffer.alloc(200_000, 7));
    const { stream, length } = await packStream(src);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const packed = Buffer.concat(chunks);
    expect(packed.length).toBe(length);

    const dest = await mkdtemp(path.join(os.tmpdir(), "mk-unpack-"));
    // feed it in awkward 1000-byte chunks
    const pieces = Array.from({ length: Math.ceil(packed.length / 1000) }, (_, i) =>
      packed.subarray(i * 1000, (i + 1) * 1000),
    );
    await unpackStream(Readable.from(pieces), dest);
    expect(await readFile(path.join(dest, "meta.json"), "utf8")).toBe("{}");
    expect(
      (await readFile(path.join(dest, "hls/v0/seg.m4s"))).equals(Buffer.alloc(200_000, 7)),
    ).toBe(true);

    const index = Buffer.from(JSON.stringify({ v: 1, files: [{ path: "../evil", size: 1 }] }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(index.length);
    await expect(
      unpackStream(Readable.from([Buffer.concat([header, index, Buffer.from("x")])]), dest),
    ).rejects.toThrow(/Unsafe/);
  });
});

describe("markdown", () => {
  it("masks code but keeps offsets", async () => {
    const { maskMarkdownCode, findMarkdownImages } = await import("../../src/markdown.js");
    const md =
      'Intro ![a](x.jpg)\n\n```html\n<img src="y.jpg">\n![b](y.jpg)\n```\n\nUse `![c](z.jpg)` inline.\n<!-- ![d](w.jpg) -->\n![e](<my file.jpg> "Title")\n';
    const masked = maskMarkdownCode(md);
    expect(masked).toHaveLength(md.length);
    expect(masked.split("\n").length).toBe(md.split("\n").length);
    const imgs = findMarkdownImages(masked);
    expect(imgs.map((i) => i.url)).toEqual(["x.jpg", "my file.jpg"]);
    expect(imgs[1]).toMatchObject({ alt: "e", title: "Title" });
    expect(md.slice(imgs[0]!.start, imgs[0]!.end)).toBe("![a](x.jpg)");
  });
});
