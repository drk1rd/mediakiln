import type { Rendition, VideoConfig } from "../config.js";
import type { HlsVariant } from "../assets.js";
import type { ProbeResult } from "./probe.js";

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
export function scaleFilter(r: Rendition, source: { width: number; height: number }): string {
  return source.height > source.width ? `scale=${r.height}:-2` : `scale=-2:${r.height}`;
}

export interface HlsArgsOptions {
  input: string;
  /** Directory that will contain master.m3u8 and v0/, v1/, … */
  hlsDir: string;
  renditions: Rendition[];
  source: { width: number; height: number };
  hasAudio: boolean;
  segmentSec: number;
  preset: string;
}

const kbps = (n: number) => `${Math.round(n)}k`;

/** Build the single ffmpeg invocation that encodes every rendition and writes the playlists. */
export function hlsArgs(o: HlsArgsOptions): string[] {
  const n = o.renditions.length;
  const split = n > 1 ? `[0:v]split=${n}${o.renditions.map((_, i) => `[v${i}]`).join("")};` : "";
  const scales = o.renditions
    .map((r, i) => `[${n > 1 ? `v${i}` : "0:v"}]${scaleFilter(r, o.source)}[v${i}o]`)
    .join(";");

  const video = o.renditions.flatMap((r, i) => [
    "-map",
    `[v${i}o]`,
    `-c:v:${i}`,
    "libx264",
    `-b:v:${i}`,
    kbps(r.videoKbps),
    `-maxrate:v:${i}`,
    kbps(r.videoKbps * 1.07),
    `-bufsize:v:${i}`,
    kbps(r.videoKbps * 1.5),
  ]);
  const audio = o.hasAudio
    ? o.renditions.flatMap((r, i) => [
        "-map",
        "a:0",
        `-c:a:${i}`,
        "aac",
        `-b:a:${i}`,
        kbps(r.audioKbps),
        "-ac",
        "2",
      ])
    : [];
  const streamMap = o.renditions.map((_, i) => (o.hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(" ");

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
    "-preset",
    o.preset,
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    `expr:gte(t,n_forced*${o.segmentSec})`,
    "-sc_threshold",
    "0",
    "-f",
    "hls",
    "-hls_time",
    String(o.segmentSec),
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_type",
    "mpegts",
    "-hls_segment_filename",
    `${o.hlsDir}/v%v/seg_%03d.ts`,
    "-master_pl_name",
    "master.m3u8",
    "-var_stream_map",
    streamMap,
    `${o.hlsDir}/v%v/index.m3u8`,
  ];
}

/** Parse variants out of a master playlist; throws if BANDWIDTH or RESOLUTION is missing. */
export function parseMasterPlaylist(text: string): Array<HlsVariant & { uri: string }> {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: Array<HlsVariant & { uri: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const bandwidth = /(?:^|[:,])BANDWIDTH=(\d+)/.exec(line)?.[1];
    const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(line);
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
    if (!bandwidth || !resolution || !uri) {
      throw new Error(`master.m3u8 variant is missing BANDWIDTH, RESOLUTION or URI: ${line}`);
    }
    variants.push({
      bandwidth: Number(bandwidth),
      width: Number(resolution[1]),
      height: Number(resolution[2]),
      uri,
    });
  }
  return variants;
}
