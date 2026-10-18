import { optimize } from "../optimize.js";
import { formatSummary } from "../summary.js";
import { createLogger } from "../util/logger.js";
import type { PluginOptions } from "./shared.js";

export type MediakilnDocusaurusOptions = PluginOptions;

/** Structural subset of Docusaurus's plugin API, so mediakiln doesn't depend on it. */
export interface DocusaurusContext {
  siteDir: string;
}

export interface DocusaurusPostBuildProps {
  outDir: string;
  siteConfig: { baseUrl: string; url: string };
}

/**
 * Docusaurus plugin: after `docusaurus build`, optimize the media in the build output.
 *
 * ```js
 * // docusaurus.config.js
 * export default { plugins: [["mediakiln/docusaurus", { video: { hls: { minDurationSec: 20 } } }]] };
 * ```
 */
export default function mediakiln(
  context: DocusaurusContext,
  options: MediakilnDocusaurusOptions = {},
) {
  return {
    name: "mediakiln",
    async postBuild({ outDir, siteConfig }: DocusaurusPostBuildProps) {
      const { dir, ...rest } = options;
      const logger = rest.logger ?? createLogger();
      const summary = await optimize({
        base: siteConfig.baseUrl,
        site: siteConfig.url,
        logger,
        ...rest,
        cwd: rest.cwd ?? context.siteDir,
        dir: dir ?? outDir,
      });
      logger.info(formatSummary(summary));
    },
  };
}

export { mediakiln };
