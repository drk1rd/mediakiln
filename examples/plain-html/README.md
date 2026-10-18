# Plain HTML example

A static page with raw media, optimized by mediakiln and deployed to GitHub Pages by
[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml) using the mediakiln action.

```bash
bash examples/plain-html/build.sh            # generates _site/ with raw media (needs ffmpeg)
npx github:drk1rd/mediakiln examples/plain-html/_site
npx serve examples/plain-html/_site          # or any static server
```
