import { promises as fs } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { glob } from "tinyglobby";
import { RASTER_EXTENSIONS, VIDEO_EXTENSIONS } from "./assets.js";
import type { ResolvedConfig } from "./config.js";
import { gifInfo } from "./ffmpeg/gif.js";
import { childElements, getAttr, hasAttr, parseHtml, walkElements, type Element } from "./html.js";
import { resolveUrl, type ResolveContext } from "./resolve.js";
import type { CaptionTrack } from "./ffmpeg/captions.js";
import { parseSrcset } from "./srcset.js";
import { findMarkdownImages, maskMarkdownCode, type MarkdownImage } from "./markdown.js";
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
  /** Local WebVTT `<track>` children (subtitles/captions) that can go into the HLS stream. */
  tracks: Array<CaptionTrack & { el: Element }>;
}

/** A local animated GIF in an `<img>`, to become a looping muted `<video>`. */
export interface GifRef {
  el: Element;
  file: string;
  /** Load right away (`data-mk-eager`, `fetchpriority="high"` or the first `<img>`). */
  eager: boolean;
}

export interface ImageRef {
  el: Element;
  file: string;
  /** True for the first `<img>` in the document (likely the LCP element). */
  first: boolean;
  eager: boolean;
  sizes?: string;
}

export interface Candidate {
  url: string;
  file: string;
  descriptor?: string;
}

/** An image source the author sized themselves (srcset with several candidates) or a single file. */
export type ImageSource =
  { mode: "responsive"; file: string } | { mode: "convert"; candidates: Candidate[] };

export interface PictureRef {
  el: Element;
  img: Element;
  imgSource: ImageSource;
  sources: Array<{ el: Element; source: ImageSource }>;
  first: boolean;
  eager: boolean;
  sizes?: string;
}

/** An `<img srcset>` (outside <picture>) whose candidates are all local raster files. */
export interface SrcsetRef {
  el: Element;
  candidates: Candidate[];
  /** The file `src` points at, when it is one of the candidates or another local file. */
  srcFile?: string;
  first: boolean;
  eager: boolean;
}

export interface OgRef {
  el: Element;
  file: string;
  /** og:image (gets width/height metas) vs twitter:image. */
  openGraph: boolean;
}

export interface StyleRef {
  el: Element;
  kind: "attr" | "block";
  css: string;
  /** Source offsets of the CSS text (block) — attributes are rebuilt via the start tag. */
  start: number;
  end: number;
}

export interface MarkdownMediaRef extends MarkdownImage {
  file: string;
  kind: "image" | "video";
  first: boolean;
}

export interface PageScan {
  file: string;
  rel: string;
  html: string;
  videos: VideoRef[];
  images: ImageRef[];
  gifs: GifRef[];
  pictures: PictureRef[];
  srcsets: SrcsetRef[];
  og: OgRef[];
  styles: StyleRef[];
  /** `![alt](src)` media in Markdown pages. */
  markdown: MarkdownMediaRef[];
  /** og:image:width / og:image:height metas already present. */
  ogHasDims: boolean;
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
  const include = config.markdown.enabled
    ? [...config.include, ...config.markdown.include]
    : config.include;
  const files = await glob(include, {
    cwd: dir,
    ignore: [...config.exclude, `${config.outDirName}/**`, "**/node_modules/**"],
    onlyFiles: true,
    dot: false,
  });
  return files.sort().map((f) => path.join(dir, f));
}

export async function findStylesheets(dir: string, config: ResolvedConfig): Promise<string[]> {
  const files = await glob(config.images.css.include, {
    cwd: dir,
    ignore: [...config.exclude, `${config.outDirName}/**`, "**/node_modules/**"],
    onlyFiles: true,
  });
  return files.sort().map((f) => path.join(dir, f));
}

export function runtimeScriptPath(config: ResolvedConfig, loader: string): string {
  return `${config.outDirName}/runtime/${loader}`;
}

/** Any version of the runtime loader script, e.g. `_mediakiln/runtime/loader.3fa2c1d0.js`. */
export function isRuntimeScript(src: string, config: ResolvedConfig): boolean {
  const escaped = config.outDirName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}/runtime/loader(\\.[0-9a-f]+)?\\.js$`).test(cleanPath(src));
}

/** Parse one page and collect the media elements mediakiln should process. */
export async function scanPage(file: string, ctx: ScanContext): Promise<PageScan> {
  const html = await fs.readFile(file, "utf8");
  const isMarkdown = /\.mdx?$/i.test(file);
  // In Markdown, only raw HTML outside code is parsed; masking keeps every offset intact.
  const masked = isMarkdown ? maskMarkdownCode(html) : html;
  const doc = parseHtml(masked);
  const { config, logger } = ctx;
  const rel = toPosix(path.relative(ctx.dir, file));
  const outRoot = path.join(ctx.dir, config.outDirName) + path.sep;
  const skipImage = picomatch(config.images.skip, { dot: true });

  const page: PageScan = {
    file,
    rel,
    html,
    videos: [],
    images: [],
    gifs: [],
    pictures: [],
    srcsets: [],
    og: [],
    styles: [],
    markdown: [],
    ogHasDims: false,
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

  const isRaster = (f: string | undefined): f is string =>
    f !== undefined && RASTER_EXTENSIONS.has(path.extname(f).toLowerCase());

  /** Resolve every srcset candidate; undefined unless all are local, existing raster images. */
  const localCandidates = async (srcset: string): Promise<Candidate[] | undefined> => {
    const list = parseSrcset(srcset);
    if (list.length === 0) return undefined;
    const out: Candidate[] = [];
    for (const c of list) {
      const f = resolveLocal(c.url);
      if (!isRaster(f) || isOurs(f) || skipImage(toPosix(path.relative(ctx.dir, f))))
        return undefined;
      if (!(await exists(f))) return undefined;
      out.push({ url: c.url, file: f, ...(c.descriptor ? { descriptor: c.descriptor } : {}) });
    }
    return out;
  };

  /** A single bare (or w-described) candidate is resized responsively; anything else converted. */
  const toSource = (cands: Candidate[]): ImageSource =>
    cands.length === 1 && (!cands[0]!.descriptor || /w$/.test(cands[0]!.descriptor))
      ? { mode: "responsive", file: cands[0]!.file }
      : { mode: "convert", candidates: cands };

  const siteOrigin = config.site;
  const imgOpts = config.images;

  let seenImg = false;
  for (const el of walkElements(doc)) {
    // Inline style attributes with url() backgrounds.
    if (
      imgOpts.enabled &&
      imgOpts.css.enabled &&
      !hasAttr(el, "data-mk-skip") &&
      !REWRITTEN_TAGS.has(el.tagName)
    ) {
      const style = getAttr(el, "style");
      if (style && /url\(/i.test(style)) {
        page.styles.push({ el, kind: "attr", css: style, start: 0, end: 0 });
      }
    }
    switch (el.tagName) {
      case "style": {
        if (!imgOpts.enabled || !imgOpts.css.enabled || hasAttr(el, "data-mk-skip")) break;
        const text = el.childNodes[0];
        const loc = text && "sourceCodeLocation" in text ? text.sourceCodeLocation : undefined;
        if (!loc || !("value" in text!)) break;
        const css = html.slice(loc.startOffset, loc.endOffset);
        if (/url\(/i.test(css)) {
          page.styles.push({ el, kind: "block", css, start: loc.startOffset, end: loc.endOffset });
        }
        break;
      }
      case "meta": {
        const key = (getAttr(el, "property") ?? getAttr(el, "name") ?? "").toLowerCase();
        if (key === "og:image:width" || key === "og:image:height") page.ogHasDims = true;
        if (!imgOpts.enabled || !imgOpts.openGraph || hasAttr(el, "data-mk-skip")) break;
        if (!OG_KEYS.has(key)) break;
        let content = getAttr(el, "content")?.trim();
        if (!content) break;
        // Absolute URLs on the site's own origin are local files too.
        if (siteOrigin && content.startsWith(siteOrigin + "/"))
          content = content.slice(siteOrigin.length);
        const f = resolveLocal(content);
        if (!isRaster(f) || isOurs(f) || !(await exists(f))) break;
        page.og.push({ el, file: f, openGraph: key.startsWith("og:") });
        break;
      }
      case "picture": {
        if (!imgOpts.enabled || !imgOpts.pictures || hasAttr(el, "data-mk-skip")) break;
        const kids = childElements(el);
        const img = kids.find((k) => k.tagName === "img");
        if (!img || hasAttr(img, "data-mk-skip")) break;
        const sourceEls = kids.filter((k) => k.tagName === "source");
        // Typed sources mean the author (or a previous run) already ships modern formats.
        if (sourceEls.some((k) => getAttr(k, "type")?.trim())) break;
        const sources: PictureRef["sources"] = [];
        let ok = true;
        for (const k of sourceEls) {
          const cands = await localCandidates(getAttr(k, "srcset") ?? "");
          if (!cands) {
            ok = false;
            break;
          }
          sources.push({ el: k, source: toSource(cands) });
        }
        if (!ok) break;
        const imgSrcset = getAttr(img, "srcset");
        let imgSource: ImageSource | undefined;
        if (imgSrcset) {
          const cands = await localCandidates(imgSrcset);
          if (cands) imgSource = toSource(cands);
        } else {
          const f = resolveLocal(getAttr(img, "src"));
          if (
            isRaster(f) &&
            !isOurs(f) &&
            !skipImage(toPosix(path.relative(ctx.dir, f))) &&
            (await exists(f))
          ) {
            imgSource = { mode: "responsive", file: f };
          }
        }
        if (!imgSource) break;
        page.pictures.push({
          el,
          img,
          imgSource,
          sources,
          first: !seenImg,
          eager: hasAttr(img, "data-mk-eager") || getAttr(img, "fetchpriority") === "high",
          sizes: getAttr(img, "data-mk-sizes"),
        });
        break;
      }
      case "body": {
        const end = el.sourceCodeLocation?.endTag?.startOffset;
        if (end !== undefined) page.injectAt = end;
        break;
      }
      case "script": {
        const src = getAttr(el, "src");
        if (src && isRuntimeScript(src, config)) page.hasRuntime = true;
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

        const tracks: VideoRef["tracks"] = [];
        for (const t of childElements(el).filter((c) => c.tagName === "track")) {
          const kind = (getAttr(t, "kind") ?? "subtitles").toLowerCase();
          if (kind !== "subtitles" && kind !== "captions") continue;
          const src = getAttr(t, "src");
          const f = resolveLocal(src);
          if (!f || path.extname(f).toLowerCase() !== ".vtt" || !(await exists(f))) continue;
          tracks.push({
            el: t,
            file: f,
            kind,
            srclang: getAttr(t, "srclang"),
            label: getAttr(t, "label"),
            default: hasAttr(t, "default"),
          });
        }

        page.videos.push({
          el,
          file: primary,
          localSources,
          tracks,
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
        if (el.parentNode && "tagName" in el.parentNode && el.parentNode.tagName === "picture") {
          break; // handled (or deliberately left alone) by the <picture> case
        }
        const srcsetAttr = getAttr(el, "srcset");
        if (srcsetAttr !== undefined) {
          if (!imgOpts.srcset) break;
          const cands = await localCandidates(srcsetAttr);
          if (!cands) break;
          const srcFile = resolveLocal(getAttr(el, "src"));
          page.srcsets.push({
            el,
            candidates: cands,
            srcFile: isRaster(srcFile) && (await exists(srcFile)) ? srcFile : undefined,
            first,
            eager: hasAttr(el, "data-mk-eager") || getAttr(el, "fetchpriority") === "high",
          });
          break;
        }
        const src = getAttr(el, "src");
        const f = resolveLocal(src);
        if (!f || isOurs(f)) break;
        const ext = path.extname(f).toLowerCase();
        const isGif = ext === ".gif" && config.images.gifToVideo && config.video.enabled;
        if (!isGif && !RASTER_EXTENSIONS.has(ext)) break;
        if (skipImage(toPosix(path.relative(ctx.dir, f)))) break;
        if (await missing(f, src ?? "", "image")) break;
        const eager = hasAttr(el, "data-mk-eager") || getAttr(el, "fetchpriority") === "high";
        if (isGif) {
          if (await isAnimated(f)) page.gifs.push({ el, file: f, eager: eager || first });
          else logger.debug(`${rel}: "${src}" is a single-frame GIF, leaving it as an image`);
          break;
        }
        page.images.push({ el, file: f, first, eager, sizes: getAttr(el, "data-mk-sizes") });
        break;
      }
    }
  }
  if (isMarkdown) {
    for (const img of findMarkdownImages(masked)) {
      const f = resolveLocal(img.url);
      if (!f || isOurs(f) || !(await exists(f))) continue;
      const ext = path.extname(f).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext) && config.video.enabled) {
        page.markdown.push({ ...img, file: f, kind: "video", first: false });
      } else if (
        isRaster(f) &&
        config.images.enabled &&
        !skipImage(toPosix(path.relative(ctx.dir, f)))
      ) {
        page.markdown.push({ ...img, file: f, kind: "image", first: !seenImg });
        seenImg = true;
      }
    }
  }
  return page;
}

/** Elements whose start tag other rules may rewrite; their style attributes are left alone. */
const REWRITTEN_TAGS = new Set(["img", "video", "source", "meta", "picture"]);

const OG_KEYS = new Set([
  "og:image",
  "og:image:url",
  "og:image:secure_url",
  "twitter:image",
  "twitter:image:src",
]);

async function isAnimated(file: string): Promise<boolean> {
  try {
    return (await gifInfo(file)).frames > 1;
  } catch {
    return false; // unreadable: leave the <img> alone
  }
}

function cleanPath(url: string): string {
  return url.trim().replace(/[?#].*$/, "");
}
