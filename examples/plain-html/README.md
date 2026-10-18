# Plain HTML example

A static page with raw media, optimized by mediakiln. CI runs the mediakiln action on it
(the `action` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).

```bash
bash examples/plain-html/build.sh            # generates _site/ with raw media (needs ffmpeg)
npx github:drk1rd/mediakiln examples/plain-html/_site
npx serve examples/plain-html/_site          # or any static server
```
