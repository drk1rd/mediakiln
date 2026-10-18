import { promises as fs } from "node:fs";
import path from "node:path";
import sharp, { type Sharp } from "sharp";
import type {
  ImageResult,
  ImageSettings,
  ImageVariant,
  PosterResult,
  PosterSettings,
} from "../assets.js";
import { encodePoster } from "./poster.js";

type Format = ImageVariant["format"];

const EXT: Record<Format, string> = { avif: "avif", webp: "webp", jpeg: "jpg", png: "png" };

/** Configured widths that fit the original; the original width alone if none do. */
export function selectWidths(widths: readonly number[], original: number): number[] {
  const sorted = [...new Set(widths)].sort((a, b) => a - b);
  const fit = sorted.filter((w) => w <= original);
  return fit.length > 0 ? fit : [original];
}

/** The width closest to 1080 from below, or the smallest one when all are wider. */
export function pickFallbackWidth(widths: number[]): number {
  const sorted = [...new Set(widths)].sort((a, b) => a - b);
  const below = sorted.filter((w) => w <= 1080);
  return below.length > 0 ? below[below.length - 1]! : sorted[0]!;
}

/** JPEG/PNG fallback for browsers without AVIF/WebP: PNG when the source is PNG or has alpha. */
export function fallbackFormat(format: string | undefined, hasAlpha: boolean): "jpeg" | "png" {
  return format === "png" || hasAlpha ? "png" : "jpeg";
}

function encode(pipeline: Sharp, format: Format, q: ImageSettings["quality"]): Sharp {
  switch (format) {
    case "avif":
      return pipeline.avif({ quality: q.avif, effort: 4 });
    case "webp":
      return pipeline.webp({ quality: q.webp, effort: 4 });
    case "jpeg":
      return pipeline.jpeg({ quality: q.jpeg, mozjpeg: true });
    case "png":
      return pipeline.png({ quality: q.png, palette: true, compressionLevel: 9, effort: 7 });
  }
}

/**
 * Produce `img-<w>.<ext>` for every selected width in every configured format plus the
 * JPEG/PNG fallback. EXIF orientation is applied; metadata is stripped and colors converted
 * to sRGB.
 */
export async function processImage(
  input: string,
  outDir: string,
  settings: ImageSettings,
): Promise<ImageResult> {
  const [meta, stat] = await Promise.all([sharp(input).metadata(), fs.stat(input)]);
  if (!meta.width || !meta.height) throw new Error("Could not read image dimensions");
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;
  const fallback = fallbackFormat(meta.format, Boolean(meta.hasAlpha));
  const formats: Format[] = [...new Set<Format>([...settings.formats, fallback])];
  const widths = selectWidths(settings.widths, width);
  const sameFormat = meta.format === fallback;

  const base = sharp(input, { failOn: "none" }).rotate();
  const variants: ImageVariant[] = [];
  for (const w of widths) {
    for (const format of formats) {
      const file = `img-${w}.${EXT[format]}`;
      const target = path.join(outDir, file);
      const info = await encode(
        base.clone().resize({ width: w, withoutEnlargement: true }),
        format,
        settings.quality,
      ).toFile(target);
      let bytes = info.size;
      // Never ship a fallback bigger than the original at the same size.
      if (format === fallback && sameFormat && w === width && bytes > stat.size) {
        await fs.copyFile(input, target);
        bytes = stat.size;
      }
      variants.push({ path: file, format, width: w, bytes });
    }
  }
  return pruneVariants(
    { kind: "image", width, height, sourceBytes: stat.size, fallbackFormat: fallback, variants },
    outDir,
  );
}

/**
 * Never make an image worse. Compared at the fallback width:
 * - a modern format that is bigger than the JPEG/PNG fallback is dropped entirely;
 * - if even the fallback is bigger than the whole original file (typical for pixel art and
 *   other images that grow when resampled), the image passes through unchanged.
 */
export async function pruneVariants(result: ImageResult, outDir: string): Promise<ImageResult> {
  const fbWidth = pickFallbackWidth(result.variants.map((v) => v.width));
  const at = (format: Format) =>
    result.variants.find((v) => v.format === format && v.width === fbWidth);
  const fallback = at(result.fallbackFormat)!;
  const remove = (vs: ImageVariant[]) =>
    Promise.all(vs.map((v) => fs.rm(path.join(outDir, v.path), { force: true })));

  if (fallback.bytes > result.sourceBytes) {
    await remove(result.variants);
    return { ...result, variants: [], passthrough: true };
  }
  const losing = new Set(
    result.variants
      .map((v) => v.format)
      .filter((f) => f !== result.fallbackFormat && (at(f)?.bytes ?? 0) > fallback.bytes),
  );
  if (losing.size === 0) return result;
  await remove(result.variants.filter((v) => losing.has(v.format)));
  return { ...result, variants: result.variants.filter((v) => !losing.has(v.format)) };
}

/** Optimize an author-provided video poster image into a single `poster.<ext>`. */
export async function processPoster(
  input: string,
  outDir: string,
  settings: PosterSettings,
): Promise<PosterResult> {
  const { file, bytes, width, height } = await encodePoster(
    input,
    outDir,
    settings.format,
    settings.quality,
    settings.maxHeight,
  );
  const sourceBytes = (await fs.stat(input)).size;
  return { kind: "poster", width, height, sourceBytes, file: { path: file, bytes } };
}
