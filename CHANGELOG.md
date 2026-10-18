# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
