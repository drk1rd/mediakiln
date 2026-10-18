import { promises as fs } from "node:fs";
import { run } from "./run.js";

export interface ProbeResult {
  /** Display width (after applying rotation). */
  width: number;
  /** Display height (after applying rotation). */
  height: number;
  /** Rotation in degrees from metadata, normalized to 0/90/180/270. */
  rotation: number;
  duration: number;
  fps: number;
  videoCodec: string;
  pixFmt: string;
  hasAudio: boolean;
  audioCodec?: string;
  /** Total bitrate in bits per second. */
  bitrate: number;
  size: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number | string }>;
  disposition?: { attached_pic?: number };
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string; size?: string };
}

export function probeArgs(input: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", input];
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !Number.isFinite(n)) return 0;
  return d ? n / d : n;
}

function normalizeRotation(deg: number): number {
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r;
}

/** Turn raw ffprobe JSON into the fields mediakiln needs. Pure, for testability. */
export function parseProbe(data: FfprobeOutput, fileSize: number): ProbeResult {
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!video || !video.width || !video.height) throw new Error("No video stream found");
  const audio = streams.find((s) => s.codec_type === "audio");

  let rotation = 0;
  const side = video.side_data_list?.find((d) => d.rotation !== undefined);
  if (side?.rotation !== undefined) rotation = Number(side.rotation);
  else if (video.tags?.rotate) rotation = Number(video.tags.rotate);
  rotation = normalizeRotation(Number.isFinite(rotation) ? rotation : 0);

  const swap = rotation === 90 || rotation === 270;
  const duration = Number(data.format?.duration ?? video.duration ?? 0) || 0;
  let bitrate = Number(data.format?.bit_rate ?? 0) || 0;
  if (!bitrate && duration > 0) bitrate = Math.round((fileSize * 8) / duration);

  return {
    width: swap ? video.height : video.width,
    height: swap ? video.width : video.height,
    rotation,
    duration,
    fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
    videoCodec: video.codec_name ?? "unknown",
    pixFmt: video.pix_fmt ?? "unknown",
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name,
    bitrate,
    size: fileSize,
  };
}

export async function probe(ffprobe: string, input: string): Promise<ProbeResult> {
  const [{ stdout }, stat] = await Promise.all([run(ffprobe, probeArgs(input)), fs.stat(input)]);
  return parseProbe(JSON.parse(stdout) as FfprobeOutput, stat.size);
}
