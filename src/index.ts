export { optimize, type OptimizeOptions } from "./optimize.js";
export type { Config, ResolvedConfig, Rendition } from "./config.js";
export { defineConfig, resolveConfig, DEFAULT_CONFIG } from "./config.js";
export { formatSummary, type Summary, type AssetFailure } from "./summary.js";
export type { Manifest, ManifestEntry } from "./manifest.js";
export type { AssetResult, VideoResult, ImageResult, PosterResult } from "./assets.js";
export { createLogger, type Logger, type LogLevel } from "./util/logger.js";
export { VERSION } from "./version.js";
export type { PluginOptions } from "./plugins/shared.js";
