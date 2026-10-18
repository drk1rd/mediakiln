import type { OgResult } from "../assets.js";
import type { ResolvedConfig } from "../config.js";
import { addImageSets, type ImageSetEntry } from "../css.js";
import { attr, rebuildStartTag, type Edit } from "../html.js";
import type { OgRef, StyleRef } from "../scan.js";

/**
 * Point og:image / twitter:image at the resized JPEG. With `site` configured the URL is made
 * absolute (Open Graph requires it). og:image also gets width/height metas when the page has
 * none, which lets crawlers lay out the preview before fetching the image.
 */
export function rewriteOg(
  html: string,
  ref: OgRef,
  out: { result: OgResult; url: string },
  config: ResolvedConfig,
  addDims: boolean,
): Edit[] {
  const url = (config.site || "") + out.url;
  const tag = rebuildStartTag(html, ref.el, { set: [["content", url]] });
  const loc = ref.el.sourceCodeLocation!.startTag!;
  const dims = addDims
    ? `<meta ${attr("property", "og:image:width")} ${attr("content", String(out.result.width))}>` +
      `<meta ${attr("property", "og:image:height")} ${attr("content", String(out.result.height))}>`
    : "";
  return [{ start: loc.startOffset, end: loc.endOffset, text: tag + dims }];
}

export type Alternatives = (
  url: string,
) => { modern: ImageSetEntry[]; originalMime: string } | undefined;

/** Add image-set() backgrounds inside a `<style>` block or a `style` attribute. */
export function rewriteStyle(html: string, ref: StyleRef, alternatives: Alternatives): Edit[] {
  if (ref.kind === "block") {
    const css = addImageSets(ref.css, alternatives);
    return css === undefined ? [] : [{ start: ref.start, end: ref.end, text: css }];
  }
  const css = addImageSets(ref.css, alternatives, { inline: true });
  if (css === undefined) return [];
  const loc = ref.el.sourceCodeLocation!.startTag!;
  return [
    {
      start: loc.startOffset,
      end: loc.endOffset,
      text: rebuildStartTag(html, ref.el, { set: [["style", css]] }),
    },
  ];
}
