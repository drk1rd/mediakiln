import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Logger } from "./util/logger.js";

const renditionSchema = z.object({
  height: z.number().int().positive(),
  videoKbps: z.number().positive(),
  audioKbps: z.number().positive(),
});

const codecSchema = z.enum(["h264", "hevc", "av1"]);

const remoteCacheSchema = z.object({
  /** S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, …). */
  bucket: z.string().min(1),
  prefix: z.string(),
  /** Custom endpoint, e.g. https://<account>.r2.cloudflarestorage.com. Default: AWS. */
  endpoint: z.string(),
  region: z.string(),
  /** Upload new entries (turn off for read-only CI jobs, e.g. on pull requests). */
  write: z.boolean(),
});

const configSchema = z.object({
  base: z.string(),
  /** Public origin of the site (https://example.com). Enables og:image and same-origin URLs. */
  site: z.string(),
  outDirName: z
    .string()
    .min(1)
    .refine((s) => !/[\\/]/.test(s) && s !== "." && s !== "..", "must be a single folder name"),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  keepOriginals: z.boolean(),
  cache: z.boolean(),
  cacheDir: z.string(),
  concurrency: z.number().int().positive(),
  remoteCache: remoteCacheSchema.nullable(),
  /** Write `_headers` (Cloudflare Pages, Netlify) so `/_mediakiln/` is cached forever. */
  headers: z.boolean(),
  /** Write `<outDirName>/report.html` summarizing what changed. */
  report: z.boolean(),
  markdown: z.object({
    /** Experimental: also rewrite media in Markdown files (as inline HTML). */
    enabled: z.boolean(),
    include: z.array(z.string()),
  }),
  video: z.object({
    enabled: z.boolean(),
    /** "software" (libx264/libx265/SVT-AV1), "videotoolbox" (macOS), "nvenc" (NVIDIA) or "auto". */
    encoder: z.enum(["software", "videotoolbox", "nvenc", "auto"]),
    hls: z.object({
      enabled: z.boolean(),
      minDurationSec: z.number().nonnegative(),
      minSizeMB: z.number().nonnegative(),
      segmentSec: z.number().positive(),
      /** Length of the first segment, for a faster start. 0 = same as segmentSec. */
      firstSegmentSec: z.number().nonnegative(),
      /** "fmp4" (CMAF, required for HEVC/AV1) or "mpegts". */
      segmentType: z.enum(["fmp4", "mpegts"]),
      /** H.264 is always included; HEVC/AV1 add extra renditions for browsers that support them. */
      codecs: z.array(codecSchema).min(1),
      /** Scale the ladder's bitrates to each video's complexity. */
      perTitle: z.boolean(),
      renditions: z.array(renditionSchema).min(1),
    }),
    mp4: z.object({
      reencode: z.enum(["auto", "always", "never"]),
      crf: z.number().int().min(0).max(51),
      preset: z.enum([
        "ultrafast",
        "superfast",
        "veryfast",
        "faster",
        "fast",
        "medium",
        "slow",
        "slower",
        "veryslow",
      ]),
      maxHeight: z.number().int().positive(),
    }),
    poster: z.object({
      atSec: z.number().nonnegative(),
      format: z.enum(["webp", "avif", "jpeg"]),
      quality: z.number().int().min(1).max(100),
      keepJpeg: z.boolean(),
    }),
    preload: z.enum(["none", "metadata", "auto"]),
    lazy: z.boolean(),
    /** Put local <track> WebVTT captions into the HLS stream as subtitle renditions. */
    captions: z.boolean(),
    thumbnails: z.object({
      enabled: z.boolean(),
      intervalSec: z.number().positive(),
      width: z.number().int().positive(),
      columns: z.number().int().positive(),
    }),
  }),
  images: z.object({
    enabled: z.boolean(),
    formats: z.array(z.enum(["avif", "webp"])),
    widths: z.array(z.number().int().positive()).min(1),
    quality: z.object({
      avif: z.number().int().min(1).max(100),
      webp: z.number().int().min(1).max(100),
      jpeg: z.number().int().min(1).max(100),
      png: z.number().int().min(1).max(100),
    }),
    sizes: z.string(),
    lazy: z.boolean(),
    skip: z.array(z.string()),
    /** Optimize <img> inside an existing <picture>, including art-directed <source>s. */
    pictures: z.boolean(),
    /** Add AVIF/WebP alternatives to an existing local srcset. */
    srcset: z.boolean(),
    /** Rewrite url() backgrounds in CSS files and style attributes to image-set(). */
    css: z.object({ enabled: z.boolean(), include: z.array(z.string()) }),
    /** Resize og:image / twitter:image to 1200px JPEG. */
    openGraph: z.boolean(),
  }),
});

export type ResolvedConfig = z.infer<typeof configSchema>;
export type Rendition = z.infer<typeof renditionSchema>;
export type VideoConfig = ResolvedConfig["video"];
export type ImagesConfig = ResolvedConfig["images"];
export type VideoCodec = z.infer<typeof codecSchema>;
export type RemoteCacheConfig = z.infer<typeof remoteCacheSchema>;

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** User-facing config: every field optional. */
export type Config = DeepPartial<ResolvedConfig>;

export const DEFAULT_CONFIG: ResolvedConfig = {
  base: "/",
  site: "",
  outDirName: "_mediakiln",
  include: ["**/*.html"],
  exclude: [],
  keepOriginals: true,
  cache: true,
  cacheDir: ".mediakiln-cache",
  concurrency: Math.max(1, os.availableParallelism?.() ?? os.cpus().length),
  remoteCache: null,
  headers: true,
  report: false,
  markdown: { enabled: false, include: ["**/*.md", "**/*.mdx"] },
  video: {
    enabled: true,
    encoder: "software",
    hls: {
      enabled: true,
      minDurationSec: 10,
      minSizeMB: 5,
      segmentSec: 4,
      firstSegmentSec: 1,
      segmentType: "fmp4",
      codecs: ["h264"],
      perTitle: false,
      renditions: [
        { height: 360, videoKbps: 800, audioKbps: 96 },
        { height: 720, videoKbps: 2800, audioKbps: 128 },
        { height: 1080, videoKbps: 5000, audioKbps: 128 },
      ],
    },
    mp4: { reencode: "auto", crf: 23, preset: "medium", maxHeight: 1080 },
    poster: { atSec: 1, format: "webp", quality: 80, keepJpeg: false },
    preload: "metadata",
    lazy: true,
    captions: true,
    thumbnails: { enabled: false, intervalSec: 5, width: 160, columns: 10 },
  },
  images: {
    enabled: true,
    formats: ["avif", "webp"],
    widths: [480, 768, 1080, 1600, 2400],
    quality: { avif: 50, webp: 75, jpeg: 78, png: 80 },
    sizes: "100vw",
    lazy: true,
    skip: ["**/*.svg", "**/*.gif"],
    pictures: true,
    srcset: true,
    css: { enabled: true, include: ["**/*.css"] },
    openGraph: true,
  },
};

export const REMOTE_CACHE_DEFAULTS: RemoteCacheConfig = {
  bucket: "",
  prefix: "mediakiln/",
  endpoint: "",
  region: "auto",
  write: true,
};

const CONFIG_FILES = ["mediakiln.config.js", "mediakiln.config.mjs", "mediakiln.config.json"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `override` onto `base`. Arrays and primitives replace; objects merge. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = key in base ? deepMerge((base as Record<string, unknown>)[key], value) : value;
  }
  return out as T;
}

/** Dotted paths of keys in `input` that don't exist in `reference`. */
export function findUnknownKeys(input: unknown, reference: unknown, prefix = ""): string[] {
  if (!isPlainObject(input) || !isPlainObject(reference)) return [];
  const unknown: string[] = [];
  for (const key of Object.keys(input)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (!(key in reference)) unknown.push(p);
    else unknown.push(...findUnknownKeys(input[key], reference[key], p));
  }
  return unknown;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Merge user config over defaults and validate. Unknown keys warn, invalid values throw. */
export function resolveConfig(input: unknown, logger?: Logger): ResolvedConfig {
  if (input !== undefined && !isPlainObject(input)) {
    throw new ConfigError("Config must be an object");
  }
  for (const key of findUnknownKeys(input ?? {}, DEFAULT_CONFIG)) {
    logger?.warn(`Unknown config key "${key}" (ignored)`);
  }
  const merged = deepMerge(DEFAULT_CONFIG, input ?? {});
  if (isPlainObject(merged.remoteCache)) {
    merged.remoteCache = deepMerge(REMOTE_CACHE_DEFAULTS, merged.remoteCache);
  }
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid mediakiln config:\n${issues}`);
  }
  const config = result.data;
  config.base = normalizeBase(config.base);
  config.site = config.site.replace(/\/+$/, "");
  // H.264 is the baseline every browser can play; other codecs are additions.
  config.video.hls.codecs = [
    "h264",
    ...new Set(config.video.hls.codecs.filter((c) => c !== "h264")),
  ];
  return config;
}

/** Ensure the base path starts and ends with "/". */
export function normalizeBase(base: string): string {
  let b = base.trim() || "/";
  if (!b.startsWith("/")) b = "/" + b;
  if (!b.endsWith("/")) b += "/";
  return b;
}

/** Load a config file. Explicit path must exist; otherwise look for defaults in `cwd`. */
export async function loadConfigFile(
  file: string | undefined,
  cwd: string = process.cwd(),
): Promise<{ path: string; config: unknown } | undefined> {
  let resolved: string | undefined;
  if (file) {
    resolved = path.resolve(cwd, file);
    try {
      await fs.access(resolved);
    } catch {
      throw new ConfigError(`Config file not found: ${resolved}`);
    }
  } else {
    for (const name of CONFIG_FILES) {
      const candidate = path.join(cwd, name);
      try {
        await fs.access(candidate);
        resolved = candidate;
        break;
      } catch {
        // try next
      }
    }
  }
  if (!resolved) return undefined;

  if (resolved.endsWith(".json")) {
    try {
      return { path: resolved, config: JSON.parse(await fs.readFile(resolved, "utf8")) };
    } catch (err) {
      throw new ConfigError(`Could not parse ${resolved}: ${(err as Error).message}`);
    }
  }
  const mod = (await import(pathToFileURL(resolved).href)) as { default?: unknown };
  const config = mod.default ?? mod;
  return { path: resolved, config: typeof config === "function" ? await config() : config };
}

/** Helper for typed config files: `export default defineConfig({ ... })`. */
export function defineConfig(config: Config): Config {
  return config;
}
