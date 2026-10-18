import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "./sharp.js";
import type { ConvertResult, ConvertSettings, OgResult, OgSettings } from "../assets.js";

const EXT = { avif: "avif", webp: "webp" } as const;

/**
 * Re-encode an image at its own size into modern formats (no resizing): used for `srcset`
 * candidates the author already sized, and CSS backgrounds. Formats that come out bigger than
 * the original are dropped.
 */
export async function processConvert(
  input: string,
  outDir: string,
  settings: ConvertSettings,
): Promise<ConvertResult> {
  const [meta, stat] = await Promise.all([sharp(input).metadata(), fs.stat(input)]);
  if (!meta.width || !meta.height) throw new Error("Could not read image dimensions");
  const swap = (meta.orientation ?? 1) >= 5;
  const variants: ConvertResult["variants"] = [];
  for (const format of settings.formats) {
    const file = `image.${EXT[format]}`;
    let pipeline = sharp(input, { failOn: "none" }).rotate();
    pipeline =
      format === "avif"
        ? pipeline.avif({ quality: settings.quality.avif, effort: 4 })
        : pipeline.webp({ quality: settings.quality.webp, effort: 4 });
    const info = await pipeline.toFile(path.join(outDir, file));
    if (info.size >= stat.size) {
      await fs.rm(path.join(outDir, file), { force: true });
      continue;
    }
    variants.push({ format, path: file, bytes: info.size });
  }
  return {
    kind: "convert",
    width: swap ? meta.height : meta.width,
    height: swap ? meta.width : meta.height,
    sourceBytes: stat.size,
    sourceFormat: meta.format ?? "unknown",
    variants,
  };
}

/**
 * Social preview image: fit within 1200×1200 (the size Open Graph consumers recommend),
 * flatten transparency onto white and encode as JPEG, the format every crawler accepts.
 */
export async function processOg(
  input: string,
  outDir: string,
  settings: OgSettings,
): Promise<OgResult> {
  const stat = await fs.stat(input);
  const info = await sharp(input, { failOn: "none" })
    .rotate()
    .resize({
      width: settings.maxSize,
      height: settings.maxSize,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: settings.quality, mozjpeg: true })
    .toFile(path.join(outDir, "og.jpg"));
  return {
    kind: "og",
    width: info.width,
    height: info.height,
    sourceBytes: stat.size,
    file: { path: "og.jpg", bytes: info.size },
  };
}
