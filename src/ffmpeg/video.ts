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
): Promise<VideoResult["mp4"]> {
  const out = path.join(outDir, "video.mp4");
  const decision = decideMp4Mode(info, settings.mp4);
  ctx.logger.debug(`mp4: ${decision.mode} (${decision.reason})`);

  if (decision.mode === "remux") {
    await ffmpeg(ctx, remuxArgs(input, out));
    return { path: "video.mp4", bytes: await size(out), mode: "remux" };
  }

  await ffmpeg(ctx, reencodeArgs(input, out, settings.mp4, info.hasAudio));
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
  maxHeight: number,
): Promise<VideoResult["poster"]> {
  const jpg = path.join(outDir, "poster.jpg");
  await ffmpeg(ctx, posterArgs(input, jpg, posterTime(settings.atSec, info.duration)));
  const { file, ...meta } = await encodePoster(
    jpg,
    outDir,
    settings.format,
    settings.quality,
    maxHeight,
  );
  if (!settings.keepJpeg && file !== "poster.jpg") await fs.rm(jpg, { force: true });
  return { path: file, ...meta };
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

  const mp4 = await buildMp4(ctx, input, outDir, info, settings);
  const outHeight = Math.min(info.height, settings.mp4.maxHeight);
  const poster = await buildPoster(ctx, input, outDir, info, settings.poster, outHeight);

  return {
    kind: "video",
    width: info.width,
    height: info.height,
    duration: info.duration,
    hasAudio: info.hasAudio,
    sourceBytes: info.size,
    mp4,
    poster,
  };
}
