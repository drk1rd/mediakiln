import type { ResolvedConfig } from "../config.js";
import type { VideoResult } from "../assets.js";
import { attr, getAttr, hasAttr, rebuildStartTag, widenToLine, type Edit } from "../html.js";
import type { VideoRef } from "../scan.js";

export interface VideoOutputs {
  result: VideoResult;
  /** Public URL of the asset folder, ending in "/", e.g. "/_mediakiln/a1b2c3d4e5f6/". */
  baseUrl: string;
  /** Public URL of an optimized author-provided poster, if there was one. */
  posterUrl?: string;
  /** Public URL of a master playlist that adds the page's captions to the HLS stream. */
  captionsMasterUrl?: string;
}

/** Attributes consumed by mediakiln that should not survive into the output. */
const CONSUMED = ["data-mk-eager", "data-mk-no-hls", "data-mk-sizes"];

export function rewriteVideo(
  html: string,
  ref: VideoRef,
  out: VideoOutputs,
  config: ResolvedConfig,
): Edit[] {
  const { el } = ref;
  const { result, baseUrl } = out;
  const autoplay = hasAttr(el, "autoplay");
  const lazy = config.video.lazy && !ref.eager && !autoplay;

  const set: Array<[string, string | true]> = [];
  if (autoplay && !hasAttr(el, "playsinline")) set.push(["playsinline", true]);
  set.push(["preload", lazy ? "none" : config.video.preload]);
  if (!hasAttr(el, "width") && !hasAttr(el, "height")) {
    set.push(["width", String(result.width)], ["height", String(result.height)]);
  }
  const poster = out.posterUrl ?? (result.poster ? baseUrl + result.poster.path : undefined);
  if (poster && (out.posterUrl || !getAttr(el, "poster"))) set.push(["poster", poster]);
  if (result.hls) set.push(["data-mk-hls", out.captionsMasterUrl ?? baseUrl + result.hls.master]);
  if (result.thumbnails) set.push(["data-mk-thumbnails", baseUrl + result.thumbnails.vtt]);
  if (lazy) set.push(["data-mk-lazy", true]);

  const loc = el.sourceCodeLocation!;
  const startTag = loc.startTag!;
  const newStart = rebuildStartTag(html, el, { remove: ["src", ...CONSUMED], set });
  const source = `<source ${attr("src", baseUrl + result.mp4.path)} type="video/mp4">`;

  // The optimized MP4 takes the place of the first local <source> (keeping its line and
  // indentation); other local sources are alternates of the same video and are dropped.
  const [first, ...rest] = ref.localSources.filter((s) => s.sourceCodeLocation);
  const edits: Edit[] = [];
  if (first) {
    const fl = first.sourceCodeLocation!;
    edits.push({ start: startTag.startOffset, end: startTag.endOffset, text: newStart });
    edits.push({ start: fl.startOffset, end: fl.endOffset, text: source });
  } else {
    edits.push({ start: startTag.startOffset, end: startTag.endOffset, text: newStart + source });
  }
  // Tracks now also live in the HLS stream; the loader removes these once HLS is attached so
  // players don't list them twice. Without HLS (MP4 fallback) they keep working as-is.
  if (result.hls && out.captionsMasterUrl) {
    for (const t of ref.tracks) {
      const tl = t.el.sourceCodeLocation?.startTag;
      if (!tl) continue;
      edits.push({
        start: tl.startOffset,
        end: tl.endOffset,
        text: rebuildStartTag(html, t.el, { set: [["data-mk-in-hls", true]] }),
      });
    }
  }
  for (const s of rest) {
    const sl = s.sourceCodeLocation!;
    const [start, end] = widenToLine(html, sl.startOffset, sl.endOffset);
    edits.push({ start, end, text: "" });
  }
  return edits;
}
