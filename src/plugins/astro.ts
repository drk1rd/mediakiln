import { fileURLToPath } from "node:url";
import { optimize } from "../optimize.js";
import { formatSummary } from "../summary.js";
import { adaptLogger, baseFromFramework, type PluginOptions } from "./shared.js";

export type MediakilnAstroOptions = PluginOptions;

interface AstroLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/** Structural subset of Astro's `AstroIntegration`, so mediakiln doesn't depend on astro. */
export interface MediakilnAstroIntegration {
  name: string;
  hooks: {
    "astro:config:done": (params: { config: { base: string; root: URL } }) => void;
    "astro:build:done": (params: { dir: URL; logger: AstroLogger }) => Promise<void>;
  };
}

/**
 * Astro integration: after `astro build`, optimize the media in the static output.
 *
 * ```js
 * import mediakiln from "mediakiln/astro";
 * export default defineConfig({ integrations: [mediakiln()] });
 * ```
 */
export default function mediakiln(options: MediakilnAstroOptions = {}): MediakilnAstroIntegration {
  let base = "/";
  let root: string | undefined;
  return {
    name: "mediakiln",
    hooks: {
      "astro:config:done": ({ config }) => {
        base = config.base;
        root = fileURLToPath(config.root);
      },
      "astro:build:done": async ({ dir, logger: astroLogger }) => {
        const { dir: dirOverride, ...rest } = options;
        const logger = adaptLogger(astroLogger);
        const summary = await optimize({
          base: baseFromFramework(base, (m) => astroLogger.warn(m)),
          logger,
          ...rest,
          cwd: rest.cwd ?? root,
          dir: dirOverride ?? fileURLToPath(dir),
        });
        logger.info(formatSummary(summary));
      },
    },
  };
}

export { mediakiln };
