import path from "node:path";
import { glob } from "tinyglobby";
import { loadConfigFile, resolveConfig, deepMerge, type Config } from "./config.js";
import { createLogger, type Logger } from "./util/logger.js";
import { isDirectory } from "./util/fs.js";
import { emptySummary, type Summary } from "./summary.js";
import { VERSION } from "./version.js";

export type { Config, ResolvedConfig } from "./config.js";
export { defineConfig, resolveConfig, DEFAULT_CONFIG } from "./config.js";
export { formatSummary, type Summary, type AssetFailure } from "./summary.js";
export { VERSION } from "./version.js";

export interface OptimizeOptions extends Config {
  /** Built site directory. */
  dir: string;
  /** Config file path, or `false` to skip config file discovery. */
  configFile?: string | false;
  /** Working directory for config discovery and the cache dir. Default: process.cwd(). */
  cwd?: string;
  dryRun?: boolean;
  logger?: Logger;
}

export async function optimize(options: OptimizeOptions): Promise<Summary> {
  const started = Date.now();
  const {
    dir: dirOption,
    configFile,
    cwd = process.cwd(),
    dryRun = false,
    logger: _l,
    ...overrides
  } = options;
  const logger = options.logger ?? createLogger();
  const dir = path.resolve(cwd, dirOption);
  if (!(await isDirectory(dir))) throw new Error(`Not a directory: ${dir}`);

  const fileConfig = configFile === false ? undefined : await loadConfigFile(configFile, cwd);
  if (fileConfig) logger.debug(`config: ${fileConfig.path}`);
  const config = resolveConfig(deepMerge(fileConfig?.config ?? {}, overrides), logger);

  const summary = emptySummary(VERSION, dirOption, dryRun);
  const pages = await glob(config.include, {
    cwd: dir,
    ignore: [...config.exclude, `${config.outDirName}/**`],
    onlyFiles: true,
  });
  summary.pages.scanned = pages.length;
  summary.durationMs = Date.now() - started;
  return summary;
}
