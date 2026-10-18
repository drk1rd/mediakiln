import type { GifResult } from "../assets.js";
import type { ResolvedConfig } from "../config.js";
import { attr, getAttr, hasAttr, rebuildStartTag, type Edit } from "../html.js";
import type { GifRef } from "../scan.js";

export interface GifOutputs {
  result: GifResult;
  /** Public URL of the asset folder, ending in "/". */
  baseUrl: string;
}

/**
 * `<img>`-only attributes (invalid or meaningless on `<video>`) and mediakiln's own hints.
 * Everything else (class, style, id, width, height, title, data-*, aria-*…) is kept verbatim.
 */
const DROPPED = [
  "src",
  "alt",
  "srcset",
  "sizes",
  "loading",
  "decoding",
  "fetchpriority",
  "referrerpolicy",
  "usemap",
  "ismap",
  "longdesc",
  "data-mk-eager",
  "data-mk-sizes",
];

/** Turn an animated-GIF `<img>` into `<video autoplay muted loop playsinline>` with an MP4. */
export function rewriteGif(
  html: string,
  ref: GifRef,
  out: GifOutputs,
  config: ResolvedConfig,
): Edit[] {
  const { el } = ref;
  const { result, baseUrl } = out;
  if (result.passthrough || !result.mp4) return [];
  const eager = ref.eager || getAttr(el, "loading") === "eager";
  const lazy = config.images.lazy && !eager;

  const set: Array<[string, string | true]> = [
    ["autoplay", true],
    ["muted", true],
    ["loop", true],
    ["playsinline", true],
  ];
  const alt = getAttr(el, "alt");
  const labelled = hasAttr(el, "aria-label") || hasAttr(el, "aria-labelledby");
  if (alt && alt.trim() !== "" && !labelled) set.push(["aria-label", alt]);
  else if (alt !== undefined && alt.trim() === "" && !labelled && !hasAttr(el, "aria-hidden")) {
    set.push(["aria-hidden", "true"]); // alt="" marks a decorative image
  }
  if (!hasAttr(el, "width") && !hasAttr(el, "height")) {
    set.push(["width", String(result.width)], ["height", String(result.height)]);
  }
  if (result.poster) set.push(["poster", baseUrl + result.poster.path]);
  set.push(["preload", lazy ? "none" : "auto"]);
  if (lazy) set.push(["data-mk-lazy", true]);

  const video = rebuildStartTag(html, el, { remove: DROPPED, set, tagName: "video" });
  const source = `<source ${attr("src", baseUrl + result.mp4.path)} type="video/mp4">`;
  const loc = el.sourceCodeLocation!.startTag!;
  return [{ start: loc.startOffset, end: loc.endOffset, text: `${video}${source}</video>` }];
}
