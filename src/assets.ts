import type { ResolvedConfig, VideoConfig, ImagesConfig } from "./config.js";

/**
 * Bump whenever output layout or encoding logic changes, so stale cache entries
 * (and stale `_mediakiln/<hash>/` folders) are never reused.
 */
export const MEDIAKILN_CACHE_VERSION = "3";

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
  encoder: VideoConfig["encoder"];
  mp4: VideoConfig["mp4"];
  thumbnails: VideoConfig["thumbnails"] | null;
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

export interface ConvertSettings {
  formats: ImagesConfig["formats"];
  quality: ImagesConfig["quality"];
}

export interface OgSettings {
  maxSize: number;
  quality: number;
}

export type AssetJob =
  | { kind: "video"; file: string; settings: VideoSettings }
  | { kind: "image"; file: string; settings: ImageSettings }
  | { kind: "poster"; file: string; settings: PosterSettings }
  | { kind: "convert"; file: string; settings: ConvertSettings }
  | { kind: "og"; file: string; settings: OgSettings };

export interface OutputFile {
  /** Path relative to the asset's output folder, POSIX separators. */
  path: string;
  bytes: number;
}

export interface HlsVariant {
  height: number;
  width: number;
  bandwidth: number;
  codecs?: string;
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
  hls?: {
    master: string;
    variants: HlsVariant[];
    bytes: number;
    segmentType?: "fmp4" | "mpegts";
    /** Per-title bitrate factor applied to the ladder (1 = configured bitrates). */
    factor?: number;
  };
  thumbnails?: { vtt: string; sheets: number; bytes: number };
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
  /**
   * True when re-encoding didn't pay off (even the resized fallback was bigger than the
   * original). The `<img>` keeps its source and only gains dimensions and lazy loading.
   */
  passthrough?: boolean;
}

export interface PosterResult {
  kind: "poster";
  width: number;
  height: number;
  sourceBytes: number;
  file: OutputFile;
}

export type { CaptionsResult } from "./ffmpeg/captions.js";
import type { CaptionsResult } from "./ffmpeg/captions.js";

export interface ConvertResult {
  kind: "convert";
  width: number;
  height: number;
  sourceBytes: number;
  sourceFormat: string;
  variants: Array<OutputFile & { format: "avif" | "webp" }>;
}

export interface OgResult {
  kind: "og";
  width: number;
  height: number;
  sourceBytes: number;
  file: OutputFile;
}

export type AssetResult =
  VideoResult | ImageResult | PosterResult | CaptionsResult | ConvertResult | OgResult;

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
    encoder: v.encoder,
    mp4: v.mp4,
    thumbnails: v.thumbnails.enabled ? v.thumbnails : null,
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

export function convertSettingsFor(config: ResolvedConfig): ConvertSettings {
  return { formats: config.images.formats, quality: config.images.quality };
}

export function ogSettingsFor(config: ResolvedConfig): OgSettings {
  return { maxSize: 1200, quality: config.images.quality.jpeg };
}

/** Identity of a job for de-duplication: same file + same settings → processed once. */
export function jobId(job: AssetJob): string {
  return `${job.kind}\0${job.file}\0${JSON.stringify(job.settings)}`;
}
