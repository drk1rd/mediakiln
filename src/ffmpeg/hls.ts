import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Rendition, VideoCodec, VideoConfig } from "../config.js";
import type { HlsVariant } from "../assets.js";
import { CODEC_EFFICIENCY, videoEncodeArgs, type Hardware } from "./encoders.js";
import type { ProbeResult } from "./probe.js";
import { run } from "./run.js";

export type HlsSettings = VideoConfig["hls"];

/** HLS is worth it for long or large videos: duration ≥ minDurationSec OR size ≥ minSizeMB. */
export function shouldUseHls(p: Pick<ProbeResult, "duration" | "size">, hls: HlsSettings): boolean {
  if (!hls.enabled) return false;
  return p.duration >= hls.minDurationSec || p.size >= hls.minSizeMB * 1024 * 1024;
}

/**
 * Pick renditions for a source. A rendition's `height` is its "p" number, i.e. the short side
 * of the frame, so portrait videos get the same quality ladder as landscape ones. Renditions
 * larger than the source are dropped; at least one always remains (at the source size when the
 * source is smaller than every configured rendition).
 */
export function selectRenditions(
  renditions: readonly Rendition[],
  source: { width: number; height: number },
): Rendition[] {
  const shortSide = Math.min(source.width, source.height);
  const sorted = [...renditions].sort((a, b) => a.height - b.height);
  const fit = sorted.filter((r) => r.height <= shortSide);
  if (fit.length > 0) return fit;
  const lowest = sorted[0]!;
  return [{ ...lowest, height: shortSide - (shortSide % 2) }];
}

/** ffmpeg scale filter for a rendition, keeping aspect ratio and even dimensions. */
export function scaleFilter(
  r: Pick<Rendition, "height">,
  source: { width: number; height: number },
): string {
  return source.height > source.width ? `scale=${r.height}:-2` : `scale=-2:${r.height}`;
}

export interface VariantPlan {
  codec: VideoCodec;
  height: number;
  videoKbps: number;
  audioKbps: number;
}

/**
 * One variant per (codec, rendition). H.264 comes first so players that pick the first listed
 * variant start with the most compatible one; HEVC/AV1 get proportionally lower bitrates.
 * `factor` scales video bitrates (per-title encoding).
 */
export function planVariants(
  renditions: readonly Rendition[],
  codecs: readonly VideoCodec[],
  factor = 1,
): VariantPlan[] {
  return codecs.flatMap((codec) =>
    renditions.map((r) => ({
      codec,
      height: r.height,
      videoKbps: Math.max(150, Math.round(r.videoKbps * factor * CODEC_EFFICIENCY[codec])),
      audioKbps: r.audioKbps,
    })),
  );
}

/** Keyframe expression giving a short first segment and aligned segments after it. */
export function keyframeExpr(segmentSec: number, firstSegmentSec: number): string {
  if (firstSegmentSec > 0 && firstSegmentSec < segmentSec) {
    return `expr:if(eq(n_forced,0),1,gte(t,${firstSegmentSec}+(n_forced-1)*${segmentSec}))`;
  }
  return `expr:gte(t,n_forced*${segmentSec})`;
}

export interface HlsArgsOptions {
  input: string;
  /** Directory that will contain master.m3u8 and v0/, v1/, … */
  hlsDir: string;
  variants: VariantPlan[];
  source: { width: number; height: number };
  hasAudio: boolean;
  segmentSec: number;
  firstSegmentSec?: number;
  segmentType?: "fmp4" | "mpegts";
  preset: VideoConfig["mp4"]["preset"];
  hw?: Hardware;
}

const kbps = (n: number) => `${Math.round(n)}k`;

/** Build the single ffmpeg invocation that encodes every variant and writes the playlists. */
export function hlsArgs(o: HlsArgsOptions): string[] {
  const n = o.variants.length;
  const hw = o.hw ?? "software";
  const segmentType = o.segmentType ?? "mpegts";
  const first = o.firstSegmentSec ?? 0;
  const split = n > 1 ? `[0:v]split=${n}${o.variants.map((_, i) => `[v${i}]`).join("")};` : "";
  const scales = o.variants
    .map((v, i) => `[${n > 1 ? `v${i}` : "0:v"}]${scaleFilter(v, o.source)}[v${i}o]`)
    .join(";");

  const video = o.variants.flatMap((v, i) => [
    "-map",
    `[v${i}o]`,
    ...videoEncodeArgs({ codec: v.codec, hw, preset: o.preset, kbps: v.videoKbps }, `:${i}`),
  ]);
  const audio = o.hasAudio
    ? o.variants.flatMap((v, i) => [
        "-map",
        "a:0",
        `-c:a:${i}`,
        "aac",
        `-b:a:${i}`,
        kbps(v.audioKbps),
        "-ac",
        "2",
      ])
    : [];
  const streamMap = o.variants.map((_, i) => (o.hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(" ");
  const ext = segmentType === "fmp4" ? "m4s" : "ts";

  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    o.input,
    "-filter_complex",
    split + scales,
    ...video,
    ...audio,
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    keyframeExpr(o.segmentSec, first),
    "-sc_threshold",
    "0",
    "-f",
    "hls",
    "-hls_time",
    String(o.segmentSec),
    ...(first > 0 && first < o.segmentSec ? ["-hls_init_time", String(first)] : []),
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_type",
    segmentType,
    "-hls_segment_filename",
    `${o.hlsDir}/v%v/seg_%03d.${ext}`,
    "-master_pl_name",
    "master.m3u8",
    "-var_stream_map",
    streamMap,
    `${o.hlsDir}/v%v/index.m3u8`,
  ];
}

export interface MasterVariant extends HlsVariant {
  uri: string;
  codecs?: string;
}

/** Parse variants out of a master playlist; throws if BANDWIDTH or RESOLUTION is missing. */
export function parseMasterPlaylist(text: string): MasterVariant[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: MasterVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const bandwidth = /(?:^|[:,])BANDWIDTH=(\d+)/.exec(line)?.[1];
    const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(line);
    const codecs = /CODECS="([^"]*)"/.exec(line)?.[1];
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
    if (!bandwidth || !resolution || !uri) {
      throw new Error(`master.m3u8 variant is missing BANDWIDTH, RESOLUTION or URI: ${line}`);
    }
    variants.push({
      bandwidth: Number(bandwidth),
      width: Number(resolution[1]),
      height: Number(resolution[2]),
      uri,
      ...(codecs ? { codecs } : {}),
    });
  }
  return variants;
}

/** Typical bitrate (bps) of x264 veryfast CRF 23 at 720p for average live-action content. */
export const REFERENCE_720P_BPS = 2_500_000;

export function complexityProbeArgs(
  input: string,
  output: string,
  info: Pick<ProbeResult, "width" | "height" | "duration">,
): string[] {
  const sample = Math.min(12, info.duration || 12);
  const start = Math.max(0, (info.duration - sample) / 2);
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    start.toFixed(2),
    "-t",
    sample.toFixed(2),
    "-i",
    input,
    "-an",
    "-vf",
    scaleFilter({ height: Math.min(720, Math.min(info.width, info.height)) }, info),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "mp4",
    output,
  ];
}

/**
 * Ladder scale factor from a measured CRF-23 bitrate, clamped to a sane range. `shortSide` is
 * the sample's encoded short side; the reference scales with frame area below 720p.
 */
export function complexityFactor(measuredBps: number, shortSide = 720): number {
  const reference = REFERENCE_720P_BPS * Math.min(1, (shortSide / 720) ** 2);
  return Math.min(1.25, Math.max(0.35, measuredBps / reference));
}

/**
 * Per-title encoding: encode a short sample from the middle of the video at constant quality
 * and scale the ladder by how hard the content is to compress compared to typical footage.
 */
export async function measureComplexity(
  ffmpeg: string,
  input: string,
  info: ProbeResult,
): Promise<number> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediakiln-complexity-"));
  try {
    const out = path.join(dir, "sample.mp4");
    const args = complexityProbeArgs(input, out, info);
    await run(ffmpeg, args);
    const sampleSec = Number(args[args.indexOf("-t") + 1]);
    const bytes = (await fs.stat(out)).size;
    const shortSide = Math.min(720, info.width, info.height);
    return complexityFactor((bytes * 8) / Math.max(0.5, sampleSec), shortSide);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
