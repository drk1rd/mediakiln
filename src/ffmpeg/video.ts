import { promises as fs } from "node:fs";
import path from "node:path";
import type { VideoResult, VideoSettings } from "../assets.js";
import type { Logger } from "../util/logger.js";
import type { FfmpegBinaries } from "./binary.js";
import { decideMp4Mode, isWebCompatible, reencodeArgs, remuxArgs } from "./mp4.js";
import { posterArgs, posterTime } from "./poster.js";
import { probe, type ProbeResult } from "./probe.js";
import { formatCommand, run } from "./run.js";
import { encodePoster } from "../images/poster.js";
import { dirSize } from "../util/fs.js";
import {
  hlsArgs,
  measureComplexity,
  parseMasterPlaylist,
  planVariants,
  selectRenditions,
  shouldUseHls,
} from "./hls.js";
import { resolveHardware, type Hardware } from "./encoders.js";
import { planThumbnails, thumbnailArgs, thumbnailVtt } from "./thumbnails.js";

export interface VideoContext {
  bins: FfmpegBinaries;
  logger: Logger;
}

async function ffmpeg(ctx: VideoContext, args: string[]): Promise<void> {
  ctx.logger.debug(formatCommand(ctx.bins.ffmpeg, args));
  const t = Date.now();
  await run(ctx.bins.ffmpeg, args);
  ctx.logger.debug(`  done in ${Date.now() - t}ms`);
}

async function size(file: string): Promise<number> {
  return (await fs.stat(file)).size;
}

async function buildMp4(
  ctx: VideoContext,
  input: string,
  outDir: string,
  info: ProbeResult,
  settings: VideoSettings,
  hw: Hardware,
): Promise<VideoResult["mp4"]> {
  const out = path.join(outDir, "video.mp4");
  const decision = decideMp4Mode(info, settings.mp4);
  ctx.logger.debug(`mp4: ${decision.mode} (${decision.reason})`);

  if (decision.mode === "remux") {
    await ffmpeg(ctx, remuxArgs(input, out));
    return { path: "video.mp4", bytes: await size(out), mode: "remux" };
  }

  await ffmpeg(ctx, reencodeArgs(input, out, settings.mp4, info, hw));
  const bytes = await size(out);

  // A re-encode that comes out bigger than a plain faststart remux isn't worth it.
  if (settings.mp4.reencode === "auto" && isWebCompatible(info)) {
    const remuxed = path.join(outDir, "video.remux.mp4");
    await ffmpeg(ctx, remuxArgs(input, remuxed));
    const remuxBytes = await size(remuxed);
    if (remuxBytes < bytes) {
      ctx.logger.debug(
        `mp4: re-encode (${bytes}B) larger than remux (${remuxBytes}B), keeping remux`,
      );
      await fs.rename(remuxed, out);
      return { path: "video.mp4", bytes: remuxBytes, mode: "remux" };
    }
    await fs.rm(remuxed, { force: true });
  }
  return { path: "video.mp4", bytes, mode: "reencode" };
}

async function buildPoster(
  ctx: VideoContext,
  input: string,
  outDir: string,
  info: ProbeResult,
  settings: VideoSettings["poster"],
  maxShortSide: number,
): Promise<VideoResult["poster"]> {
  const jpg = path.join(outDir, "poster.jpg");
  await ffmpeg(ctx, posterArgs(input, jpg, posterTime(settings.atSec, info.duration)));
  const { file, ...meta } = await encodePoster(
    jpg,
    outDir,
    settings.format,
    settings.quality,
    maxShortSide,
  );
  if (!settings.keepJpeg && file !== "poster.jpg") await fs.rm(jpg, { force: true });
  return { path: file, ...meta };
}

async function buildHls(
  ctx: VideoContext,
  input: string,
  outDir: string,
  info: ProbeResult,
  settings: NonNullable<VideoSettings["hls"]>,
  preset: VideoSettings["mp4"]["preset"],
  hw: Hardware,
): Promise<VideoResult["hls"]> {
  const hlsDir = path.join(outDir, "hls");
  const renditions = selectRenditions(settings.renditions, info);
  let factor = 1;
  if (settings.perTitle) {
    factor = await measureComplexity(ctx.bins.ffmpeg, input, info);
    ctx.logger.debug(`hls: per-title factor ${factor.toFixed(2)}`);
  }
  const variants = planVariants(renditions, settings.codecs, factor);
  ctx.logger.debug(
    `hls: ${variants.map((v) => `${v.codec} ${v.height}p@${v.videoKbps}k`).join(", ")} (${hw})`,
  );
  await fs.mkdir(hlsDir, { recursive: true });
  for (let i = 0; i < variants.length; i++) {
    await fs.mkdir(path.join(hlsDir, `v${i}`), { recursive: true });
  }
  await ffmpeg(
    ctx,
    hlsArgs({
      input,
      hlsDir,
      variants,
      source: info,
      hasAudio: info.hasAudio,
      segmentSec: settings.segmentSec,
      firstSegmentSec: settings.firstSegmentSec,
      segmentType: settings.segmentType,
      preset,
      hw,
    }),
  );
  const master = await fs.readFile(path.join(hlsDir, "master.m3u8"), "utf8");
  const parsed = parseMasterPlaylist(master).map(({ uri: _uri, ...v }) => v);
  if (parsed.length !== variants.length) {
    throw new Error(`master.m3u8 lists ${parsed.length} variants, expected ${variants.length}`);
  }
  return {
    master: "hls/master.m3u8",
    variants: parsed,
    bytes: await dirSize(hlsDir),
    segmentType: settings.segmentType,
    ...(settings.perTitle ? { factor: Math.round(factor * 100) / 100 } : {}),
  };
}

async function buildThumbnails(
  ctx: VideoContext,
  input: string,
  outDir: string,
  info: ProbeResult,
  settings: NonNullable<VideoSettings["thumbnails"]>,
): Promise<VideoResult["thumbnails"]> {
  const dir = path.join(outDir, "thumbnails");
  await fs.mkdir(dir, { recursive: true });
  const plan = planThumbnails(settings, info);
  await ffmpeg(ctx, thumbnailArgs(input, path.join(dir, "sheet_%03d.jpg"), settings, plan));
  const sheets = (await fs.readdir(dir)).filter((f) => f.startsWith("sheet_")).length;
  const vtt = thumbnailVtt(
    settings,
    plan,
    info.duration,
    (i) => `sheet_${String(i + 1).padStart(3, "0")}.jpg`,
  );
  await fs.writeFile(path.join(dir, "thumbnails.vtt"), vtt);
  return { vtt: "thumbnails/thumbnails.vtt", sheets, bytes: await dirSize(dir) };
}

export interface ProcessVideoOptions {
  input: string;
  outDir: string;
  settings: VideoSettings;
}

export async function processVideo(
  ctx: VideoContext,
  { input, outDir, settings }: ProcessVideoOptions,
): Promise<VideoResult> {
  const info = await probe(ctx.bins.ffprobe, input);
  ctx.logger.debug(
    `probe ${path.basename(input)}: ${info.width}x${info.height} ${info.duration.toFixed(1)}s ` +
      `${info.videoCodec}/${info.pixFmt} audio=${info.audioCodec ?? "none"} ` +
      `${Math.round(info.bitrate / 1000)}kbps rot=${info.rotation}`,
  );

  const hw = await resolveHardware(ctx.bins.ffmpeg, settings.encoder);
  const mp4 = await buildMp4(ctx, input, outDir, info, settings, hw);
  const poster = await buildPoster(
    ctx,
    input,
    outDir,
    info,
    settings.poster,
    settings.mp4.maxHeight,
  );

  let hls: VideoResult["hls"];
  if (settings.hls && shouldUseHls(info, settings.hls)) {
    hls = await buildHls(ctx, input, outDir, info, settings.hls, settings.mp4.preset, hw);
  } else {
    ctx.logger.debug(`hls: skipped (${settings.hls ? "below thresholds" : "disabled"})`);
  }

  const thumbnails = settings.thumbnails
    ? await buildThumbnails(ctx, input, outDir, info, settings.thumbnails)
    : undefined;

  return {
    kind: "video",
    width: info.width,
    height: info.height,
    duration: info.duration,
    hasAudio: info.hasAudio,
    sourceBytes: info.size,
    mp4,
    poster,
    hls,
    thumbnails,
  };
}
