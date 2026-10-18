import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { optimize } from "../optimize.js";
import { formatSummary } from "../summary.js";
import { adaptLogger, baseFromFramework, type PluginOptions } from "./shared.js";

export type MediakilnViteOptions = PluginOptions;

/**
 * Vite plugin: after a production build, optimize the media in `build.outDir`.
 *
 * ```ts
 * import mediakiln from "mediakiln/vite";
 * export default defineConfig({ plugins: [mediakiln()] });
 * ```
 */
export default function mediakiln(options: MediakilnViteOptions = {}): Plugin {
  let config: ResolvedConfig;
  return {
    name: "mediakiln",
    apply: "build",
    enforce: "post",
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle(error?: Error) {
      if (error) return;
      // Vite 6+ runs closeBundle once per environment; only the browser build has HTML.
      const env = (this as { environment?: { name: string } }).environment;
      if (env ? env.name !== "client" : config.build.ssr) return;

      const { dir, ...rest } = options;
      const logger = adaptLogger(
        {
          info: (m) => config.logger.info(m),
          warn: (m) => config.logger.warn(m),
          error: (m) => config.logger.error(m),
        },
        config.logLevel === "silent" ? "silent" : config.logLevel === "error" ? "error" : "info",
      );
      const summary = await optimize({
        base: baseFromFramework(config.base, (m) => config.logger.warn(m)),
        logger,
        ...rest,
        cwd: rest.cwd ?? config.root,
        dir: path.resolve(config.root, dir ?? config.build.outDir),
      });
      logger.info(formatSummary(summary));
      if (summary.failures.length > 0) {
        config.logger.warn(
          `mediakiln: ${summary.failures.length} asset(s) failed and were left as-is`,
        );
      }
    },
  };
}

export { mediakiln };
