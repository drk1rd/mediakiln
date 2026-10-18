import type { Config } from "./config.js";

export interface CliFlags {
  config?: string;
  base?: string;
  cacheDir?: string;
  cache?: boolean;
  video?: boolean;
  images?: boolean;
  hls?: boolean;
  concurrency?: string | number;
  dryRun?: boolean;
  verbose?: boolean;
  json?: boolean;
}

/** Turn CLI flags into config overrides. Only flags the user actually passed are set. */
export function flagsToOverrides(flags: CliFlags): Config {
  const overrides: Config = {};
  if (flags.base !== undefined) overrides.base = String(flags.base);
  if (flags.cacheDir !== undefined) overrides.cacheDir = String(flags.cacheDir);
  if (flags.cache === false) overrides.cache = false;
  if (flags.concurrency !== undefined) {
    const n = Number(flags.concurrency);
    if (!Number.isInteger(n) || n < 1) throw new Error("--concurrency must be a positive integer");
    overrides.concurrency = n;
  }
  if (flags.video === false) overrides.video = { ...overrides.video, enabled: false };
  if (flags.hls === false) overrides.video = { ...overrides.video, hls: { enabled: false } };
  if (flags.images === false) overrides.images = { enabled: false };
  return overrides;
}
