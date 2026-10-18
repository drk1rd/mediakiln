import type { ResolvedConfig, VideoConfig, ImagesConfig } from "./config.js";

/**
 * Bump whenever output layout or encoding logic changes, so stale cache entries
 * (and stale `_mediakiln/<hash>/` folders) are never reused.
 */
export const MEDIAKILN_CACHE_VERSION = "2";

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

export interface GifSettings {
  crf: number;
  preset: VideoConfig["mp4"]["preset"];
  maxHeight: number;
  poster: { format: VideoConfig["poster"]["format"]; quality: number };
}

export type AssetJob =
  | { kind: "video"; file: string; settings: VideoSettings }
  | { kind: "image"; file: string; settings: ImageSettings }
  | { kind: "poster"; file: string; settings: PosterSettings }
  | { kind: "gif"; file: string; settings: GifSettings };

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

export interface GifResult {
  kind: "gif";
  /** Intrinsic size of the GIF (what the `<img>` rendered at). */
  width: number;
  height: number;
  frames: number;
  duration: number;
  sourceBytes: number;
  /** Absent when the MP4 came out bigger than the GIF (`passthrough`). */
  mp4?: OutputFile;
  poster?: OutputFile & { width: number; height: number };
  /** True when converting didn't pay off; the `<img>` is left as it is. */
  passthrough?: boolean;
}

export type AssetResult = VideoResult | ImageResult | PosterResult | GifResult;

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

export function gifSettingsFor(config: ResolvedConfig): GifSettings {
  const { mp4, poster } = config.video;
  return {
    crf: mp4.crf,
    preset: mp4.preset,
    maxHeight: mp4.maxHeight,
    poster: { format: poster.format, quality: poster.quality },
  };
}

/** Identity of a job for de-duplication: same file + same settings → processed once. */
export function jobId(job: AssetJob): string {
  return `${job.kind}\0${job.file}\0${JSON.stringify(job.settings)}`;
}
