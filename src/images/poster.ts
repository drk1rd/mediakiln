import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

/** Resize to at most `maxHeight` and encode a poster image as `poster.<ext>`. */
export async function encodePoster(
  input: string,
  outDir: string,
  format: "webp" | "avif" | "jpeg",
  quality: number,
  maxHeight: number,
): Promise<{ file: string; bytes: number; width: number; height: number }> {
  const ext = format === "jpeg" ? "jpg" : format;
  const file = `poster.${ext}`;
  const target = path.join(outDir, file);
  const tmpTarget = target + ".tmp";
  let pipeline = sharp(input).rotate().resize({ height: maxHeight, withoutEnlargement: true });
  pipeline =
    format === "webp"
      ? pipeline.webp({ quality })
      : format === "avif"
        ? pipeline.avif({ quality })
        : pipeline.jpeg({ quality, mozjpeg: true });
  const info = await pipeline.toFile(tmpTarget);
  await fs.rename(tmpTarget, target);
  return { file, bytes: info.size, width: info.width, height: info.height };
}
