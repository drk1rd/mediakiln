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
