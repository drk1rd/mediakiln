import type { ResolvedConfig, VideoConfig, ImagesConfig } from "./config.js";

/**
 * Bump whenever output layout or encoding logic changes, so stale cache entries
 * (and stale `_mediakiln/<hash>/` folders) are never reused.
 */
export const MEDIAKILN_CACHE_VERSION = "1";

export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
export const RASTER_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".tif",
  ".tiff",
]);

export interface VideoSettings {
  mp4: VideoConfig["mp4"];
  poster: VideoConfig["poster"];
  /** HLS settings, or null when HLS is disabled for this element. */
  hls: VideoConfig["hls"] | null;
}

export interface ImageSettings {
  formats: ImagesConfig["formats"];
  widths: number[];
  quality: ImagesConfig["quality"];
}

export interface PosterSettings {
  format: VideoConfig["poster"]["format"];
  quality: number;
  maxHeight: number;
}

export type AssetJob =
  | { kind: "video"; file: string; settings: VideoSettings }
  | { kind: "image"; file: string; settings: ImageSettings }
  | { kind: "poster"; file: string; settings: PosterSettings };

export interface OutputFile {
  /** Path relative to the asset's output folder, POSIX separators. */
  path: string;
  bytes: number;
}

export interface HlsVariant {
  height: number;
  width: number;
  bandwidth: number;
}

export interface VideoResult {
  kind: "video";
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  sourceBytes: number;
  mp4: OutputFile & { mode: "remux" | "reencode" };
  poster?: OutputFile & { width: number; height: number };
  hls?: { master: string; variants: HlsVariant[]; bytes: number };
}

export interface ImageVariant extends OutputFile {
  format: "avif" | "webp" | "jpeg" | "png";
  width: number;
}

export interface ImageResult {
  kind: "image";
  width: number;
  height: number;
  sourceBytes: number;
  fallbackFormat: "jpeg" | "png";
  variants: ImageVariant[];
}

export interface PosterResult {
  kind: "poster";
  width: number;
  height: number;
  sourceBytes: number;
  file: OutputFile;
}

export type AssetResult = VideoResult | ImageResult | PosterResult;

export interface AssetMeta<R extends AssetResult = AssetResult> {
  key: string;
  hash: string;
  cacheVersion: string;
  source: string;
  result: R;
}

export function videoSettingsFor(config: ResolvedConfig, opts: { noHls: boolean }): VideoSettings {
  const v = config.video;
  return {
    mp4: v.mp4,
    poster: v.poster,
    hls: v.hls.enabled && !opts.noHls ? v.hls : null,
  };
}

export function imageSettingsFor(config: ResolvedConfig): ImageSettings {
  const i = config.images;
  return {
    formats: i.formats,
    widths: [...new Set(i.widths)].sort((a, b) => a - b),
    quality: i.quality,
  };
}

export function posterSettingsFor(config: ResolvedConfig): PosterSettings {
  const p = config.video.poster;
  return { format: p.format, quality: p.quality, maxHeight: config.video.mp4.maxHeight };
}

/** Identity of a job for de-duplication: same file + same settings → processed once. */
export function jobId(job: AssetJob): string {
  return `${job.kind}\0${job.file}\0${JSON.stringify(job.settings)}`;
}
