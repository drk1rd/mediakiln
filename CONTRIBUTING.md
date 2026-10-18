# Contributing

Bug reports, fixes and features are all welcome. For anything bigger than a small fix, open an
issue first so we can agree on the approach before you spend time on it. Design decisions and
the reasons behind them are in [docs/DECISIONS.md](docs/DECISIONS.md); it's worth a read before
changing how something works.

## Setup

You need Node.js 22+ (the CLI supports 20, but the dev toolchain needs 22) and ffmpeg with
libx264 on your `PATH`.

```bash
git clone https://github.com/drk1rd/mediakiln.git
cd mediakiln
npm install         # also builds dist/ via the prepare script
```

Run your local build against a site with `node dist/cli.js ./path/to/site --verbose`. The
example in `examples/plain-html` is a quick one: `bash examples/plain-html/build.sh`, then
`node dist/cli.js examples/plain-html/_site`.

## Tests

```bash
npm run lint && npm run typecheck
npm test            # unit + integration
npm run test:e2e    # Playwright, in Chromium and WebKit
```

The integration tests and the e2e setup call the real `ffmpeg` binary to generate their test
media and to encode it, so they fail without it. Generated media is kept in `test/.tmp/media`
and reused on later runs; delete that folder if you change what `test/helpers/genMedia.ts`
generates.

The e2e tests build the package, optimize the fixture site and serve it on port 4321, then check
playback and lazy loading in real browsers. Install the browsers once:

```bash
npx playwright install chromium webkit
```

On Linux, add `--with-deps` to also install the system libraries they need. WebKit matters
here: it's the browser that plays HLS natively instead of through hls.js.

CI runs all of the above on every pull request, plus a Node 20 smoke test, the GitHub Action,
the Astro example and the Docker image.

## The cache version

Cache entries are keyed on the input's content and the settings used, plus
`MEDIAKILN_CACHE_VERSION` in [`src/assets.ts`](src/assets.ts). The key does not include the
mediakiln, ffmpeg or Sharp version, so a change to the code alone does not invalidate anything:
users would keep getting the old output from their cache.

Bump `MEDIAKILN_CACHE_VERSION` (it's a string; increment the number) when a change alters the
output for the same input and settings, for example a different encoder argument, a new
rendition, a new output file or a changed poster, or a change to what is recorded in the
entry's `meta.json`. Changes that only affect logging or the summary don't need it. When in
doubt, bump it: the cost is one re-encode for everyone, the alternative is stale output.

## Pull requests

- Keep each pull request to one change, with tests.
- Run `npm run format` (Prettier) before committing.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for anything a user would
  notice.
- Releases are cut by the maintainer, as described in [docs/RELEASING.md](docs/RELEASING.md).

By contributing, you agree that your work is released under the [MIT License](LICENSE).
