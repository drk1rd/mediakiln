import type { ImageResult, ImageVariant } from "../assets.js";
import type { ResolvedConfig } from "../config.js";
import { attr, getAttr, hasAttr, rebuildStartTag, type Edit } from "../html.js";
import type { ImageRef } from "../scan.js";

export interface ImageOutputs {
  result: ImageResult;
  /** Public URL of the asset folder, ending in "/". */
  baseUrl: string;
}

const MIME: Record<ImageVariant["format"], string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
};

/** The width closest to 1080 from below, or the smallest one when all are wider. */
export function pickFallbackWidth(widths: number[]): number {
  const sorted = [...new Set(widths)].sort((a, b) => a - b);
  const below = sorted.filter((w) => w <= 1080);
  return below.length > 0 ? below[below.length - 1]! : sorted[0]!;
}

/** Turn `<img>` into `<picture>` with AVIF/WebP `<source>`s and a responsive fallback `<img>`. */
export function rewriteImage(
  html: string,
  ref: ImageRef,
  out: ImageOutputs,
  config: ResolvedConfig,
): Edit[] {
  const { el } = ref;
  const { result, baseUrl } = out;
  const srcset = (format: ImageVariant["format"]) =>
    result.variants
      .filter((v) => v.format === format)
      .sort((a, b) => a.width - b.width)
      .map((v) => `${baseUrl}${v.path} ${v.width}w`)
      .join(", ");

  const sizes = ref.sizes ?? getAttr(el, "sizes") ?? config.images.sizes;
  const fallbackWidth = pickFallbackWidth(result.variants.map((v) => v.width));
  const fallback = result.variants.find(
    (v) => v.format === result.fallbackFormat && v.width === fallbackWidth,
  )!;

  const set: Array<[string, string | true]> = [
    ["src", baseUrl + fallback.path],
    ["srcset", srcset(result.fallbackFormat)],
    ["sizes", sizes],
  ];
  if (!hasAttr(el, "width") && !hasAttr(el, "height")) {
    set.push(["width", String(result.width)], ["height", String(result.height)]);
  }
  const lazy = config.images.lazy && !ref.eager && !ref.first;
  if (lazy && !hasAttr(el, "loading")) set.push(["loading", "lazy"]);
  if (!hasAttr(el, "decoding")) set.push(["decoding", "async"]);

  const img = rebuildStartTag(html, el, { remove: ["data-mk-eager", "data-mk-sizes"], set });
  const sources = [...new Set(result.variants.map((v) => v.format))]
    .filter((f) => f !== result.fallbackFormat)
    .map(
      (f) =>
        `<source ${attr("type", MIME[f])} ${attr("srcset", srcset(f))} ${attr("sizes", sizes)}>`,
    );

  const loc = el.sourceCodeLocation!.startTag!;
  return [
    {
      start: loc.startOffset,
      end: loc.endOffset,
      text: `<picture>${sources.join("")}${img}</picture>`,
    },
  ];
}
