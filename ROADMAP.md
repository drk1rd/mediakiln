# Roadmap

## Shipped in 1.1

Everything from the post-1.0 roadmap:

- [x] Faster HLS start: fMP4/CMAF segments and a 1-second first segment
- [x] HEVC and AV1 renditions; per-title encoding; hardware encoders (VideoToolbox, NVENC)
- [x] Captions inside the HLS stream; thumbnail sprites for scrubbing
- [x] Animated GIF → looping MP4
- [x] `<img>` inside existing `<picture>` (art direction), existing local `srcset`s
- [x] CSS `background-image` → `image-set()`; resized `og:image` / `twitter:image`
- [x] `_headers` for Cloudflare Pages/Netlify; HTML report
- [x] Watch mode; shared S3/R2 cache; Markdown mode; Docusaurus plugin; framework recipes
- [x] CI on Linux, macOS and Windows

## Next

Ideas, roughly in order of impact. Issues and PRs welcome.

- **Markdown mode out of experimental**: MDX support (JSX attribute names), more real-world
  testing with Hugo page bundles and docs sites.
- **Audio**: `<audio>` → AAC/Opus with HLS for long podcasts.
- **DASH manifest** next to HLS from the same CMAF segments, for players that prefer it.
- **Smarter posters**: pick a representative frame (scene detection) instead of a fixed time.
- **Responsive video sources**: `<source media>` with smaller MP4s for narrow screens when HLS
  isn't used.
- **CSS**: `image-set()` for more properties (`content`, `list-style-image`, `border-image`)
  and for images referenced from inline SVG.
- **Vercel and AWS Amplify** header config generation like `_headers`.
- **Benchmarks on real-world media** (licensed sample footage and photos) alongside the
  synthetic set.
