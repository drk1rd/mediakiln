import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "../images/sharp.js";
import type { GifResult, GifSettings } from "../assets.js";
import { encodePoster } from "../images/poster.js";
import type { VideoContext } from "./video.js";
import { capFilter } from "./mp4.js";
import { formatCommand, run } from "./run.js";

export interface GifInfo {
  width: number;
  height: number;
  frames: number;
  /** Seconds, from the per-frame delays (browsers treat delays under 20 ms as 100 ms). */
  duration: number;
}

/** Read a GIF's size and frame count. Single-frame GIFs report `frames: 1`. */
export async function gifInfo(file: string): Promise<GifInfo> {
  const meta = await sharp(file, { animated: true }).metadata();
  const frames = meta.pages ?? 1;
  const width = meta.width;
  const height = meta.pageHeight ?? meta.height;
  if (!width || !height) throw new Error("Could not read GIF dimensions");
  const delays = meta.delay ?? [];
  const ms = delays.reduce((sum, d) => sum + (d < 20 ? 100 : d), 0);
  return { width, height, frames, duration: ms / 1000 };
}

/** `-fps_mode` arrived in ffmpeg 5.1; older builds only know the (since deprecated) `-vsync`. */
export function vfrArgs(version: string): string[] {
  const m = /version n?(\d+)\.(\d+)/.exec(version);
  const old = m && (Number(m[1]) < 5 || (Number(m[1]) === 5 && Number(m[2]) < 1));
  return old ? ["-vsync", "vfr"] : ["-fps_mode", "vfr"];
}

/**
 * Animated GIF → silent, looping-friendly H.264 MP4: yuv420p, even dimensions (via the same
 * short-side cap as videos), frame timing kept as-is instead of padded to a constant rate.
 */
export function gifToMp4Args(
  input: string,
  output: string,
  settings: Pick<GifSettings, "crf" | "preset" | "maxHeight">,
  source: { width: number; height: number },
  version = "",
): string[] {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-vf",
    capFilter(settings.maxHeight, source.height > source.width),
    ...vfrArgs(version),
    "-c:v",
    "libx264",
    "-preset",
    settings.preset,
    "-crf",
    String(settings.crf),
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-movflags",
    "+faststart",
    output,
  ];
}

export async function processGif(
  ctx: VideoContext,
  { input, outDir, settings }: { input: string; outDir: string; settings: GifSettings },
): Promise<GifResult> {
  const [info, stat] = await Promise.all([gifInfo(input), fs.stat(input)]);
  const base = {
    kind: "gif" as const,
    width: info.width,
    height: info.height,
    frames: info.frames,
    duration: info.duration,
    sourceBytes: stat.size,
  };

  const out = path.join(outDir, "video.mp4");
  const args = gifToMp4Args(input, out, settings, info, ctx.bins.version);
  ctx.logger.debug(formatCommand(ctx.bins.ffmpeg, args));
  await run(ctx.bins.ffmpeg, args);
  const bytes = (await fs.stat(out)).size;

  // Tiny GIFs can come out smaller than any MP4 container; then the <img> stays.
  if (bytes >= stat.size) {
    ctx.logger.debug(`gif: MP4 (${bytes}B) not smaller than GIF (${stat.size}B), keeping GIF`);
    await fs.rm(out, { force: true });
    return { ...base, passthrough: true };
  }

  const { file, ...poster } = await encodePoster(
    input,
    outDir,
    settings.poster.format,
    settings.poster.quality,
    settings.maxHeight,
  );
  return { ...base, mp4: { path: "video.mp4", bytes }, poster: { path: file, ...poster } };
}
