import { cpSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { generateAll } from "./genMedia.js";

const TMP = path.resolve(import.meta.dirname, "../.tmp");
const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/site");

/** Copy the fixture site plus generated media into a fresh temp dir. */
export async function makeSite(): Promise<{ dir: string; root: string; cleanup: () => void }> {
  const media = await generateAll();
  mkdirSync(TMP, { recursive: true });
  const root = mkdtempSync(path.join(TMP, "site-"));
  const dir = path.join(root, "dist");
  cpSync(FIXTURE, dir, { recursive: true });
  mkdirSync(path.join(dir, "media"), { recursive: true });
  mkdirSync(path.join(dir, "img"), { recursive: true });
  cpSync(media.long, path.join(dir, "media/long.mp4"));
  cpSync(media.short, path.join(dir, "media/short.mp4"));
  cpSync(media.rotated, path.join(dir, "media/rotated.mov"));
  cpSync(media.webm, path.join(dir, "media/clip.webm"));
  cpSync(media.hero, path.join(dir, "img/hero.jpg"));
  cpSync(media.small, path.join(dir, "img/small.png"));
  cpSync(media.oriented, path.join(dir, "img/oriented.jpg"));
  return { dir, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
