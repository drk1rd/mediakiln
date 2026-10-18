import type { VideoConfig } from "../config.js";
import type { ProbeResult } from "./probe.js";
import { videoEncodeArgs, type Hardware } from "./encoders.js";

export type Mp4Mode = "remux" | "reencode";

/** Bitrate considered "reasonable" for a given frame size: ~8 Mbps at 1080p, scaled by area. */
export function maxReasonableBitrate(width: number, height: number): number {
  const ratio = (width * height) / (1920 * 1080);
  return Math.max(1_000_000, Math.round(8_000_000 * ratio));
}

/** True when the streams can be copied into an MP4 that plays in every browser. */
export function isWebCompatible(p: ProbeResult): boolean {
  return (
    p.videoCodec === "h264" &&
    (p.pixFmt === "yuv420p" || p.pixFmt === "yuvj420p") &&
    (!p.hasAudio || p.audioCodec === "aac")
  );
}

export function decideMp4Mode(
  p: ProbeResult,
  mp4: VideoConfig["mp4"],
): { mode: Mp4Mode; reason: string } {
  if (mp4.reencode === "always") return { mode: "reencode", reason: "reencode: always" };
  if (mp4.reencode === "never") return { mode: "remux", reason: "reencode: never" };
  if (!isWebCompatible(p)) {
    const audio = p.hasAudio ? `/${p.audioCodec}` : "";
    return { mode: "reencode", reason: `${p.videoCodec}/${p.pixFmt}${audio} is not web-ready` };
  }
  const shortSide = Math.min(p.width, p.height);
  if (shortSide > mp4.maxHeight)
    return { mode: "reencode", reason: `${shortSide}p > ${mp4.maxHeight}p` };
  const max = maxReasonableBitrate(p.width, p.height);
  if (p.bitrate > max)
    return {
      mode: "reencode",
      reason: `bitrate ${Math.round(p.bitrate / 1000)}k > ${Math.round(max / 1000)}k`,
    };
  return { mode: "remux", reason: "already H.264/AAC at a reasonable bitrate" };
}

export function remuxArgs(input: string, output: string): string[] {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    output,
  ];
}

/**
 * Scale filter capping the short side at `maxHeight` ("1080p" means 1080 on the short side, so
 * portrait videos aren't shrunk to 608x1080) and keeping both dimensions even.
 */
export function capFilter(maxHeight: number, portrait: boolean): string {
  return portrait
    ? `scale='min(${maxHeight},trunc(iw/2)*2)':-2`
    : `scale=-2:'min(${maxHeight},trunc(ih/2)*2)'`;
}

export function reencodeArgs(
  input: string,
  output: string,
  mp4: VideoConfig["mp4"],
  source: { hasAudio: boolean; width: number; height: number },
  hw: Hardware = "software",
): string[] {
  const { hasAudio } = source;
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0"] : []),
    "-vf",
    capFilter(mp4.maxHeight, source.height > source.width),
    ...videoEncodeArgs({ codec: "h264", hw, preset: mp4.preset, crf: mp4.crf }),
    "-pix_fmt",
    "yuv420p",
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ac", "2"] : ["-an"]),
    "-movflags",
    "+faststart",
    output,
  ];
}
