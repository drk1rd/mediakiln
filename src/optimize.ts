import { promises as fs } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import {
  convertSettingsFor,
  gifSettingsFor,
  imageSettingsFor,
  jobId,
  ogSettingsFor,
  posterSettingsFor,
  videoSettingsFor,
  type AssetJob,
  type AssetResult,
  type ConvertResult,
  type GifResult,
  type ImageResult,
  type OgResult,
  type PosterResult,
  type VideoResult,
} from "./assets.js";
import { assetKey, materialize, type Materialized } from "./cache.js";
import {
  deepMerge,
  loadConfigFile,
  resolveConfig,
  type Config,
  type ResolvedConfig,
} from "./config.js";
import { MIME_BY_FORMAT, addImageSets, findBackgroundUrls } from "./css.js";
import { findFfmpeg, type FfmpegBinaries } from "./ffmpeg/binary.js";
import { buildCaptions, captionsKey, type CaptionsResult } from "./ffmpeg/captions.js";
import { processVideo } from "./ffmpeg/video.js";
import { processGif } from "./ffmpeg/gif.js";
import { rewriteGif } from "./rewrite/gif.js";
import { writeHeaders } from "./headers.js";
import { applyEdits, attr, parseHtml, walkElements, type Edit, type Element } from "./html.js";
import { processConvert, processOg } from "./images/convert.js";
import { pickFallbackWidth, processImage, processPoster } from "./images/process.js";
import { writeManifest, type ManifestEntry } from "./manifest.js";
import { createRemoteCache, type RemoteCache } from "./remoteCache.js";
import { writeReport } from "./report.js";
import { publicUrl, resolveUrl } from "./resolve.js";
import {
  rewriteImage,
  rewritePicture,
  rewriteSrcset,
  type ConvertOutput,
  type ImageOutputs,
} from "./rewrite/image.js";
import { injectRuntime } from "./rewrite/inject.js";
import { rewriteOg, rewriteStyle, type Alternatives } from "./rewrite/meta.js";
import { rewriteVideo } from "./rewrite/video.js";
import { copyRuntime, runtimeBundle } from "./runtimeAssets.js";
import {
  findPages,
  findStylesheets,
  runtimeScriptPath,
  scanPage,
  type ImageSource,
  type PageScan,
} from "./scan.js";
import { emptySummary, type Summary } from "./summary.js";
import { isDirectory, toPosix } from "./util/fs.js";
import { createLogger, type Logger } from "./util/logger.js";
import { VERSION } from "./version.js";

export interface OptimizeOptions extends Config {
  /** Built site directory. */
  dir: string;
  /** Config file path, or `false` to skip config file discovery. */
  configFile?: string | false;
  /** Working directory for config discovery and a relative cache dir. Default: process.cwd(). */
  cwd?: string;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
  logger?: Logger;
}

interface PlannedJob {
  id: string;
  job: AssetJob;
  outcome?: Materialized<AssetResult>;
  error?: Error;
}

interface Stylesheet {
  file: string;
  rel: string;
  css: string;
  urls: string[];
}

export async function optimize(options: OptimizeOptions): Promise<Summary> {
  const started = Date.now();
  const {
    dir: dirOption,
    configFile,
    cwd = process.cwd(),
    dryRun = false,
    logger: loggerOption,
    ...overrides
  } = options;
  const logger = loggerOption ?? createLogger();
  const dir = path.resolve(cwd, dirOption);
  if (!(await isDirectory(dir))) throw new Error(`Not a directory: ${dir}`);

  const fileConfig = configFile === false ? undefined : await loadConfigFile(configFile, cwd);
  if (fileConfig) logger.debug(`config: ${fileConfig.path}`);
  const config = resolveConfig(deepMerge(fileConfig?.config ?? {}, overrides), logger);
  const outRoot = path.join(dir, config.outDirName);
  const cacheDir = config.cache ? path.resolve(cwd, config.cacheDir) : undefined;
  const remote: RemoteCache | undefined =
    config.cache && config.remoteCache ? createRemoteCache(config.remoteCache, logger) : undefined;
  const summary = emptySummary(VERSION, dirOption, dryRun);
  const resolveCtx = { dir, base: config.base };

  // 1. Scan pages and stylesheets.
  const pageFiles = await findPages(dir, config);
  summary.pages.scanned = pageFiles.length;
  const scanCtx = { ...resolveCtx, config, logger };
  const pages: PageScan[] = [];
  for (const file of pageFiles) pages.push(await scanPage(file, scanCtx));

  const sheets: Stylesheet[] = [];
  if (config.images.enabled && config.images.css.enabled) {
    for (const file of await findStylesheets(dir, config)) {
      const css = await fs.readFile(file, "utf8");
      const urls = findBackgroundUrls(css);
      if (urls.length > 0) sheets.push({ file, rel: toPosix(path.relative(dir, file)), css, urls });
    }
  }

  // 2. Plan de-duplicated jobs.
  const jobs = new Map<string, PlannedJob>();
  const plan = (job: AssetJob): PlannedJob => {
    const id = jobId(job);
    let planned = jobs.get(id);
    if (!planned) jobs.set(id, (planned = { id, job }));
    return planned;
  };
  const imageJob = (file: string) =>
    plan({ kind: "image", file, settings: imageSettingsFor(config) });
  const convertJob = (file: string) =>
    plan({ kind: "convert", file, settings: convertSettingsFor(config) });
  const planSource = (s: ImageSource) => {
    if (s.mode === "responsive") imageJob(s.file);
    else for (const c of s.candidates) convertJob(c.file);
  };

  const videoJobs = new Map<
    PageScan["videos"][number],
    { video: PlannedJob; poster?: PlannedJob }
  >();
  /** Background URL → local file, for each CSS context (page or stylesheet). */
  const cssFile = (url: string, from: string): string | undefined => {
    const f = resolveUrl(url, from, resolveCtx);
    return f && /\.(jpe?g|png|webp|avif|tiff?)$/i.test(f) && !f.startsWith(outRoot + path.sep)
      ? f
      : undefined;
  };
  for (const page of pages) {
    for (const ref of page.videos) {
      const video = plan({
        kind: "video",
        file: ref.file,
        settings: videoSettingsFor(config, { noHls: ref.noHls }),
      });
      const poster = ref.posterFile
        ? plan({ kind: "poster", file: ref.posterFile, settings: posterSettingsFor(config) })
        : undefined;
      videoJobs.set(ref, { video, poster });
    }
    for (const ref of page.images) imageJob(ref.file);
    for (const ref of page.gifs)
      plan({ kind: "gif", file: ref.file, settings: gifSettingsFor(config) });
    for (const ref of page.pictures) {
      planSource(ref.imgSource);
      for (const s of ref.sources) planSource(s.source);
    }
    for (const ref of page.srcsets) for (const c of ref.candidates) convertJob(c.file);
    for (const ref of page.og)
      plan({ kind: "og", file: ref.file, settings: ogSettingsFor(config) });
    for (const ref of page.markdown) {
      if (ref.kind === "image") imageJob(ref.file);
      else
        plan({
          kind: "video",
          file: ref.file,
          settings: videoSettingsFor(config, { noHls: false }),
        });
    }
    for (const ref of page.styles) {
      for (const url of findBackgroundUrls(ref.css, { inline: ref.kind === "attr" })) {
        const f = cssFile(url, page.file);
        if (f) convertJob(f);
      }
    }
  }
  for (const sheet of sheets) {
    for (const url of sheet.urls) {
      const f = cssFile(url, sheet.file);
      if (f) convertJob(f);
    }
  }
  // Missing files referenced from CSS are skipped quietly, like missing <img>s.
  for (const [id, j] of jobs) {
    if (j.job.kind === "convert" && !(await exists(j.job.file))) jobs.delete(id);
  }

  let all = [...jobs.values()];
  // GIFs come from <img> elements, so they are counted with images.
  const bucketOf = (j: PlannedJob) => (j.job.kind === "video" ? summary.videos : summary.images);
  const usesFfmpeg = (job: AssetJob) => job.kind === "video" || job.kind === "gif";
  if (dryRun) {
    for (const j of all) {
      const bytes = (await fs.stat(j.job.file)).size;
      bucketOf(j).processed++;
      bucketOf(j).bytesBefore += bytes;
      logger.info(`would process ${j.job.kind} ${toPosix(path.relative(dir, j.job.file))}`);
    }
    summary.pages.rewritten = pages.filter(
      (p) =>
        p.videos.length +
          p.images.length +
          p.gifs.length +
          p.pictures.length +
          p.srcsets.length +
          p.og.length +
          p.styles.length >
          0 ||
        (p.hasProcessedVideo && !p.hasRuntime),
    ).length;
    summary.stylesheets = { scanned: sheets.length, rewritten: sheets.length };
    summary.durationMs = Date.now() - started;
    return summary;
  }

  // 3. Process: one video encode at a time (ffmpeg is multithreaded), images in parallel.
  let bins: FfmpegBinaries | undefined;
  if (all.some((j) => j.job.kind === "video")) bins = await findFfmpeg();
  else if (all.some((j) => j.job.kind === "gif")) {
    // GIF conversion is a bonus: without ffmpeg, GIFs stay images as they did before.
    bins = await findFfmpeg().catch(() => undefined);
    if (!bins) {
      logger.warn("ffmpeg not found, leaving animated GIFs as images");
      all = all.filter((j) => j.job.kind !== "gif");
    }
  }
  if (all.length > 0) await cleanStaleTemps(outRoot);

  const videoLimit = pLimit(1);
  const imageLimit = pLimit(config.concurrency);
  await Promise.all(
    all.map((planned) =>
      (usesFfmpeg(planned.job) ? videoLimit : imageLimit)(() =>
        runJob(planned, { outRoot, cacheDir, remote, bins, logger, dir }),
      ),
    ),
  );

  const outUrl = (hash: string) => publicUrl(config.base, `${config.outDirName}/${hash}/`);
  const outcomeOf = (job: AssetJob) => jobs.get(jobId(job))?.outcome;
  const imageOut = (file: string): ImageOutputs | undefined => {
    const o = outcomeOf({ kind: "image", file, settings: imageSettingsFor(config) });
    return o && { result: o.meta.result as ImageResult, baseUrl: outUrl(o.meta.hash) };
  };
  const convertOut = (file: string): ConvertOutput | undefined => {
    const o = outcomeOf({ kind: "convert", file, settings: convertSettingsFor(config) });
    return o && { result: o.meta.result as ConvertResult, baseUrl: outUrl(o.meta.hash) };
  };
  const alternativesFrom =
    (from: string): Alternatives =>
    (url) => {
      const f = cssFile(url, from);
      const o = f && convertOut(f);
      if (!o || o.result.variants.length === 0) return undefined;
      return {
        modern: o.result.variants.map((v) => ({
          url: o.baseUrl + v.path,
          mime: MIME_BY_FORMAT[v.format]!,
        })),
        originalMime: MIME_BY_FORMAT[o.result.sourceFormat] ?? "image/jpeg",
      };
    };

  // 3b. Captions: wrap each HLS video's master with its page's <track>s as subtitle renditions.
  const captionsFor = new Map<PageScan["videos"][number], string>();
  if (config.video.captions && bins) {
    for (const page of pages) {
      for (const ref of page.videos) {
        const outcome = videoJobs.get(ref)!.video.outcome;
        const result = outcome?.meta.result as VideoResult | undefined;
        if (!outcome || !result?.hls || ref.tracks.length === 0) continue;
        const tracks = ref.tracks.map(({ el: _el, ...t }) => t);
        try {
          const key = await captionsKey(outcome.meta.key, tracks);
          const done = await materialize<CaptionsResult>(
            { outRoot, cacheDir, remote, key, hash: key.slice(0, 12), source: page.rel },
            (tmp) =>
              buildCaptions(
                {
                  ffprobe: bins!.ffprobe,
                  videoDir: outcome.outDir,
                  videoHash: outcome.meta.hash,
                  duration: result.duration,
                  segmentType: result.hls!.segmentType ?? "mpegts",
                  tracks,
                },
                tmp,
              ),
          );
          captionsFor.set(
            ref,
            publicUrl(config.base, `${config.outDirName}/${done.meta.hash}/master.m3u8`),
          );
        } catch (err) {
          logger.warn(`${page.rel}: captions not added to HLS: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Markdown `![alt](src)` → the same markup an equivalent HTML element would get. */
  const markdownReplacement = (ref: PageScan["markdown"][number]): string | undefined => {
    const title = ref.title !== undefined ? ` ${attr("title", ref.title)}` : "";
    if (ref.kind === "image") {
      const o = imageOut(ref.file);
      if (!o) return undefined;
      const snippet = `<img ${attr("src", ref.url)} ${attr("alt", ref.alt)}${title}>`;
      const el = snippetElement(snippet, "img");
      return applyEdits(
        snippet,
        rewriteImage(snippet, { el, file: ref.file, first: ref.first, eager: false }, o, config),
      );
    }
    const o = outcomeOf({
      kind: "video",
      file: ref.file,
      settings: videoSettingsFor(config, { noHls: false }),
    });
    if (!o) return undefined;
    const label = ref.alt ? ` ${attr("aria-label", ref.alt)}` : "";
    const snippet = `<video controls ${attr("src", ref.url)}${label}${title}></video>`;
    const el = snippetElement(snippet, "video");
    return applyEdits(
      snippet,
      rewriteVideo(
        snippet,
        { el, file: ref.file, localSources: [], tracks: [], eager: false, noHls: false },
        { result: o.meta.result as VideoResult, baseUrl: outUrl(o.meta.hash) },
        config,
      ),
    );
  };

  // 4. Rewrite pages.
  let needsRuntime = false;
  for (const page of pages) {
    const edits: Edit[] = [];
    let hasVideo = page.hasProcessedVideo;
    for (const ref of page.videos) {
      const { video, poster } = videoJobs.get(ref)!;
      if (!video.outcome) continue;
      const posterUrl =
        poster?.outcome &&
        outUrl(poster.outcome.meta.hash) + (poster.outcome.meta.result as PosterResult).file.path;
      edits.push(
        ...rewriteVideo(
          page.html,
          ref,
          {
            result: video.outcome.meta.result as VideoResult,
            baseUrl: outUrl(video.outcome.meta.hash),
            posterUrl: posterUrl || undefined,
            captionsMasterUrl: captionsFor.get(ref),
          },
          config,
        ),
      );
      hasVideo = true;
    }
    for (const ref of page.images) {
      const o = imageOut(ref.file);
      if (o) edits.push(...rewriteImage(page.html, ref, o, config));
    }
    for (const ref of page.gifs) {
      const o = outcomeOf({ kind: "gif", file: ref.file, settings: gifSettingsFor(config) });
      if (!o) continue;
      const gifEdits = rewriteGif(
        page.html,
        ref,
        { result: o.meta.result as GifResult, baseUrl: outUrl(o.meta.hash) },
        config,
      );
      edits.push(...gifEdits);
      // The runtime handles lazy loading and prefers-reduced-motion for these too.
      if (gifEdits.length > 0) hasVideo = true;
    }
    for (const ref of page.pictures) {
      const images = new Map<string, ImageOutputs>();
      const converted = new Map<string, ConvertOutput>();
      for (const s of [ref.imgSource, ...ref.sources.map((x) => x.source)]) {
        if (s.mode === "responsive") {
          const o = imageOut(s.file);
          if (o) images.set(s.file, o);
        } else {
          for (const c of s.candidates) {
            const o = convertOut(c.file);
            if (o) converted.set(c.file, o);
          }
        }
      }
      edits.push(...rewritePicture(page.html, ref, { images, converted }, config));
    }
    for (const ref of page.srcsets) {
      const converted = new Map<string, ConvertOutput>();
      for (const c of [...ref.candidates.map((x) => x.file), ref.srcFile ?? ""]) {
        const o = c && convertOut(c);
        if (o) converted.set(c, o);
      }
      edits.push(...rewriteSrcset(page.html, ref, converted, config));
    }
    let ogDims = !page.ogHasDims;
    for (const ref of page.og) {
      const o = outcomeOf({ kind: "og", file: ref.file, settings: ogSettingsFor(config) });
      if (!o) continue;
      const result = o.meta.result as OgResult;
      const addDims = ogDims && ref.openGraph;
      if (addDims) ogDims = false;
      edits.push(
        ...rewriteOg(
          page.html,
          ref,
          { result, url: outUrl(o.meta.hash) + result.file.path },
          config,
          addDims,
        ),
      );
    }
    for (const ref of page.styles)
      edits.push(...rewriteStyle(page.html, ref, alternativesFrom(page.file)));
    for (const ref of page.markdown) {
      const text = markdownReplacement(ref);
      if (text === undefined) continue;
      edits.push({ start: ref.start, end: ref.end, text });
      if (ref.kind === "video") hasVideo = true;
    }

    if (hasVideo) {
      needsRuntime = true;
      if (!page.hasRuntime) {
        const loader = (await runtimeBundle()).loader;
        edits.push(
          injectRuntime(page.html, page.injectAt, config.base, runtimeScriptPath(config, loader)),
        );
      }
    }
    if (edits.length === 0) continue;
    const html = applyEdits(page.html, edits);
    if (html !== page.html) {
      await fs.writeFile(page.file, html);
      summary.pages.rewritten++;
      logger.debug(`rewrote ${page.rel}`);
    }
  }

  // 4b. Stylesheets.
  summary.stylesheets.scanned = sheets.length;
  for (const sheet of sheets) {
    const css = addImageSets(sheet.css, alternativesFrom(sheet.file));
    if (css !== undefined && css !== sheet.css) {
      await fs.writeFile(sheet.file, css);
      summary.stylesheets.rewritten++;
      logger.debug(`rewrote ${sheet.rel}`);
    }
  }

  if (needsRuntime) await copyRuntime(path.join(outRoot, "runtime"));

  // 5. Manifest, host headers, report, originals, summary.
  const entries: ManifestEntry[] = [];
  for (const j of all) {
    const rel = toPosix(path.relative(dir, j.job.file));
    const bucket = bucketOf(j);
    if (j.error || !j.outcome) {
      bucket.failed++;
      summary.failures.push({
        file: rel,
        kind: j.job.kind === "video" ? "video" : "image",
        error: j.error?.message ?? "unknown error",
      });
      continue;
    }
    const { meta, origin } = j.outcome;
    const cached = origin !== "built";
    if (cached) bucket.cached++;
    else bucket.processed++;
    const { before, after } = deliveredBytes(meta.result);
    bucket.bytesBefore += before;
    bucket.bytesAfter += after;
    if (meta.result.kind === "video") {
      if (meta.result.hls) summary.videos.hls++;
      else summary.videos.mp4Only++;
    }
    entries.push({
      source: rel,
      kind: j.job.kind,
      hash: meta.hash,
      cached,
      bytesBefore: before,
      bytesAfter: after,
      result: meta.result,
    });
  }
  const touched = entries.length > 0 || needsRuntime;
  if (touched) {
    const manifest = await writeManifest(
      path.join(outRoot, "manifest.json"),
      entries,
      config.outDirName,
    );
    if (config.headers) await writeHeaders(dir, config);
    if (config.report) await writeReport(path.join(outRoot, "report.html"), manifest);
  }

  if (!config.keepOriginals) await removeOriginals(all, outRoot, logger);

  summary.durationMs = Date.now() - started;
  return summary;
}

function snippetElement(snippet: string, tag: string): Element {
  for (const el of walkElements(parseHtml(snippet))) if (el.tagName === tag) return el;
  throw new Error(`no <${tag}> in snippet`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

const VERB: Record<AssetJob["kind"], string> = {
  video: "encoding",
  image: "processing",
  poster: "processing poster",
  convert: "converting",
  og: "processing social image",
  gif: "converting GIF",
};

async function runJob(
  planned: PlannedJob,
  ctx: {
    outRoot: string;
    cacheDir?: string;
    remote?: RemoteCache;
    bins?: FfmpegBinaries;
    logger: Logger;
    dir: string;
  },
): Promise<void> {
  const { job } = planned;
  const rel = toPosix(path.relative(ctx.dir, job.file));
  const t = Date.now();
  try {
    const { key, hash } = await assetKey(job);
    planned.outcome = await materialize(
      { outRoot: ctx.outRoot, cacheDir: ctx.cacheDir, remote: ctx.remote, key, hash, source: rel },
      (tmp): Promise<AssetResult> => {
        ctx.logger.info(`${VERB[job.kind]} ${rel}`);
        switch (job.kind) {
          case "video":
            return processVideo(
              { bins: ctx.bins!, logger: ctx.logger },
              { input: job.file, outDir: tmp, settings: job.settings },
            );
          case "image":
            return processImage(job.file, tmp, job.settings);
          case "poster":
            return processPoster(job.file, tmp, job.settings);
          case "convert":
            return processConvert(job.file, tmp, job.settings);
          case "og":
            return processOg(job.file, tmp, job.settings);
          case "gif":
            return processGif(
              { bins: ctx.bins!, logger: ctx.logger },
              { input: job.file, outDir: tmp, settings: job.settings },
            );
        }
      },
    );
    ctx.logger.debug(`${rel}: ${planned.outcome.origin} in ${Date.now() - t}ms`);
  } catch (err) {
    planned.error = err instanceof Error ? err : new Error(String(err));
    ctx.logger.error(`${rel}: ${planned.error.message.split("\n")[0]}`);
    ctx.logger.debug(planned.error.message);
  }
}

/** Bytes a visitor downloads before vs. after (see docs/DECISIONS.md). */
export function deliveredBytes(result: AssetResult): { before: number; after: number } {
  switch (result.kind) {
    case "video":
      return { before: result.sourceBytes, after: result.mp4.bytes };
    case "poster":
    case "og":
      return { before: result.sourceBytes, after: result.file.bytes };
    case "captions":
      return { before: 0, after: 0 };
    case "gif":
      return { before: result.sourceBytes, after: result.mp4?.bytes ?? result.sourceBytes };
    case "convert": {
      const best = Math.min(result.sourceBytes, ...result.variants.map((v) => v.bytes));
      return { before: result.sourceBytes, after: best };
    }
    case "image": {
      const fallback = pickFallbackWidth(result.variants.map((v) => v.width));
      const preferred =
        result.variants.find((v) => v.width === fallback && v.format === "avif") ??
        result.variants.find((v) => v.width === fallback && v.format === "webp") ??
        result.variants.find((v) => v.width === fallback);
      return { before: result.sourceBytes, after: preferred?.bytes ?? result.sourceBytes };
    }
  }
}

async function cleanStaleTemps(outRoot: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(outRoot);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.includes(".tmp-"))
      .map((e) => fs.rm(path.join(outRoot, e), { recursive: true, force: true })),
  );
}

/**
 * Delete source files the rewritten pages no longer reference. Files used by "convert" jobs
 * (srcset candidates, CSS backgrounds) stay: the markup keeps them as the fallback.
 */
async function removeOriginals(all: PlannedJob[], outRoot: string, logger: Logger) {
  const ok = new Set<string>();
  const keep = new Set<string>();
  for (const j of all) {
    // Images and GIFs that weren't worth re-encoding are still referenced by their <img>.
    const result = j.outcome?.meta.result;
    const passthrough = (result?.kind === "gif" || result?.kind === "image") && result.passthrough;
    if (!j.outcome || j.job.kind === "convert" || passthrough) keep.add(j.job.file);
    else ok.add(j.job.file);
  }
  for (const file of ok) {
    if (keep.has(file) || file.startsWith(outRoot + path.sep)) continue;
    await fs.rm(file, { force: true });
    logger.debug(`removed original ${file}`);
  }
}

export type { ResolvedConfig };
