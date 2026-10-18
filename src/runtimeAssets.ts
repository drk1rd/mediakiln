import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Locate the built runtime loader: next to the bundle in dist/, or in dist/ from src/. */
export function runtimeLoaderPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "runtime/loader.js"), // dist/chunk-*.js → dist/runtime/loader.js
    path.join(here, "../dist/runtime/loader.js"), // src/*.ts → dist/runtime/loader.js
    path.join(here, "../../dist/runtime/loader.js"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      "mediakiln runtime loader not found. Run `npm run build` (dist/runtime/loader.js).",
    );
  }
  return found;
}

/** hls.js ESM build plus its license. */
export function hlsPaths(): { script: string; license: string } {
  const pkgDir = path.dirname(require.resolve("hls.js/package.json"));
  return {
    script: path.join(pkgDir, "dist/hls.light.min.mjs"),
    license: path.join(pkgDir, "LICENSE"),
  };
}

/**
 * Copy the runtime into `<dir>/<outDirName>/runtime/`: loader.js, hls.light.min.js (the ES
 * module build, so the loader can `import()` it) and hls.js's Apache-2.0 license notice.
 */
export async function copyRuntime(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  const hls = hlsPaths();
  await Promise.all([
    fs.copyFile(runtimeLoaderPath(), path.join(target, "loader.js")),
    fs.copyFile(hls.script, path.join(target, "hls.light.min.js")),
    fs.copyFile(hls.license, path.join(target, "LICENSE-hls.js.txt")),
  ]);
}
