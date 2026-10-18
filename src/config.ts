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

const configSchema = z.object({
  base: z.string(),
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
  video: z.object({
    enabled: z.boolean(),
    hls: z.object({
      enabled: z.boolean(),
      minDurationSec: z.number().nonnegative(),
      minSizeMB: z.number().nonnegative(),
      segmentSec: z.number().positive(),
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
    gifToVideo: z.boolean(),
  }),
});

export type ResolvedConfig = z.infer<typeof configSchema>;
export type Rendition = z.infer<typeof renditionSchema>;
export type VideoConfig = ResolvedConfig["video"];
export type ImagesConfig = ResolvedConfig["images"];

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** User-facing config: every field optional. */
export type Config = DeepPartial<ResolvedConfig>;

export const DEFAULT_CONFIG: ResolvedConfig = {
  base: "/",
  outDirName: "_mediakiln",
  include: ["**/*.html"],
  exclude: [],
  keepOriginals: true,
  cache: true,
  cacheDir: ".mediakiln-cache",
  concurrency: Math.max(1, os.availableParallelism?.() ?? os.cpus().length),
  video: {
    enabled: true,
    hls: {
      enabled: true,
      minDurationSec: 10,
      minSizeMB: 5,
      segmentSec: 4,
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
  },
  images: {
    enabled: true,
    formats: ["avif", "webp"],
    widths: [480, 768, 1080, 1600, 2400],
    quality: { avif: 50, webp: 75, jpeg: 78, png: 80 },
    sizes: "100vw",
    lazy: true,
    skip: ["**/*.svg"],
    gifToVideo: true,
  },
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
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid mediakiln config:\n${issues}`);
  }
  const config = result.data;
  config.base = normalizeBase(config.base);
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
