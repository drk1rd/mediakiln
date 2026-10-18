import { promises as fs } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { glob } from "tinyglobby";
import { RASTER_EXTENSIONS, VIDEO_EXTENSIONS } from "./assets.js";
import type { ResolvedConfig } from "./config.js";
import { childElements, getAttr, hasAttr, parseHtml, walkElements, type Element } from "./html.js";
import { resolveUrl, type ResolveContext } from "./resolve.js";
import { exists, toPosix } from "./util/fs.js";
import type { Logger } from "./util/logger.js";

export interface VideoRef {
  el: Element;
  /** Absolute path of the source video. */
  file: string;
  /** `<source>` children that point at local video files (replaced by our MP4). */
  localSources: Element[];
  /** Absolute path of an existing local poster image, if any. */
  posterFile?: string;
  eager: boolean;
  noHls: boolean;
}

export interface ImageRef {
  el: Element;
  file: string;
  /** True for the first `<img>` in the document (likely the LCP element). */
  first: boolean;
  eager: boolean;
  sizes?: string;
}

export interface PageScan {
  file: string;
  rel: string;
  html: string;
  videos: VideoRef[];
  images: ImageRef[];
  /** A video on this page was optimized by a previous run. */
  hasProcessedVideo: boolean;
  /** The runtime loader `<script>` is already present. */
  hasRuntime: boolean;
  /** Offset to inject the runtime at: the start of `</body>`, or the end of the document. */
  injectAt: number;
}

export interface ScanContext extends ResolveContext {
  config: ResolvedConfig;
  logger: Logger;
}

export async function findPages(dir: string, config: ResolvedConfig): Promise<string[]> {
  const files = await glob(config.include, {
    cwd: dir,
    ignore: [...config.exclude, `${config.outDirName}/**`, "**/node_modules/**"],
    onlyFiles: true,
    dot: false,
  });
  return files.sort().map((f) => path.join(dir, f));
}

export function runtimeScriptPath(config: ResolvedConfig): string {
  return `${config.outDirName}/runtime/loader.js`;
}

/** Parse one page and collect the media elements mediakiln should process. */
export async function scanPage(file: string, ctx: ScanContext): Promise<PageScan> {
  const html = await fs.readFile(file, "utf8");
  const doc = parseHtml(html);
  const { config, logger } = ctx;
  const rel = toPosix(path.relative(ctx.dir, file));
  const outRoot = path.join(ctx.dir, config.outDirName) + path.sep;
  const skipImage = picomatch(config.images.skip, { dot: true });
  const runtimePath = runtimeScriptPath(config);

  const page: PageScan = {
    file,
    rel,
    html,
    videos: [],
    images: [],
    hasProcessedVideo: false,
    hasRuntime: false,
    injectAt: html.length,
  };

  const resolveLocal = (url: string | undefined) =>
    url === undefined ? undefined : resolveUrl(url, file, ctx);
  const isOurs = (f: string | undefined) => f !== undefined && f.startsWith(outRoot);

  const missing = async (f: string, url: string, what: string) => {
    if (await exists(f)) return false;
    logger.warn(`${rel}: ${what} "${url}" not found, skipping`);
    return true;
  };

  let seenImg = false;
  for (const el of walkElements(doc)) {
    switch (el.tagName) {
      case "body": {
        const end = el.sourceCodeLocation?.endTag?.startOffset;
        if (end !== undefined) page.injectAt = end;
        break;
      }
      case "script": {
        const src = getAttr(el, "src");
        if (src && cleanPath(src).endsWith(runtimePath)) page.hasRuntime = true;
        break;
      }
      case "video": {
        if (!config.video.enabled || hasAttr(el, "data-mk-skip")) break;
        const sources = childElements(el).filter((c) => c.tagName === "source");
        const srcAttr = getAttr(el, "src");
        const sourceFiles = sources.map((s) => resolveLocal(getAttr(s, "src")));
        if (
          hasAttr(el, "data-mk-hls") ||
          hasAttr(el, "data-mk-lazy") ||
          isOurs(resolveLocal(srcAttr)) ||
          sourceFiles.some(isOurs)
        ) {
          page.hasProcessedVideo = true;
          break;
        }
        const isVideoFile = (f: string | undefined): f is string =>
          f !== undefined && VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase());
        const localSources = sources.filter((_, i) => isVideoFile(sourceFiles[i]));

        let primary: string | undefined;
        let primaryUrl: string | undefined;
        if (srcAttr !== undefined && srcAttr.trim() !== "") {
          const f = resolveLocal(srcAttr);
          if (!isVideoFile(f)) break; // external or unsupported: leave the element alone
          primary = f;
          primaryUrl = srcAttr;
        } else {
          const idx = sourceFiles.findIndex(isVideoFile);
          if (idx === -1) break;
          primary = sourceFiles[idx];
          primaryUrl = getAttr(sources[idx]!, "src");
        }
        if (!primary || (await missing(primary, primaryUrl ?? "", "video"))) break;

        let posterFile: string | undefined;
        const posterUrl = getAttr(el, "poster");
        if (posterUrl) {
          const f = resolveLocal(posterUrl);
          if (f && RASTER_EXTENSIONS.has(path.extname(f).toLowerCase()) && !isOurs(f)) {
            if (!(await missing(f, posterUrl, "poster"))) posterFile = f;
          }
        }

        page.videos.push({
          el,
          file: primary,
          localSources,
          posterFile,
          eager: hasAttr(el, "data-mk-eager"),
          noHls: hasAttr(el, "data-mk-no-hls"),
        });
        break;
      }
      case "img": {
        const first = !seenImg;
        seenImg = true;
        if (!config.images.enabled || hasAttr(el, "data-mk-skip")) break;
        if (hasAttr(el, "srcset")) break; // MVP: author already provides responsive sources
        if (el.parentNode && "tagName" in el.parentNode && el.parentNode.tagName === "picture") {
          logger.debug(`${rel}: <img> already inside <picture>, skipping`);
          break;
        }
        const src = getAttr(el, "src");
        const f = resolveLocal(src);
        if (!f || isOurs(f)) break;
        if (!RASTER_EXTENSIONS.has(path.extname(f).toLowerCase())) break;
        if (skipImage(toPosix(path.relative(ctx.dir, f)))) break;
        if (await missing(f, src ?? "", "image")) break;
        page.images.push({
          el,
          file: f,
          first,
          eager: hasAttr(el, "data-mk-eager") || getAttr(el, "fetchpriority") === "high",
          sizes: getAttr(el, "data-mk-sizes"),
        });
        break;
      }
    }
  }
  return page;
}

function cleanPath(url: string): string {
  return url.trim().replace(/[?#].*$/, "");
}
