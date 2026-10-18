import { createRequire } from "node:module";
import { run } from "./run.js";

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
  /** First line of `ffmpeg -version`. */
  version: string;
}

export class FfmpegNotFoundError extends Error {
  override name = "FfmpegNotFoundError";
  constructor(detail: string) {
    super(
      [
        `ffmpeg/ffprobe not found (${detail}).`,
        "mediakiln needs ffmpeg with libx264 to process video. Install it with one of:",
        "  macOS:          brew install ffmpeg",
        "  Debian/Ubuntu:  sudo apt-get install ffmpeg",
        "  Windows:        winget install ffmpeg",
        "or point FFMPEG_PATH and FFPROBE_PATH at the binaries,",
        "or install the optional packages: npm i -D ffmpeg-static ffprobe-static",
        "Use --no-video to skip video processing.",
      ].join("\n"),
    );
  }
}

async function works(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(bin, ["-version"]);
    return stdout.split("\n")[0]?.trim() ?? "";
  } catch {
    return undefined;
  }
}

function staticBinary(pkg: "ffmpeg-static" | "ffprobe-static"): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const mod = require(pkg) as string | { path?: string } | null;
    if (typeof mod === "string") return mod;
    return mod?.path;
  } catch {
    return undefined;
  }
}

let cached: Promise<FfmpegBinaries> | undefined;

/**
 * Locate ffmpeg and ffprobe. Order: FFMPEG_PATH/FFPROBE_PATH env vars, binaries on PATH,
 * then the optional `ffmpeg-static`/`ffprobe-static` packages.
 */
export function findFfmpeg(): Promise<FfmpegBinaries> {
  cached ??= locate().catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return cached;
}

async function locate(): Promise<FfmpegBinaries> {
  const ffmpegCandidates = [process.env.FFMPEG_PATH, "ffmpeg", staticBinary("ffmpeg-static")];
  const ffprobeCandidates = [process.env.FFPROBE_PATH, "ffprobe", staticBinary("ffprobe-static")];

  let ffmpeg: string | undefined;
  let version: string | undefined;
  for (const c of ffmpegCandidates) {
    if (!c) continue;
    version = await works(c);
    if (version !== undefined) {
      ffmpeg = c;
      break;
    }
  }
  let ffprobe: string | undefined;
  for (const c of ffprobeCandidates) {
    if (!c) continue;
    if ((await works(c)) !== undefined) {
      ffprobe = c;
      break;
    }
  }
  if (!ffmpeg || !ffprobe) {
    const missing = [!ffmpeg && "ffmpeg", !ffprobe && "ffprobe"].filter(Boolean).join(" and ");
    throw new FfmpegNotFoundError(`could not run ${missing}`);
  }
  return { ffmpeg, ffprobe, version: version ?? "" };
}
