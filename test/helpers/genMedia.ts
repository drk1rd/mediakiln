import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

export const MEDIA_DIR = path.resolve(import.meta.dirname, "../.tmp/media");

function ffmpeg(args: string[]) {
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: "inherit",
  });
}

/** Generate `name` once via `make(tmpPath)`; reuse it on later test runs. */
async function once(name: string, make: (out: string) => void | Promise<void>): Promise<string> {
  const out = path.join(MEDIA_DIR, name);
  if (existsSync(out)) return out;
  mkdirSync(MEDIA_DIR, { recursive: true });
  const tmp = path.join(MEDIA_DIR, `tmp-${process.pid}-${name}`);
  await make(tmp);
  renameSync(tmp, out);
  return out;
}

/** 15s 1080p H.264/AAC with audio. Long enough for the HLS path. */
export const longMp4 = () =>
  once("long.mp4", (out) =>
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=15:size=1920x1080:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=15",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-f",
      "mp4",
      out,
    ]),
  );

/** 4s 720p H.264, no audio, moov atom at the end (ffmpeg's default). MP4-only + remux path. */
export const shortMp4 = () =>
  once("short.mp4", (out) =>
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=4:size=1280x720:rate=30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "mp4",
      out,
    ]),
  );

/** 3s 1920x1080 H.264 .mov tagged with a 90° display rotation → displays as 1080x1920. */
export const rotatedMov = () =>
  once("rotated.mov", async (out) => {
    const plain = out + ".plain.mp4";
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=3:size=1920x1080:rate=30",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "mp4",
      plain,
    ]);
    ffmpeg(["-display_rotation:v:0", "90", "-i", plain, "-c", "copy", "-f", "mov", out]);
    const { rmSync } = await import("node:fs");
    rmSync(plain);
  });

/** 2s VP9 WebM with Opus audio: not web-ready as MP4, forces the re-encode path. */
export const webm = () =>
  once("clip.webm", (out) =>
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=2:size=640x360:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=2",
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-b:v",
      "300k",
      "-c:a",
      "libopus",
      "-shortest",
      "-f",
      "webm",
      out,
    ]),
  );

/**
 * 3s animated GIF at 10 fps with odd dimensions (321x241), so the MP4 needs even-size scaling.
 * The palette pass keeps it a realistic size for a GIF.
 */
export const animatedGif = () =>
  once("anim.gif", (out) =>
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=3:size=322x242:rate=10",
      "-vf",
      "format=rgb24,crop=321:241:0:0,split[a][b];[a]palettegen[p];[b][p]paletteuse",
      "-f",
      "gif",
      out,
    ]),
  );

/** A single-frame GIF: must stay an `<img>`. */
export const stillGif = () =>
  once("still.gif", (out) =>
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=200x100:rate=1",
      "-frames:v",
      "1",
      "-f",
      "gif",
      out,
    ]),
  );

/** Noisy gradient so encoders have real work to do. */
async function noisyImage(width: number, height: number) {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  let seed = 42;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = (seed >> 16) % 24;
      const i = (y * width + x) * channels;
      data[i] = Math.min(255, Math.round((x / width) * 255) + n);
      data[i + 1] = Math.min(255, Math.round((y / height) * 255) + n);
      data[i + 2] = Math.min(255, 128 + n);
    }
  }
  return sharp(data, { raw: { width, height, channels } });
}

export const heroJpg = () =>
  once("hero.jpg", async (out) => {
    await (await noisyImage(3000, 2000)).jpeg({ quality: 95 }).toFile(out);
  });

export const smallPng = () =>
  once("small.png", async (out) => {
    await (await noisyImage(800, 600)).png().toFile(out);
  });

/** JPEG stored landscape (1200x800) with EXIF orientation 6 → displays as 800x1200. */
export const orientedJpg = () =>
  once("oriented.jpg", async (out) => {
    await (
      await noisyImage(1200, 800)
    )
      .jpeg({ quality: 90 })
      .withMetadata({ orientation: 6 })
      .toFile(out);
  });

export async function generateAll() {
  return {
    long: await longMp4(),
    short: await shortMp4(),
    rotated: await rotatedMov(),
    webm: await webm(),
    hero: await heroJpg(),
    small: await smallPng(),
    oriented: await orientedJpg(),
    anim: await animatedGif(),
    still: await stillGif(),
  };
}
