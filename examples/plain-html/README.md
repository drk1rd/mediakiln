# Plain HTML example

A static page with raw media that shows off every mediakiln feature: HLS in H.264 and HEVC
with per-title bitrates, captions inside the stream, thumbnails, a GIF turned into video, a CSS
background with `image-set()`, `og:image` and the build report. It's hosted on Cloudflare Pages.

Build the finished site (needs ffmpeg) and upload the folder:

```bash
npm run build                                   # build mediakiln itself
bash examples/plain-html/build-site.sh          # → examples/plain-html/site/
MEDIAKILN_SITE=https://<project>.pages.dev bash examples/plain-html/build-site.sh  # absolute og:image
npx wrangler pages deploy examples/plain-html/site --project-name <project>
```

Or step by step:

```bash
bash examples/plain-html/build.sh            # generates _site/ with raw media (needs ffmpeg)
npx github:drk1rd/mediakiln examples/plain-html/_site
npx serve examples/plain-html/_site          # or any static server
```
