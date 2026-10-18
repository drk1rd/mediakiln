# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-10-18

The roadmap release: more of the page is optimized, video streams better, and builds share
work.

### Added

- **Video**
  - HLS uses fMP4/CMAF segments with a 1-second first segment for a faster start
    (`video.hls.segmentType`, `video.hls.firstSegmentSec`).
  - HEVC and AV1 renditions next to H.264 (`video.hls.codecs`), at proportionally lower
    bitrates.
  - Hardware encoders: `video.encoder` = `"videotoolbox"`, `"nvenc"` or `"auto"`.
  - Per-title encoding (`video.hls.perTitle`): bitrates scaled to each video's complexity.
  - Local `<track>` WebVTT captions are added to the HLS stream as subtitle renditions
    (`video.captions`); players list them exactly once.
  - Thumbnail sprites and a WebVTT thumbnail track (`video.thumbnails`), exposed as
    `data-mk-thumbnails`.
- **Images**
  - Animated GIFs in `<img>` become `<video autoplay muted loop playsinline>` with an H.264 MP4
    and a WebP poster, typically 5–20× smaller (`images.gifToVideo`, on by default).
  - `<img>` inside an existing `<picture>`, including art-directed `<source media>`
    (`images.pictures`).
  - Existing local `srcset`s get AVIF/WebP alternatives with the same descriptors
    (`images.srcset`).
  - CSS `url()` backgrounds in stylesheets, `<style>` and `style=""` get an `image-set()`
    (`images.css`).
  - `og:image` / `twitter:image` resized to a 1200px JPEG, absolute with `site`
    (`images.openGraph`, `--site`).
- **Workflow**
  - Shared S3-compatible cache (`remoteCache`): AWS S3, Cloudflare R2, MinIO, Backblaze B2.
  - `--watch` / `watch()` re-optimizes when the output changes.
  - `report.html` listing every asset and the bytes saved (`report`, `--report`).
  - `_headers` for Cloudflare Pages and Netlify caching `/_mediakiln/*` for a year (`headers`).
  - Experimental Markdown mode (`markdown.enabled`): `![alt](img)` and `![](clip.mp4)` become
    optimized HTML in place.
  - `mediakiln/docusaurus` plugin and [docs/RECIPES.md](docs/RECIPES.md) for Next.js,
    SvelteKit, Nuxt, VitePress, Gatsby, Hugo and Jekyll.
- **Project**: CI on Linux, macOS and Windows; contributing guide, security policy, issue
  templates and Dependabot. The example site is live at https://drk1rd.github.io/mediakiln/.

### Changed

- Runtime files have versioned names (`loader.<hash>.js`, `hls.light.<version>.min.js`) so
  everything under `/_mediakiln/` can be cached as immutable. Pages from older runs keep working.
- `images.skip` defaults to `["**/*.svg"]`; GIFs are governed by `images.gifToVideo`.
- Cache format version 3: the first run after upgrading re-encodes once.

## [1.0.1] - 2026-10-18

### Changed

- Removed the GitHub Pages deploy workflow; the example site will be hosted elsewhere.
- CI: the action self-test accepts assets restored from the cache.

## [1.0.0] - 2026-10-18

First release.

### Added

- `mediakiln <dir>` CLI and `optimize()` API: optimizes a built static site in place.
- Video: faststart H.264 MP4 (remux when possible, re-encode otherwise), poster frames,
  intrinsic dimensions, lazy loading, rotation-aware probing.
- Adaptive HLS (VOD, multi-rendition) for long or large videos, with a ~1 KB runtime loader
  that uses native HLS on Safari, self-hosted hls.js elsewhere and the MP4 as fallback.
- Images: AVIF/WebP/JPEG/PNG at responsive widths, `<picture>` markup, `srcset`/`sizes`,
  LCP-aware lazy loading, and a "never make it worse" guard.
- Content-hash cache (`.mediakiln-cache`) with atomic writes; re-runs are idempotent.
- GitHub Action (`uses: drk1rd/mediakiln@v1`) with cache and a job summary.
- Per-element opt-outs: `data-mk-skip`, `data-mk-eager`, `data-mk-no-hls`, `data-mk-sizes`.
- Framework plugins: `mediakiln/vite`, `mediakiln/astro`, `mediakiln/eleventy`.
- Docker image (`ghcr.io/drk1rd/mediakiln`) with ffmpeg included.
- `--dry-run` and `--json`; exit code 2 when individual assets fail.
- Reproducible benchmark script (`scripts/bench.mts`) and [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

### Not yet

Ideas for after v1: animated GIF → MP4/WebM (done after 1.0.1), AV1 renditions, `<img>` inside existing
`<picture>`, CSS `background-image`, a Markdown-source mode, watch mode for dev servers, and
scrubbing thumbnail sprites.

[Unreleased]: https://github.com/drk1rd/mediakiln/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/drk1rd/mediakiln/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/drk1rd/mediakiln/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/drk1rd/mediakiln/releases/tag/v1.0.0
