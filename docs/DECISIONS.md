# Design decisions and spec deviations

Notes on places where the implementation differs from, or fills gaps in, the original build spec.

## Tooling

- **TypeScript 6.0, not 7.** TypeScript 7 (the native port) is current, but `typescript-eslint`
  only supports `<6.1`. We stay on 6.0 until the lint toolchain catches up.
- **`tinyglobby` + `picomatch`** for globbing. `fs.glob` is not available on Node 20.
- **Config gains `cache`, `cacheDir` and `concurrency`.** The CLI flags `--no-cache`, `--cache-dir`
  and `--concurrency` map onto these, so the same options work from config files and plugins.
- **Logs go to stderr, the summary too.** stdout is reserved for `--json` output so it can be piped.

## Video (M1)

- **HTML is rewritten by splicing the original source**, not by re-serializing a DOM. parse5
  gives exact source offsets for every tag and attribute, so untouched markup (including
  attribute quoting, whitespace and comments) stays byte-for-byte identical.
- **Which file is "the video".** The `src` attribute wins; otherwise the first `<source>` that
  points at a local `.mp4/.mov/.m4v/.webm/.mkv`. Every other local `<source>` is treated as an
  alternate encoding of the same video and removed (our H.264 MP4 plays everywhere). External
  `<source>`s, `<track>`s and fallback content are kept.
- **Remux needs `yuv420p` too.** H.264 in 4:4:4 or 10-bit doesn't play in most browsers, so
  `auto` only remuxes H.264 + (AAC or no audio) + `yuv420p`/`yuvj420p`, at or below `maxHeight`
  and at or below ~8 Mbps scaled by frame area (1 Mbps floor).
- **Re-encode keeps even dimensions.** The scale filter is
  `scale=-2:'min(<maxHeight>,trunc(ih/2)*2)'`; libx264 with yuv420p rejects odd heights.
- **Explicit stream mapping.** Only the first video and first audio stream are kept, so cover
  art, data and subtitle streams never break the MP4 mux.
- **Posters are always generated** and resized to the output height. When the element already
  has a local `poster`, that image is optimized separately and used instead; a remote poster is
  left alone. Always generating keeps one encode per (file, settings) pair.
- **Autoplay videos are not lazy.** Per the spec they get `preload="metadata"`; the loader still
  handles autoplay on lazy videos if someone marks them up by hand.
- **`data-mk-skip` stays in the output.** "Completely untouched" means exactly that, and keeping
  the attribute is what makes a re-run skip the element again.
- **Idempotency** comes from detection: a `<video>` with `data-mk-hls`/`data-mk-lazy` or a
  source inside `_mediakiln/` is already processed; outputs already present in
  `_mediakiln/<hash>/` (matching `meta.json` key) are reused rather than rebuilt; the manifest
  merges by hash.
- **Summary bytes** count what a visitor downloads: source file → `video.mp4` for videos.

## HLS and runtime (M2)

- **"1080p" means the short side.** Rendition heights and `mp4.maxHeight` apply to the shorter
  dimension, so a portrait 1080x1920 phone video keeps 1080x1920 instead of shrinking to
  608x1080. Landscape behaves exactly as the spec describes.
- **ffmpeg writes `hls/master.m3u8`** next to the `v%v/` folders with relative variant URIs;
  verified with ffmpeg 9. We parse it after encoding and fail the asset if any variant lacks
  `BANDWIDTH` or `RESOLUTION`, or if the variant count is wrong.
- **One `split` is skipped for a single rendition**; `-maxrate` is 1.07× and `-bufsize` 1.5× the
  target bitrate, matching the reference command.
- **hls.js ESM build.** `hls.light.min.js` in the output is hls.js's ES module build
  (`dist/hls.light.min.mjs`), so the loader can `import()` it. The loader also accepts a UMD build
  via `window.Hls`. The filename stays `.js` because some servers lack a MIME type for `.mjs`.
- **Loader targets ES2020**, not ES2018: it needs `import.meta.url` to find hls.js relative to
  itself (which keeps custom `base` paths working). Every browser that runs module scripts with
  dynamic `import()` has `import.meta`. The bundle is ~0.8 KB gzipped.
- **Reduced motion** applies to every mediakiln-managed video, including eager MP4-only autoplay
  videos (detected by their `<source>` living under the output folder).
- **E2E runs in Playwright's Chromium and WebKit** and asserts on attributes, network requests
  and hls.js taking over the element (`blob:` src), not decoded frames. Open-source Chromium
  has no H.264 decoder.

## Images (M3)

- **Widths follow the spec literally**: configured widths that fit, or the original width when
  none do. A 3000px image gets 480…2400; the 3000px original is not re-encoded.
- **Colour handling**: EXIF orientation is applied, all metadata (EXIF, XMP, ICC) is stripped and
  pixels are converted to sRGB. Browsers treat untagged images as sRGB, so this renders the same
  as keeping an sRGB profile while saving the few KB an embedded profile would add to every
  variant.
- **PNG fallbacks are palette-quantized** (`quality` maps to libimagequant), the only way a PNG
  quality setting means anything. If a fallback at the original width is still bigger than the
  original file, the original bytes are used.
- **Fallback format** is PNG for PNG sources or any source with alpha, otherwise JPEG (also for
  WebP/AVIF/TIFF sources).
- **LCP heuristic** counts the first `<img>` in the document even if mediakiln skips it (for
  example an external hero image), since that element is still the likely LCP.
- **`sizes` precedence**: `data-mk-sizes` > the `<img>`'s own `sizes` > `images.sizes`.
- **Author `width`/`height`/`loading`/`decoding` are kept** as written.
- **Summary bytes** for images compare the original file with the AVIF (else WebP, else
  fallback) variant at the fallback width, roughly what a modern browser downloads at 1080px.
