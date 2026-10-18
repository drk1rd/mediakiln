import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { run } from "./run.js";

export interface CaptionTrack {
  file: string;
  kind: "subtitles" | "captions";
  srclang?: string;
  label?: string;
  default: boolean;
}

export interface CaptionsResult {
  kind: "captions";
  master: string;
  tracks: number;
  /** Hash folder of the video whose variants this master points at. */
  video: string;
}

/** Content key: the video's output plus every caption file and its attributes. */
export async function captionsKey(videoKey: string, tracks: CaptionTrack[]): Promise<string> {
  const h = createHash("sha256").update("captions\0" + videoKey);
  for (const t of tracks) {
    h.update("\0" + JSON.stringify({ ...t, file: undefined }) + "\0");
    h.update(await fs.readFile(t.file));
  }
  return h.digest("hex");
}

/**
 * WebVTT for HLS needs an `X-TIMESTAMP-MAP` header mapping cue time 0 to the media timeline.
 * Any existing map is replaced.
 */
export function withTimestampMap(vtt: string, mpegts: number): string {
  const text = vtt.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const header = lines[0]?.startsWith("WEBVTT") ? lines.shift()! : "WEBVTT";
  const rest = lines.filter((l, i) => !(i < 5 && l.startsWith("X-TIMESTAMP-MAP=")));
  return [header, `X-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:00:00:00.000`, ...rest].join("\n");
}

/** Single-segment subtitle media playlist covering the whole video. */
export function subtitlePlaylist(duration: number, segment = "subs.vtt"): string {
  const d = Math.max(1, duration);
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.ceil(d)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXTINF:${d.toFixed(3)},`,
    segment,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

const CAPTION_CHARACTERISTICS =
  "public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound";

/**
 * A new master playlist: the video's variants (URIs rewritten to `videoPrefix`) plus one
 * `EXT-X-MEDIA:TYPE=SUBTITLES` rendition per track, attached to every variant.
 */
export function captionsMaster(
  videoMaster: string,
  videoPrefix: string,
  tracks: CaptionTrack[],
): string {
  const media = tracks.map((t, i) => {
    const name = t.label || t.srclang || `Track ${i + 1}`;
    const attrs = [
      "TYPE=SUBTITLES",
      'GROUP-ID="subs"',
      `NAME="${name.replace(/"/g, "'")}"`,
      ...(t.srclang ? [`LANGUAGE="${t.srclang}"`] : []),
      `DEFAULT=${t.default ? "YES" : "NO"}`,
      "AUTOSELECT=YES",
      "FORCED=NO",
      ...(t.kind === "captions" ? [`CHARACTERISTICS="${CAPTION_CHARACTERISTICS}"`] : []),
      `URI="subs/${i}/index.m3u8"`,
    ];
    return `#EXT-X-MEDIA:${attrs.join(",")}`;
  });
  const out: string[] = [];
  let inserted = false;
  const lines = videoMaster.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inserted && line.startsWith("#EXT-X-STREAM-INF:")) {
      out.push(...media, "");
      inserted = true;
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      out.push(`${line},SUBTITLES="subs"`);
    } else if (line && !line.startsWith("#") && /^#EXT-X-STREAM-INF:/.test(lines[i - 1] ?? "")) {
      out.push(videoPrefix + line);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** First presentation timestamp of an MPEG-TS segment, in 90 kHz units. */
async function tsStart(ffprobe: string, segment: string): Promise<number> {
  try {
    const { stdout } = await run(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=start_time",
      "-of",
      "default=nw=1:nk=1",
      segment,
    ]);
    const sec = Number(stdout.trim());
    return Number.isFinite(sec) ? Math.round(sec * 90000) : 0;
  } catch {
    return 0;
  }
}

export interface BuildCaptionsOptions {
  ffprobe: string;
  /** Absolute path of the video's output folder (contains hls/master.m3u8). */
  videoDir: string;
  /** The video's hash folder name. */
  videoHash: string;
  duration: number;
  segmentType: "fmp4" | "mpegts";
  tracks: CaptionTrack[];
}

export async function buildCaptions(
  o: BuildCaptionsOptions,
  outDir: string,
): Promise<CaptionsResult> {
  const master = await fs.readFile(path.join(o.videoDir, "hls/master.m3u8"), "utf8");
  // fMP4 segments start at 0; MPEG-TS segments carry ffmpeg's default 1.4 s offset.
  const mpegts =
    o.segmentType === "mpegts"
      ? await tsStart(o.ffprobe, path.join(o.videoDir, "hls/v0/seg_000.ts"))
      : 0;
  for (const [i, t] of o.tracks.entries()) {
    const dir = path.join(outDir, "subs", String(i));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "subs.vtt"),
      withTimestampMap(await fs.readFile(t.file, "utf8"), mpegts),
    );
    await fs.writeFile(path.join(dir, "index.m3u8"), subtitlePlaylist(o.duration));
  }
  await fs.writeFile(
    path.join(outDir, "master.m3u8"),
    captionsMaster(master, `../${o.videoHash}/hls/`, o.tracks),
  );
  return { kind: "captions", master: "master.m3u8", tracks: o.tracks.length, video: o.videoHash };
}
