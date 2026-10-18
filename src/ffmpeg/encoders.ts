import type { VideoCodec, VideoConfig } from "../config.js";
import { run } from "./run.js";

export type Hardware = "software" | "videotoolbox" | "nvenc";

const ENCODERS: Record<VideoCodec, Record<Hardware, string>> = {
  h264: { software: "libx264", videotoolbox: "h264_videotoolbox", nvenc: "h264_nvenc" },
  hevc: { software: "libx265", videotoolbox: "hevc_videotoolbox", nvenc: "hevc_nvenc" },
  // VideoToolbox can't encode AV1; fall back to SVT-AV1 on Macs.
  av1: { software: "libsvtav1", videotoolbox: "libsvtav1", nvenc: "av1_nvenc" },
};

/** Codec tag + CODECS family for players. Apple requires `hvc1` (not `hev1`) for HEVC. */
const TAGS: Partial<Record<VideoCodec, string>> = { hevc: "hvc1" };

/** Bitrate relative to H.264 at similar quality. */
export const CODEC_EFFICIENCY: Record<VideoCodec, number> = { h264: 1, hevc: 0.65, av1: 0.55 };

export function encoderFor(codec: VideoCodec, hw: Hardware): string {
  return ENCODERS[codec][hw];
}

const SVT_PRESET: Record<string, string> = {
  ultrafast: "11",
  superfast: "11",
  veryfast: "10",
  faster: "9",
  fast: "8",
  medium: "8",
  slow: "6",
  slower: "5",
  veryslow: "4",
};

export interface EncodeOptions {
  codec: VideoCodec;
  hw: Hardware;
  preset: VideoConfig["mp4"]["preset"];
  /** Target bitrate in kbps (HLS). When absent, constant quality from `crf` is used (MP4). */
  kbps?: number;
  crf?: number;
}

const k = (n: number) => `${Math.round(n)}k`;

/**
 * Encoder arguments for one output video stream. `spec` is the stream specifier suffix:
 * `""` for single-stream outputs (`-c:v`) or `":0"`, `":1"` … for HLS variants (`-c:v:0`).
 */
export function videoEncodeArgs(o: EncodeOptions, spec = ""): string[] {
  const enc = encoderFor(o.codec, o.hw);
  const a = (opt: string, value: string) => [`-${opt}:v${spec}`, value];
  const args: string[] = a("c", enc);
  const tag = TAGS[o.codec];
  if (tag) args.push(...a("tag", tag));

  // Rate control
  if (o.kbps !== undefined) {
    args.push(...a("b", k(o.kbps)));
    // SVT-AV1 only accepts a max bitrate in CRF mode; its VBR stays close to target anyway.
    if (enc !== "libsvtav1") {
      args.push(...a("maxrate", k(o.kbps * 1.07)), ...a("bufsize", k(o.kbps * 1.5)));
    }
  } else {
    const crf = o.crf ?? 23;
    if (enc === "libx264" || enc === "libx265" || enc === "libsvtav1") {
      // SVT-AV1's CRF scale (0–63) runs higher than x264's for similar quality.
      args.push(...a("crf", String(enc === "libsvtav1" ? Math.min(63, crf + 10) : crf)));
    } else if (o.hw === "videotoolbox") {
      // Constant quality (0–100, higher is better): CRF 23 ≈ q 60.
      args.push(...a("q", String(Math.max(1, Math.min(100, Math.round(100 - crf * 1.75))))));
    } else {
      args.push(...a("rc", "vbr"), ...a("cq", String(crf)), ...a("b", "0"));
    }
  }

  // Speed / profile
  switch (enc) {
    case "libx264":
      args.push(...a("preset", o.preset), ...a("profile", "high"));
      break;
    case "libx265":
      args.push(...a("preset", o.preset), `-x265-params:v${spec}`, "log-level=error");
      break;
    case "libsvtav1":
      args.push(
        ...a("preset", SVT_PRESET[o.preset] ?? "8"),
        `-svtav1-params:v${spec}`,
        "log-level=1",
      );
      break;
    case "h264_videotoolbox":
      args.push(...a("profile", "high"), ...a("allow_sw", "1"));
      break;
    case "hevc_videotoolbox":
      args.push(...a("allow_sw", "1"));
      break;
    default: // nvenc
      args.push(...a("preset", "p5"));
      if (o.codec === "h264") args.push(...a("profile", "high"));
  }
  return args;
}

let detected: Promise<Hardware> | undefined;

/** Pick an encoder family: the configured one, or for "auto" the first that actually works. */
export function resolveHardware(ffmpeg: string, choice: VideoConfig["encoder"]): Promise<Hardware> {
  if (choice !== "auto") return Promise.resolve(choice);
  detected ??= (async () => {
    const candidates: Hardware[] =
      process.platform === "darwin" ? ["videotoolbox", "nvenc"] : ["nvenc"];
    for (const hw of candidates) {
      // Listing an encoder doesn't mean the hardware is present: try a tiny encode.
      try {
        await run(ffmpeg, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=256x256:d=0.2",
          "-frames:v",
          "2",
          "-c:v",
          encoderFor("h264", hw),
          "-f",
          "null",
          "-",
        ]);
        return hw;
      } catch {
        // try the next one
      }
    }
    return "software";
  })();
  return detected;
}
