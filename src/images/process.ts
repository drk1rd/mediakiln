import { promises as fs } from "node:fs";
import { encodePoster } from "./poster.js";
import type { ImageResult, ImageSettings, PosterResult, PosterSettings } from "../assets.js";

export async function processImage(
  _input: string,
  _outDir: string,
  _settings: ImageSettings,
): Promise<ImageResult> {
  throw new Error("Image processing is not implemented yet");
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
