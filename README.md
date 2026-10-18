# mediakiln

**Bake the media in a static site so it's ready to stream.**

Run it after your build, and every video, image, GIF, CSS background and social preview comes
out optimized: faststart MP4s, adaptive HLS (H.264, HEVC, AV1), posters, captions, AVIF/WebP,
responsive `srcset`, lazy loading. The output is plain static files that any host or CDN can
serve. No service, no account, no per-minute pricing.

```bash
npx github:drk1rd/mediakiln ./dist
```

```
mediakiln v1.1.1 — ./dist
  videos   2 processed (1 HLS, 1 MP4-only), 0 cached     62.3 MB → 41.6 MB
  images   4 processed, 0 cached     12.0 MB → 20.4 KB
  pages    1 rewritten
  time   12.1s
```

![The same 30-second 1080p video on a 6 Mbps connection: the raw MP4 keeps buffering and has played 3.1 s after ten seconds, the mediakiln version adapts its quality and has played 8.4 s](docs/demo.gif)

<sub>The same 30 s, 16 Mbps 1080p video over a 6 Mbps link, ten seconds after pressing play.
Left: the original MP4. Right: after mediakiln. From the
[benchmarks](docs/BENCHMARKS.md).</sub>

## What it does

**Video** (`<video src>`, `<video><source src>`, and `![](clip.mp4)` in Markdown mode)

- Faststart MP4 (`moov` before `mdat`): remuxed losslessly when the source is already web-ready
  H.264/AAC, re-encoded otherwise (`.mp4 .mov .m4v .webm .mkv` in, H.264 MP4 out).
- Adaptive HLS for videos over 10 s or 5 MB: fMP4/CMAF segments, a 1-second first segment for a
  fast start, 360p/720p/1080p by default, optionally with **HEVC and AV1** renditions for
  browsers that support them, and **per-title** bitrates matched to each video's complexity.
- Plays natively on Safari/iOS (and Chromium with native HLS), via a self-hosted, lazily
  loaded hls.js elsewhere, and from the MP4 everywhere else.
- **Captions**: local `<track>` WebVTT files become subtitle renditions inside the HLS stream,
  listed once per player.
- A WebP poster, optional **thumbnail sprites** (WebVTT track for scrub previews), intrinsic
  `width`/`height`, `playsinline` for autoplay, `preload="none"` until near the viewport.
- **Hardware encoding** with VideoToolbox (macOS) or NVENC (NVIDIA), or detected automatically.
- Rotation-aware: phone videos keep their orientation and their "1080p".

**Images**

- `<img>`: AVIF, WebP and a JPEG/PNG fallback at responsive widths in `<picture>`, with
  `width`/`height`, `loading="lazy"` (not on the first, likely LCP image) and
  `decoding="async"`.
- Existing `<picture>`s (including art direction with `<source media>`) and existing local
  `srcset`s get AVIF/WebP alternatives too, keeping your sizes and descriptors.
- CSS `url()` backgrounds (stylesheets, `<style>` blocks, `style=""`) gain an `image-set()`
  with AVIF/WebP, keeping the original as the fallback.
- `og:image` / `twitter:image` are resized to a 1200px JPEG, absolute when you set `site`.
- Animated GIFs become muted looping MP4 `<video>`s, often 5–20× smaller.
- EXIF orientation applied, metadata stripped, and never bigger than the original.

**Everything**

- Content-hash cache, locally and optionally **shared through S3/R2**: each asset is encoded
  once, across builds, machines and CI.
- Idempotent: running it twice gives byte-identical output.
- Markup is edited in place, not re-serialized: formatting, comments and quoting survive.
- `_headers` for Cloudflare Pages/Netlify so `/_mediakiln/*` is cached forever; an optional
  HTML report of every asset and the bytes saved.
- `--watch` for dev servers; plugins for Vite, Astro, Eleventy and Docusaurus, and
  [recipes](docs/RECIPES.md) for Next.js, SvelteKit, Nuxt, VitePress, Gatsby, Hugo and Jekyll.
- Only local files: external URLs, `data:` and `blob:` are ignored.

## Quick start

Requires Node.js 20+ and ffmpeg (with libx264) on your `PATH`.

```bash
# one-off
npx github:drk1rd/mediakiln ./dist

# pinned
npx github:drk1rd/mediakiln#v1.1.1 ./dist

# as a dev dependency (also gives you the framework plugins)
npm i -D github:drk1rd/mediakiln#v1
```

mediakiln is distributed from GitHub only. It isn't published to the npm registry.
Installing from GitHub builds the package on install via its `prepare` script.

```
mediakiln <dir> [options]

  -c, --config <file>    Config file (default: mediakiln.config.{js,mjs,json} in cwd)
  --base <path>          Public base path the site is served from (default: "/")
  --site <url>           Public origin, e.g. https://example.com (absolute og:image URLs)
  --cache-dir <dir>      Cache directory (default: .mediakiln-cache)
  --no-cache             Disable cache
  --no-video             Skip video processing
  --no-images            Skip image processing
  --no-hls               Never generate HLS (faststart MP4 only)
  --concurrency <n>      Parallel image jobs (default: CPU count)
  --report               Write <outDirName>/report.html
  -w, --watch            Keep running and re-optimize when files in <dir> change
  --dry-run              Report what would change, write nothing
  --verbose              Detailed logs (ffmpeg commands, timings)
  --json                 Machine-readable summary to stdout
```

Exit codes: `0` success, `1` fatal error (bad directory, no ffmpeg when videos exist), `2`
finished but some assets failed (those elements are left untouched).

Add `.mediakiln-cache/` to your `.gitignore`.

## GitHub Action

```yaml
- run: npm run build
- uses: drk1rd/mediakiln@v1
  with:
    dir: ./dist
    # args: --base /my-repo/   # for project pages served from a sub-path
-  # deploy step (Pages, Netlify, Cloudflare, …)
```

The action installs ffmpeg if the runner lacks it, restores and saves the cache with
`actions/cache`, writes a job summary, and exposes the JSON summary as `outputs.summary`.
Inputs: `dir` (required), `args`, `cache` (default `"true"`), `node-version` (default `22`).

This repository's CI runs the action on [`examples/plain-html`](examples/plain-html), the demo
site, which is hosted on Cloudflare Pages.

## Docker

```bash
docker run --rm -v "$PWD/dist:/site" ghcr.io/drk1rd/mediakiln /site

# with a persistent cache
docker run --rm -v "$PWD/dist:/site" -v "$PWD/.mediakiln-cache:/work/.mediakiln-cache" \
  ghcr.io/drk1rd/mediakiln /site
```

## Framework plugins

All plugins take the same options as the config file and run after a production build. Other
frameworks: see [docs/RECIPES.md](docs/RECIPES.md).

**Vite**

```js
// vite.config.js
import mediakiln from "mediakiln/vite";

export default {
  plugins: [mediakiln()],
};
```

Runs in `closeBundle` on `build.outDir`, with `base` taken from Vite's `base`.

**Astro**

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import mediakiln from "mediakiln/astro";

export default defineConfig({
  integrations: [mediakiln()],
});
```

Runs on `astro:build:done`, with `base` taken from the Astro config. See
[`examples/astro`](examples/astro).

**Eleventy**

```js
// eleventy.config.js
import mediakiln from "mediakiln/eleventy";

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(mediakiln, { video: { hls: { minDurationSec: 20 } } });
}
```

Runs on `eleventy.after`. It is skipped during `--serve`/`--watch` unless you pass
`enabled: true`.

**Docusaurus**

```js
// docusaurus.config.js
export default {
  plugins: [["mediakiln/docusaurus", {}]],
};
```

Runs on `postBuild`, with `base` and `site` taken from `baseUrl` and `url`.

**Programmatic**

```js
import { optimize, watch, formatSummary } from "mediakiln";

const summary = await optimize({ dir: "dist", base: "/" });
console.log(formatSummary(summary));

const watcher = watch({ dir: "dist", onRun: (s) => console.log(formatSummary(s)) });
// later: await watcher.close();
```

## Configuration

`mediakiln.config.js` (or `.mjs`/`.json`) in the working directory. Every field is optional;
these are the defaults:

```js
/** @type {import('mediakiln').Config} */
export default {
  base: "/",
  site: "", // e.g. "https://example.com": makes og:image URLs absolute
  outDirName: "_mediakiln", // generated assets go to <dir>/_mediakiln/<hash>/
  include: ["**/*.html"],
  exclude: [],
  keepOriginals: true, // false deletes source media the pages no longer reference
  cache: true,
  cacheDir: ".mediakiln-cache",
  remoteCache: null, // { bucket, endpoint?, region?, prefix?, write? }: see below
  concurrency: os.availableParallelism(), // parallel image jobs; videos encode one at a time
  headers: true, // write a _headers rule (Cloudflare Pages / Netlify) caching /_mediakiln/*
  report: false, // write _mediakiln/report.html
  markdown: { enabled: false, include: ["**/*.md"] }, // experimental

  video: {
    enabled: true,
    encoder: "software", // "software" | "videotoolbox" | "nvenc" | "auto"
    hls: {
      enabled: true,
      minDurationSec: 10, // HLS when duration ≥ this…
      minSizeMB: 5, //     …or file size ≥ this
      segmentSec: 4,
      firstSegmentSec: 1, // shorter first segment = faster start (0 = off)
      segmentType: "fmp4", // "fmp4" (CMAF) | "mpegts"
      codecs: ["h264"], // add "hevc" and/or "av1" for extra renditions
      perTitle: false, // scale bitrates to each video's complexity
      renditions: [
        // "height" is the short side; renditions larger than the source are skipped
        { height: 360, videoKbps: 800, audioKbps: 96 },
        { height: 720, videoKbps: 2800, audioKbps: 128 },
        { height: 1080, videoKbps: 5000, audioKbps: 128 },
      ],
    },
    mp4: {
      reencode: "auto", // "auto" | "always" | "never" (never = remux only)
      crf: 23,
      preset: "medium",
      maxHeight: 1080,
    },
    poster: { atSec: 1, format: "webp", quality: 80, keepJpeg: false },
    preload: "metadata", // for eager (non-lazy) videos
    lazy: true,
    captions: true, // put local <track> WebVTT into the HLS stream
    thumbnails: { enabled: false, intervalSec: 5, width: 160, columns: 10 },
  },

  images: {
    enabled: true,
    formats: ["avif", "webp"], // plus JPEG/PNG fallback
    widths: [480, 768, 1080, 1600, 2400],
    quality: { avif: 50, webp: 75, jpeg: 78, png: 80 },
    sizes: "100vw", // default sizes attribute
    lazy: true,
    skip: ["**/*.svg"], // globs (relative to the site) to leave alone
    gifToVideo: true, // animated GIFs → muted looping MP4 <video> (needs ffmpeg)
    pictures: true, // optimize <img> inside existing <picture>, art direction included
    srcset: true, // add AVIF/WebP to existing local srcsets
    css: { enabled: true, include: ["**/*.css"] }, // url() backgrounds → image-set()
    openGraph: true, // og:image / twitter:image → 1200px JPEG
  },
};
```

Unknown keys produce a warning; invalid values fail with a clear message. Wrap your config in
`defineConfig` from `mediakiln` for editor completion.

### Per-element attributes

| Attribute           | Effect                                  |
| ------------------- | --------------------------------------- |
| `data-mk-skip`      | Leave this element completely untouched |
| `data-mk-eager`     | Don't lazy-load (use on hero/LCP media) |
| `data-mk-no-hls`    | MP4 only for this video                 |
| `data-mk-sizes="…"` | Override `sizes` for this image         |

`data-mk-eager`, `data-mk-no-hls` and `data-mk-sizes` are removed from the output.
`data-mk-hls`, `data-mk-lazy`, `data-mk-thumbnails` and `data-mk-in-hls` (on `<track>`) are
added for the runtime and players.

### Shared cache (S3, R2, MinIO)

```js
export default {
  remoteCache: {
    bucket: "my-media-cache",
    endpoint: "https://<account-id>.r2.cloudflarestorage.com", // omit for AWS S3
    region: "auto", // your region for AWS S3
    write: true, // false for read-only jobs, e.g. pull requests
  },
};
```

Credentials come from `MEDIAKILN_S3_ACCESS_KEY_ID` / `MEDIAKILN_S3_SECRET_ACCESS_KEY` or the
standard `AWS_*` variables. Lookups go site → local cache → remote → encode.

## How it works

```
your build → dist/ (raw media) → mediakiln → dist/ (optimized) → any host / CDN
                                    │
                         ffmpeg + Sharp, at build time
```

Input:

```html
<video src="/media/demo.mp4" controls></video> <img src="/img/hero.jpg" alt="Hero" />
```

Output:

```html
<video
  controls
  preload="none"
  width="1920"
  height="1080"
  poster="/_mediakiln/a1b2c3d4e5f6/poster.webp"
  data-mk-hls="/_mediakiln/a1b2c3d4e5f6/hls/master.m3u8"
  data-mk-lazy
>
  <source src="/_mediakiln/a1b2c3d4e5f6/video.mp4" type="video/mp4" />
</video>

<picture>
  <source type="image/avif" srcset="/_mediakiln/9f8e…/img-480.avif 480w, …" sizes="100vw" />
  <source type="image/webp" srcset="/_mediakiln/9f8e…/img-480.webp 480w, …" sizes="100vw" />
  <img
    src="/_mediakiln/9f8e…/img-1080.jpg"
    srcset="… 480w, … 1080w, …"
    sizes="100vw"
    alt="Hero"
    width="2400"
    height="1350"
    loading="lazy"
    decoding="async"
  />
</picture>

<script type="module" src="/_mediakiln/runtime/loader.3fa2c1d0.js"></script>
```

All the heavy work happens at build time. In the browser, pages with videos get a ~1 KB
(gzipped) module that:

- switches lazy videos to `preload="metadata"` when they come within 200px of the viewport,
- attaches HLS: natively where supported, otherwise it `import()`s the self-hosted hls.js
  (only on pages that need it, at most once), with the MP4 as fallback on errors or when Media
  Source Extensions are missing,
- removes a `<track>` once the player shows the same captions from the stream, so they're never
  listed twice,
- doesn't auto-play when the visitor prefers reduced motion.

Without JavaScript, the MP4 `<source>` still plays.

Generated files live in `<dir>/_mediakiln/<hash>/` (content-addressed) and
`_mediakiln/runtime/` (versioned file names), so all of it is safe to cache forever.
`_mediakiln/manifest.json` lists every source, its outputs and the bytes saved.

## Hosting notes

HLS needs `.m3u8` served as `application/vnd.apple.mpegurl`, `.m4s` as `video/iso.segment`
(or `video/mp4`) and `.ts` as `video/mp2t`. GitHub Pages, Netlify, Vercel and Cloudflare Pages
already do. Cloudflare Pages and Netlify also pick up the `_headers` file mediakiln writes;
for Vercel see [recipes](docs/RECIPES.md#hosting).

nginx:

```nginx
types {
  application/vnd.apple.mpegurl m3u8;
  video/iso.segment m4s;
  video/mp2t ts;
}
location /_mediakiln/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}
```

Apache (`.htaccess`):

```apache
AddType application/vnd.apple.mpegurl .m3u8
AddType video/iso.segment .m4s
AddType video/mp2t .ts
<IfModule mod_headers.c>
  <If "%{REQUEST_URI} =~ m#^/_mediakiln/#">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </If>
</IfModule>
```

## Benchmarks

See [docs/BENCHMARKS.md](docs/BENCHMARKS.md) for methodology and full numbers, and
`npx tsx scripts/bench.mts` to reproduce them.

On a test page with a background loop, a 30 s 1080p video, three 12 MP photos and a
screenshot (synthetic media, so treat image savings as an upper bound):

|                                                              | Raw           | mediakiln          |
| ------------------------------------------------------------ | ------------- | ------------------ |
| Lighthouse performance (mobile)                              | 72            | **100**            |
| Largest Contentful Paint                                     | 62.5 s        | **1.65 s**         |
| Cumulative Layout Shift                                      | 0.114         | **0**              |
| Page weight                                                  | 18.7 MB       | 11.7 MB            |
| Video played in the first 10 s at 6 Mbps (Chromium / WebKit) | 3.2 s / 0 s   | **8.9 s / 8.9 s**  |
| Time to first frame at 6 Mbps (Chromium / WebKit)            | 1426 / 991 ms | **346 / 485 ms**   |
| Time to first frame at 20 Mbps (Chromium / WebKit)           | 336 / 384 ms  | **133 / 240 ms**   |
| mediakiln run time: first run → re-run with warm cache       |               | 12.1 s → **65 ms** |

The trade-off: if a visitor's fast connection has already preloaded the raw file, its first
frame comes sooner than lazy HLS. The benchmarks page has the details and the `data-mk-eager` /
`data-mk-no-hls` escape hatches.

## FAQ

**Why not Mux, Cloudinary or Cloudflare Stream?** They're great if you want a managed
service. mediakiln is for when you'd rather keep video as static files next to the rest of
your site: no account, no per-minute billing, no vendor URLs in your markup, and it works
offline and in CI.

**Does it run in the browser?** No. All encoding happens at build time. The only thing that
ships is the ~1 KB loader (plus hls.js on pages with HLS, in browsers without native HLS).

**CI is slow?** The first run encodes everything; after that the content-hash cache makes
unchanged media free. The GitHub Action caches `.mediakiln-cache` for you; for teams and
multiple runners, share it with `remoteCache`. Hardware encoding (`video.encoder`) can help
on machines with weak CPUs; on fast ones software x264 is often quicker (see the benchmarks).

**Should I enable HEVC/AV1?** They cut bandwidth by roughly a third to a half for browsers that
support them, at the cost of much longer encodes. A good fit for a handful of hero videos and
a warm cache; less so for hundreds of clips on every CI run.

**Can I keep my original files?** Yes, by default (`keepOriginals: true`). The rewritten
markup just stops pointing at them. With `false`, files still used as fallbacks (existing
`srcset`s, CSS) are kept.

**What about GIFs?** Animated GIFs in `<img>` become muted looping videos. Transparency is lost
in the conversion, so put `data-mk-skip` on GIFs that rely on it. GIFs in CSS stay as they are.

**Licensing of ffmpeg and H.264?** mediakiln doesn't bundle ffmpeg. ffmpeg builds with
libx264/libx265 are GPL-licensed, and H.264/HEVC are patent-encumbered in some jurisdictions;
you're responsible for your own use. hls.js (Apache-2.0) is copied into your output along
with its license notice.

## Development

```bash
npm install
npm run build
npm test            # unit + integration (generates media with ffmpeg)
npm run test:e2e    # Playwright (npx playwright install chromium webkit)
npm run lint && npm run typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Design notes and every deviation from the original
spec are in [docs/DECISIONS.md](docs/DECISIONS.md); what's next is in
[ROADMAP.md](ROADMAP.md); releases are described in [docs/RELEASING.md](docs/RELEASING.md).

## License

[MIT](LICENSE)
