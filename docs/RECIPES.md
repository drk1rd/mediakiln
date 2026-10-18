# Recipes

mediakiln works on any folder of built HTML. Frameworks with a build hook get a plugin; for
everything else, run the CLI after the build. Install it once as a dev dependency so builds
don't fetch it every time:

```bash
npm i -D github:drk1rd/mediakiln#v1
```

| Framework / host             | Output folder      | How                                                       |
| ---------------------------- | ------------------ | --------------------------------------------------------- |
| Vite                         | `dist/`            | `mediakiln/vite` plugin                                   |
| Astro                        | `dist/`            | `mediakiln/astro` integration                             |
| Eleventy                     | `_site/`           | `mediakiln/eleventy` plugin                               |
| Docusaurus                   | `build/`           | `mediakiln/docusaurus` plugin                             |
| Next.js (`output: "export"`) | `out/`             | `"build": "next build && mediakiln out"`                  |
| SvelteKit (`adapter-static`) | `build/`           | `"build": "vite build && mediakiln build"`                |
| Nuxt (`nuxi generate`)       | `.output/public/`  | `"generate": "nuxi generate && mediakiln .output/public"` |
| VitePress                    | `.vitepress/dist/` | `"build": "vitepress build && mediakiln .vitepress/dist"` |
| Gatsby                       | `public/`          | `"build": "gatsby build && mediakiln public"`             |
| Hugo                         | `public/`          | `hugo && npx mediakiln public`                            |
| Jekyll                       | `_site/`           | `bundle exec jekyll build && npx mediakiln _site`         |
| Plain HTML                   | wherever it is     | `npx github:drk1rd/mediakiln ./site`                      |

Notes:

- **SvelteKit**: use the CLI, not `mediakiln/vite`. `adapter-static` writes the final pages
  after Vite's build hooks have run.
- **Sub-path deploys** (GitHub project pages, `basePath`, `base`, `baseURL`): pass the same
  path with `--base /my-path/`. The plugins read it from the framework config.
- **Social previews**: set `site` (`--site https://example.com`) so `og:image` URLs come out
  absolute, as Open Graph requires.

## Docusaurus

```js
// docusaurus.config.js
export default {
  plugins: [["mediakiln/docusaurus", { report: true }]],
};
```

`baseUrl` and `url` come from your Docusaurus config.

## Hosting

| Host                           | Notes                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Pages, Netlify      | mediakiln writes a `_headers` rule caching `/_mediakiln/*` for a year (`headers: false` to disable). Build command: your build plus `&& npx mediakiln <out>`; make sure the build image has ffmpeg, or build in CI and upload. |
| GitHub Pages                   | Use the [GitHub Action](../README.md#github-action) before `actions/upload-pages-artifact`; pass `--base /<repo>/` for project pages.                                                                                          |
| Vercel                         | Add to `vercel.json`: `{"headers":[{"source":"/_mediakiln/(.*)","headers":[{"key":"Cache-Control","value":"public, max-age=31536000, immutable"}]}]}`                                                                          |
| S3 + CloudFront, nginx, Apache | See [hosting notes](../README.md#hosting-notes) for MIME types and cache headers.                                                                                                                                              |

## Teams and CI: share the cache

Point `remoteCache` at any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Backblaze B2).
Every machine then encodes each asset once:

```js
// mediakiln.config.js
export default {
  remoteCache: {
    bucket: "my-media-cache",
    endpoint: "https://<account-id>.r2.cloudflarestorage.com", // omit for AWS S3
    region: "auto", // your AWS region for S3
    prefix: "mediakiln/",
    write: process.env.CI_BRANCH === "main", // e.g. read-only on pull requests
  },
};
```

Credentials come from `MEDIAKILN_S3_ACCESS_KEY_ID` / `MEDIAKILN_S3_SECRET_ACCESS_KEY`, or the
standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (`AWS_SESSION_TOKEN` is honoured).

## Dev servers

`mediakiln --watch <out>` re-optimizes whenever the output changes, e.g. next to
`eleventy --serve` or `hugo server --renderToDisk`. Cached assets make re-runs near-instant.

## Markdown sources (experimental)

With `markdown: { enabled: true }`, `.md` files under `<dir>` are rewritten in place:
`![alt](photo.jpg)` becomes a responsive `<picture>`, `![](clip.mp4)` becomes an optimized
`<video>`, and raw HTML media in the Markdown gets the usual treatment. Code blocks are never
touched. Use it on content folders whose media lives next to the Markdown (Hugo page bundles,
docs folders), pointing `<dir>` at the folder that is served as the site root.
