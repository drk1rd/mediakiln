# Astro example

```bash
npm run build --prefix ../..   # build mediakiln itself (dist/)
npm install
npm run build                  # generates demo media, runs astro build + mediakiln
npm run preview
```

The integration is one line in [`astro.config.mjs`](astro.config.mjs). In your own project,
install mediakiln from GitHub instead of `file:../..`:

```bash
npm i -D github:drk1rd/mediakiln#v1
```
