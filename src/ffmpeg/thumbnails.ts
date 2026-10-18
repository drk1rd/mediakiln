import type { VideoConfig } from "../config.js";

export type ThumbnailSettings = VideoConfig["thumbnails"];

/** Rows per sprite sheet, so very long videos produce several reasonably sized images. */
export const ROWS_PER_SHEET = 10;

export interface ThumbnailPlan {
  count: number;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  sheets: number;
}

export function planThumbnails(
  s: ThumbnailSettings,
  info: { duration: number; width: number; height: number },
): ThumbnailPlan {
  const count = Math.max(1, Math.ceil(info.duration / s.intervalSec));
  const columns = Math.min(s.columns, count);
  const rows = Math.min(ROWS_PER_SHEET, Math.ceil(count / columns));
  const tileWidth = s.width - (s.width % 2);
  const tileHeight = Math.max(2, Math.round((tileWidth * info.height) / info.width / 2) * 2);
  return {
    count,
    columns,
    rows,
    tileWidth,
    tileHeight,
    sheets: Math.ceil(count / (columns * rows)),
  };
}

/** One ffmpeg run that samples a frame every `intervalSec` and tiles them into JPEG sheets. */
export function thumbnailArgs(
  input: string,
  outPattern: string,
  s: ThumbnailSettings,
  p: ThumbnailPlan,
): string[] {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-an",
    "-vf",
    `fps=1/${s.intervalSec},scale=${p.tileWidth}:${p.tileHeight},tile=${p.columns}x${p.rows}`,
    "-q:v",
    "5",
    "-fps_mode",
    "passthrough",
    outPattern,
  ];
}

function timestamp(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/**
 * WebVTT thumbnail track (the de-facto format read by Vidstack, video.js, Plyr, JW Player…):
 * each cue points at a region of a sprite sheet with `#xywh=`.
 */
export function thumbnailVtt(
  s: ThumbnailSettings,
  p: ThumbnailPlan,
  duration: number,
  sheetName: (index: number) => string,
): string {
  const perSheet = p.columns * p.rows;
  const lines = ["WEBVTT", ""];
  for (let i = 0; i < p.count; i++) {
    const start = i * s.intervalSec;
    const end = Math.min(duration, (i + 1) * s.intervalSec);
    if (end <= start) break;
    const within = i % perSheet;
    const x = (within % p.columns) * p.tileWidth;
    const y = Math.floor(within / p.columns) * p.tileHeight;
    lines.push(
      `${timestamp(start)} --> ${timestamp(end)}`,
      `${sheetName(Math.floor(i / perSheet))}#xywh=${x},${y},${p.tileWidth},${p.tileHeight}`,
      "",
    );
  }
  return lines.join("\n");
}
