import { optimize } from "../optimize.js";
import { formatSummary } from "../summary.js";
import { createLogger } from "../util/logger.js";
import { baseFromFramework, type PluginOptions } from "./shared.js";

export type MediakilnEleventyOptions = PluginOptions & {
  /**
   * Run during `--serve`/`--watch` too. Default: only for one-off builds, since encoding
   * video on every save is slow.
   */
  enabled?: boolean;
};

interface EleventyAfterEvent {
  dir: { output: string };
  runMode?: "build" | "watch" | "serve";
}

/** Structural subset of Eleventy's config API. */
export interface EleventyConfigLike {
  on(event: "eleventy.after", cb: (event: EleventyAfterEvent) => unknown): unknown;
  pathPrefix?: string;
}

/**
 * Eleventy plugin: after a build, optimize the media in the output directory.
 *
 * ```js
 * import mediakiln from "mediakiln/eleventy";
 * export default function (eleventyConfig) {
 *   eleventyConfig.addPlugin(mediakiln, { video: { hls: { minDurationSec: 20 } } });
 * }
 * ```
 */
export default function mediakiln(
  eleventyConfig: EleventyConfigLike,
  options: MediakilnEleventyOptions = {},
): void {
  eleventyConfig.on("eleventy.after", async ({ dir, runMode }) => {
    const { enabled, dir: dirOverride, ...rest } = options;
    if (enabled === false) return;
    if ((runMode === "serve" || runMode === "watch") && !enabled) return;
    const logger = rest.logger ?? createLogger();
    const summary = await optimize({
      base: baseFromFramework(eleventyConfig.pathPrefix),
      logger,
      ...rest,
      dir: dirOverride ?? dir.output,
    });
    logger.info(formatSummary(summary));
  });
}

export { mediakiln };
