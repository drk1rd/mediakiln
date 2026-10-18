# Design decisions and spec deviations

Notes on places where the implementation differs from, or fills gaps in, the original build spec.

## Tooling

- **TypeScript 6.0, not 7.** TypeScript 7 (the native port) is current, but `typescript-eslint`
  only supports `<6.1`. We stay on 6.0 until the lint toolchain catches up.
- **`tinyglobby` + `picomatch`** for globbing. `fs.glob` is not available on Node 20.
- **Config gains `cache`, `cacheDir` and `concurrency`.** The CLI flags `--no-cache`, `--cache-dir`
  and `--concurrency` map onto these, so the same options work from config files and plugins.
- **Logs go to stderr, the summary too.** stdout is reserved for `--json` output so it can be piped.
