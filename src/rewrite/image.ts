import type { ImageResult, ImageVariant } from "../assets.js";
import type { ResolvedConfig } from "../config.js";
import { attr, getAttr, hasAttr, rebuildStartTag, type Edit } from "../html.js";
import type { ImageRef } from "../scan.js";
import { pickFallbackWidth } from "../images/process.js";

export { pickFallbackWidth };

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

/** Turn `<img>` into `<picture>` with AVIF/WebP `<source>`s and a responsive fallback `<img>`. */
export function rewriteImage(
  html: string,
  ref: ImageRef,
  out: ImageOutputs,
  config: ResolvedConfig,
): Edit[] {
  const { el } = ref;
  const { result, baseUrl } = out;
  const lazy = config.images.lazy && !ref.eager && !ref.first;
  const extras = (): Array<[string, string | true]> => {
    const extra: Array<[string, string | true]> = [];
    if (!hasAttr(el, "width") && !hasAttr(el, "height")) {
      extra.push(["width", String(result.width)], ["height", String(result.height)]);
    }
    if (lazy && !hasAttr(el, "loading")) extra.push(["loading", "lazy"]);
    if (!hasAttr(el, "decoding")) extra.push(["decoding", "async"]);
    return extra;
  };
  const loc = el.sourceCodeLocation!.startTag!;

  if (result.passthrough || result.variants.length === 0) {
    const set = extras();
    if (set.length === 0 && !hasAttr(el, "data-mk-eager") && !hasAttr(el, "data-mk-sizes"))
      return [];
    const img = rebuildStartTag(html, el, { remove: ["data-mk-eager", "data-mk-sizes"], set });
    return [{ start: loc.startOffset, end: loc.endOffset, text: img }];
  }
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
    ...extras(),
  ];

  const img = rebuildStartTag(html, el, { remove: ["data-mk-eager", "data-mk-sizes"], set });
  const sources = [...new Set(result.variants.map((v) => v.format))]
    .filter((f) => f !== result.fallbackFormat)
    .map(
      (f) =>
        `<source ${attr("type", MIME[f])} ${attr("srcset", srcset(f))} ${attr("sizes", sizes)}>`,
    );

  return [
    {
      start: loc.startOffset,
      end: loc.endOffset,
      text: `<picture>${sources.join("")}${img}</picture>`,
    },
  ];
}
