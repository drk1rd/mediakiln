import { promises as fs } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import {
  imageSettingsFor,
  jobId,
  posterSettingsFor,
  videoSettingsFor,
  type AssetJob,
  type AssetResult,
  type ImageResult,
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
import { findFfmpeg, type FfmpegBinaries } from "./ffmpeg/binary.js";
import { processVideo } from "./ffmpeg/video.js";
import { buildCaptions, captionsKey, type CaptionsResult } from "./ffmpeg/captions.js";
import { applyEdits, type Edit } from "./html.js";
import { processImage, processPoster } from "./images/process.js";
import { writeManifest, type ManifestEntry } from "./manifest.js";
import { publicUrl } from "./resolve.js";
import { injectRuntime } from "./rewrite/inject.js";
import { pickFallbackWidth } from "./images/process.js";
import { rewriteImage } from "./rewrite/image.js";
import { rewriteVideo } from "./rewrite/video.js";
import { copyRuntime } from "./runtimeAssets.js";
import { findPages, runtimeScriptPath, scanPage, type PageScan } from "./scan.js";
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
  const summary = emptySummary(VERSION, dirOption, dryRun);

  // 1. Scan pages.
  const pageFiles = await findPages(dir, config);
  summary.pages.scanned = pageFiles.length;
  const ctx = { dir, base: config.base, config, logger };
  const pages: PageScan[] = [];
  for (const file of pageFiles) pages.push(await scanPage(file, ctx));

  // 2. Plan de-duplicated jobs.
  const jobs = new Map<string, PlannedJob>();
  const plan = (job: AssetJob): PlannedJob => {
    const id = jobId(job);
    let planned = jobs.get(id);
    if (!planned) jobs.set(id, (planned = { id, job }));
    return planned;
  };
  const videoJobs = new Map<
    PageScan["videos"][number],
    { video: PlannedJob; poster?: PlannedJob }
  >();
  const imageJobs = new Map<PageScan["images"][number], PlannedJob>();
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
    for (const ref of page.images) {
      imageJobs.set(
        ref,
        plan({ kind: "image", file: ref.file, settings: imageSettingsFor(config) }),
      );
    }
  }

  const all = [...jobs.values()];
  if (dryRun) {
    for (const j of all) {
      const bytes = (await fs.stat(j.job.file)).size;
      const bucket = j.job.kind === "video" ? summary.videos : summary.images;
      bucket.processed++;
      bucket.bytesBefore += bytes;
      logger.info(`would process ${j.job.kind} ${toPosix(path.relative(dir, j.job.file))}`);
    }
    summary.pages.rewritten = pages.filter(
      (p) => p.videos.length + p.images.length > 0 || (p.hasProcessedVideo && !p.hasRuntime),
    ).length;
    summary.durationMs = Date.now() - started;
    return summary;
  }

  // 3. Process: one video encode at a time (ffmpeg is multithreaded), images in parallel.
  let bins: FfmpegBinaries | undefined;
  if (all.some((j) => j.job.kind === "video")) bins = await findFfmpeg();
  if (all.length > 0) await cleanStaleTemps(outRoot);

  const videoLimit = pLimit(1);
  const imageLimit = pLimit(config.concurrency);
  await Promise.all(
    all.map((planned) =>
      (planned.job.kind === "video" ? videoLimit : imageLimit)(() =>
        runJob(planned, { outRoot, cacheDir, bins, logger, dir }),
      ),
    ),
  );

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
            { outRoot, cacheDir, key, hash: key.slice(0, 12), source: page.rel },
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

  // 4. Rewrite pages.
  const outUrl = (hash: string) => publicUrl(config.base, `${config.outDirName}/${hash}/`);
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
      const job = imageJobs.get(ref)!;
      if (!job.outcome) continue;
      edits.push(
        ...rewriteImage(
          page.html,
          ref,
          {
            result: job.outcome.meta.result as ImageResult,
            baseUrl: outUrl(job.outcome.meta.hash),
          },
          config,
        ),
      );
    }
    if (hasVideo) {
      needsRuntime = true;
      if (!page.hasRuntime) {
        edits.push(injectRuntime(page.html, page.injectAt, config.base, runtimeScriptPath(config)));
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

  if (needsRuntime) await copyRuntime(path.join(outRoot, "runtime"));

  // 5. Manifest, originals, summary.
  const entries: ManifestEntry[] = [];
  for (const j of all) {
    const rel = toPosix(path.relative(dir, j.job.file));
    const bucket = j.job.kind === "video" ? summary.videos : summary.images;
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
  if (entries.length > 0 || needsRuntime) {
    await writeManifest(path.join(outRoot, "manifest.json"), entries, config.outDirName);
  }

  if (!config.keepOriginals) await removeOriginals(all, outRoot, logger);

  summary.durationMs = Date.now() - started;
  return summary;
}

async function runJob(
  planned: PlannedJob,
  ctx: {
    outRoot: string;
    cacheDir?: string;
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
      { outRoot: ctx.outRoot, cacheDir: ctx.cacheDir, key, hash, source: rel },
      (tmp): Promise<AssetResult> => {
        const verb = { video: "encoding", image: "processing", poster: "processing poster" };
        ctx.logger.info(`${verb[job.kind]} ${rel}`);
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
      return { before: result.sourceBytes, after: result.file.bytes };
    case "captions":
      return { before: 0, after: 0 };
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

async function removeOriginals(all: PlannedJob[], outRoot: string, logger: Logger) {
  const ok = new Set<string>();
  const failed = new Set<string>();
  for (const j of all) (j.outcome ? ok : failed).add(j.job.file);
  for (const file of ok) {
    if (failed.has(file) || file.startsWith(outRoot + path.sep)) continue;
    await fs.rm(file, { force: true });
    logger.debug(`removed original ${file}`);
  }
}

export type { ResolvedConfig };
