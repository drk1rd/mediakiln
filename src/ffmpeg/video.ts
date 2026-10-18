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
import { hlsArgs, parseMasterPlaylist, selectRenditions, shouldUseHls } from "./hls.js";

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

  await ffmpeg(ctx, reencodeArgs(input, out, settings.mp4, info));
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
  preset: string,
): Promise<VideoResult["hls"]> {
  const hlsDir = path.join(outDir, "hls");
  const renditions = selectRenditions(settings.renditions, info);
  ctx.logger.debug(`hls: ${renditions.map((r) => `${r.height}p`).join(", ")}`);
  await fs.mkdir(hlsDir, { recursive: true });
  for (let i = 0; i < renditions.length; i++) {
    await fs.mkdir(path.join(hlsDir, `v${i}`), { recursive: true });
  }
  await ffmpeg(
    ctx,
    hlsArgs({
      input,
      hlsDir,
      renditions,
      source: info,
      hasAudio: info.hasAudio,
      segmentSec: settings.segmentSec,
      preset,
    }),
  );
  const master = await fs.readFile(path.join(hlsDir, "master.m3u8"), "utf8");
  const variants = parseMasterPlaylist(master).map(({ uri: _uri, ...v }) => v);
  if (variants.length !== renditions.length) {
    throw new Error(`master.m3u8 lists ${variants.length} variants, expected ${renditions.length}`);
  }
  return { master: "hls/master.m3u8", variants, bytes: await dirSize(hlsDir) };
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
    hls = await buildHls(ctx, input, outDir, info, settings.hls, settings.mp4.preset);
  } else {
    ctx.logger.debug(`hls: skipped (${settings.hls ? "below thresholds" : "disabled"})`);
  }

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
  };
}
