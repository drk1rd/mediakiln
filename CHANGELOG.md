# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The example site is deployed to GitHub Pages again: https://drk1rd.github.io/mediakiln/

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

Ideas for after v1: animated GIF → MP4/WebM, AV1 renditions, `<img>` inside existing
`<picture>`, CSS `background-image`, a Markdown-source mode, watch mode for dev servers, and
scrubbing thumbnail sprites.

[Unreleased]: https://github.com/drk1rd/mediakiln/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/drk1rd/mediakiln/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/drk1rd/mediakiln/releases/tag/v1.0.0
