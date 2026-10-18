import type { ConvertResult, ImageResult, ImageVariant } from "../assets.js";
import type { ResolvedConfig } from "../config.js";
import { attr, getAttr, hasAttr, rebuildStartTag, type Edit, type Element } from "../html.js";
import type { Candidate, ImageRef, PictureRef, SrcsetRef } from "../scan.js";
import { pickFallbackWidth } from "../images/process.js";
import { serializeSrcset } from "../srcset.js";

export { pickFallbackWidth };

export interface ImageOutputs {
  result: ImageResult;
  /** Public URL of the asset folder, ending in "/". */
  baseUrl: string;
}

/** A converted candidate: its result and asset-folder URL. */
export interface ConvertOutput {
  result: ConvertResult;
  baseUrl: string;
}

export const MIME: Record<ImageVariant["format"], string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
};

const CONSUMED = ["data-mk-eager", "data-mk-sizes"];

interface ImgFlags {
  el: Element;
  first: boolean;
  eager: boolean;
}

/** width/height (when absent), loading="lazy" (unless LCP/eager) and decoding="async". */
function imgExtras(
  ref: ImgFlags,
  dims: { width: number; height: number } | undefined,
  config: ResolvedConfig,
): Array<[string, string | true]> {
  const { el } = ref;
  const extra: Array<[string, string | true]> = [];
  if (dims && !hasAttr(el, "width") && !hasAttr(el, "height")) {
    extra.push(["width", String(dims.width)], ["height", String(dims.height)]);
  }
  const lazy = config.images.lazy && !ref.eager && !ref.first;
  if (lazy && !hasAttr(el, "loading")) extra.push(["loading", "lazy"]);
  if (!hasAttr(el, "decoding")) extra.push(["decoding", "async"]);
  return extra;
}

function responsiveSrcset(
  result: ImageResult,
  baseUrl: string,
  format: ImageVariant["format"],
): string {
  return result.variants
    .filter((v) => v.format === format)
    .sort((a, b) => a.width - b.width)
    .map((v) => `${baseUrl}${v.path} ${v.width}w`)
    .join(", ");
}

function modernFormats(result: ImageResult): Array<ImageVariant["format"]> {
  return [...new Set(result.variants.map((v) => v.format))].filter(
    (f) => f !== result.fallbackFormat,
  );
}

/**
 * The responsive pieces for an `<img>`: typed `<source>`s and the rewritten `<img>` tag.
 * `null` when the image passed through (only attributes are added).
 */
export function imageParts(
  html: string,
  ref: ImgFlags & { sizes?: string },
  out: ImageOutputs,
  config: ResolvedConfig,
): { sources: string[]; img: string } {
  const { el } = ref;
  const { result, baseUrl } = out;
  if (result.passthrough || result.variants.length === 0) {
    return {
      sources: [],
      img: rebuildStartTag(html, el, { remove: CONSUMED, set: imgExtras(ref, result, config) }),
    };
  }
  const sizes = ref.sizes ?? getAttr(el, "sizes") ?? config.images.sizes;
  const fallbackWidth = pickFallbackWidth(result.variants.map((v) => v.width));
  const fallback = result.variants.find(
    (v) => v.format === result.fallbackFormat && v.width === fallbackWidth,
  )!;
  const img = rebuildStartTag(html, el, {
    remove: CONSUMED,
    set: [
      ["src", baseUrl + fallback.path],
      ["srcset", responsiveSrcset(result, baseUrl, result.fallbackFormat)],
      ["sizes", sizes],
      ...imgExtras(ref, result, config),
    ],
  });
  const sources = modernFormats(result).map(
    (f) =>
      `<source ${attr("type", MIME[f])} ${attr("srcset", responsiveSrcset(result, baseUrl, f))} ${attr("sizes", sizes)}>`,
  );
  return { sources, img };
}

/** Turn `<img>` into `<picture>` with AVIF/WebP `<source>`s and a responsive fallback `<img>`. */
export function rewriteImage(
  html: string,
  ref: ImageRef,
  out: ImageOutputs,
  config: ResolvedConfig,
): Edit[] {
  const loc = ref.el.sourceCodeLocation!.startTag!;
  const { sources, img } = imageParts(html, ref, out, config);
  if (sources.length === 0) {
    const original = html.slice(loc.startOffset, loc.endOffset);
    return img === original ? [] : [{ start: loc.startOffset, end: loc.endOffset, text: img }];
  }
  return [
    {
      start: loc.startOffset,
      end: loc.endOffset,
      text: `<picture>${sources.join("")}${img}</picture>`,
    },
  ];
}

/**
 * Typed `<source>` srcsets mirroring a list of author-sized candidates (same descriptors), one
 * per modern format that every candidate has.
 */
export function convertedSources(
  candidates: Candidate[],
  outputs: Map<string, ConvertOutput>,
  extraAttrs: string,
): string[] {
  const outs = candidates.map((c) => outputs.get(c.file));
  if (outs.some((o) => !o)) return [];
  const formats = (["avif", "webp"] as const).filter((f) =>
    outs.every((o) => o!.result.variants.some((v) => v.format === f)),
  );
  return formats.map((f) => {
    const srcset = serializeSrcset(
      candidates.map((c, i) => ({
        url: outs[i]!.baseUrl + outs[i]!.result.variants.find((v) => v.format === f)!.path,
        descriptor: c.descriptor,
      })),
    );
    return `<source ${attr("type", MIME[f])} ${attr("srcset", srcset)}${extraAttrs}>`;
  });
}

const passAttrs = (el: Element, names: string[]) =>
  names
    .map((n) => [n, getAttr(el, n)] as const)
    .filter(([, v]) => v !== undefined)
    .map(([n, v]) => ` ${attr(n, v!)}`)
    .join("");

/** `<img srcset>` with local candidates → `<picture>` with converted AVIF/WebP sources. */
export function rewriteSrcset(
  html: string,
  ref: SrcsetRef,
  outputs: Map<string, ConvertOutput>,
  config: ResolvedConfig,
): Edit[] {
  const sources = convertedSources(ref.candidates, outputs, passAttrs(ref.el, ["sizes"]));
  const dimsFrom = outputs.get(ref.srcFile ?? "") ?? outputs.get(ref.candidates[0]!.file);
  const img = rebuildStartTag(html, ref.el, {
    remove: CONSUMED,
    set: imgExtras(ref, dimsFrom?.result, config),
  });
  const loc = ref.el.sourceCodeLocation!.startTag!;
  if (sources.length === 0) {
    const original = html.slice(loc.startOffset, loc.endOffset);
    return img === original ? [] : [{ start: loc.startOffset, end: loc.endOffset, text: img }];
  }
  return [
    {
      start: loc.startOffset,
      end: loc.endOffset,
      text: `<picture>${sources.join("")}${img}</picture>`,
    },
  ];
}

export interface PictureOutputs {
  images: Map<string, ImageOutputs>;
  converted: Map<string, ConvertOutput>;
}

/**
 * Optimize an existing `<picture>`: each art-directed `<source>` expands into AVIF/WebP and
 * fallback sources with the same `media`, and the `<img>` gets the usual treatment.
 */
export function rewritePicture(
  html: string,
  ref: PictureRef,
  out: PictureOutputs,
  config: ResolvedConfig,
): Edit[] {
  const edits: Edit[] = [];
  const imgSizes = ref.sizes ?? getAttr(ref.img, "sizes") ?? config.images.sizes;

  for (const { el, source } of ref.sources) {
    const loc = el.sourceCodeLocation;
    if (!loc) continue;
    const sizes = getAttr(el, "sizes") ?? imgSizes;
    let text: string | undefined;
    if (source.mode === "responsive") {
      const o = out.images.get(source.file);
      if (!o || o.result.passthrough || o.result.variants.length === 0) continue;
      const dims: Array<[string, string]> =
        hasAttr(el, "width") || hasAttr(el, "height")
          ? []
          : [
              ["width", String(o.result.width)],
              ["height", String(o.result.height)],
            ];
      const typed = modernFormats(o.result).map((f) =>
        rebuildStartTag(html, el, {
          remove: ["srcset", "sizes", "type"],
          set: [
            ["type", MIME[f]],
            ["srcset", responsiveSrcset(o.result, o.baseUrl, f)],
            ["sizes", sizes],
            ...dims,
          ],
        }),
      );
      const fallback = rebuildStartTag(html, el, {
        remove: ["srcset", "sizes"],
        set: [
          ["srcset", responsiveSrcset(o.result, o.baseUrl, o.result.fallbackFormat)],
          ["sizes", sizes],
          ...dims,
        ],
      });
      text = typed.join("") + fallback;
    } else {
      const extra = passAttrs(el, ["media", "sizes", "width", "height"]);
      const typed = convertedSources(source.candidates, out.converted, extra);
      if (typed.length === 0) continue;
      text = typed.join("") + html.slice(loc.startOffset, loc.endOffset);
    }
    edits.push({ start: loc.startOffset, end: loc.endOffset, text });
  }

  const imgLoc = ref.img.sourceCodeLocation!.startTag!;
  if (ref.imgSource.mode === "responsive") {
    const o = out.images.get(ref.imgSource.file);
    if (o) {
      const { sources, img } = imageParts(
        html,
        { ...ref, el: ref.img, sizes: ref.sizes },
        o,
        config,
      );
      edits.push({
        start: imgLoc.startOffset,
        end: imgLoc.endOffset,
        text: sources.join("") + img,
      });
    }
  } else {
    const cands = ref.imgSource.candidates;
    const typed = convertedSources(cands, out.converted, passAttrs(ref.img, ["sizes"]));
    const img = rebuildStartTag(html, ref.img, {
      remove: CONSUMED,
      set: imgExtras({ ...ref, el: ref.img }, out.converted.get(cands[0]!.file)?.result, config),
    });
    edits.push({ start: imgLoc.startOffset, end: imgLoc.endOffset, text: typed.join("") + img });
  }
  return edits;
}
