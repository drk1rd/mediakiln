import { createHash } from "node:crypto";
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
export function hlsPaths(): { script: string; license: string; version: string } {
  const pkgDir = path.dirname(require.resolve("hls.js/package.json"));
  const { version } = require("hls.js/package.json") as { version: string };
  return {
    script: path.join(pkgDir, "dist/hls.light.min.mjs"),
    license: path.join(pkgDir, "LICENSE"),
    version,
  };
}

export interface RuntimeBundle {
  /** File name of the loader, content-hashed: `loader.<hash>.js`. */
  loader: string;
  /** File name of hls.js, versioned: `hls.light.<version>.min.js`. */
  hls: string;
  loaderCode: string;
}

let bundle: Promise<RuntimeBundle> | undefined;

/**
 * Versioned runtime file names, so everything under the output folder can be cached as
 * immutable: a new mediakiln release produces new file names instead of changing old ones.
 */
export function runtimeBundle(): Promise<RuntimeBundle> {
  bundle ??= (async () => {
    const hls = `hls.light.${hlsPaths().version}.min.js`;
    const loaderCode = (await fs.readFile(runtimeLoaderPath(), "utf8")).replace(
      /hls\.light\.min\.js/g,
      hls,
    );
    const hash = createHash("sha256").update(loaderCode).digest("hex").slice(0, 8);
    return { loader: `loader.${hash}.js`, hls, loaderCode };
  })();
  return bundle;
}

/**
 * Copy the runtime into `<dir>/<outDirName>/runtime/`: the loader, hls.js (the ES module
 * build, so the loader can `import()` it) and hls.js's Apache-2.0 license notice.
 */
export async function copyRuntime(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  const hls = hlsPaths();
  const b = await runtimeBundle();
  await Promise.all([
    fs.writeFile(path.join(target, b.loader), b.loaderCode),
    fs.copyFile(hls.script, path.join(target, b.hls)),
    fs.copyFile(hls.license, path.join(target, "LICENSE-hls.js.txt")),
  ]);
}
