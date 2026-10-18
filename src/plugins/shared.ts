import type { OptimizeOptions } from "../optimize.js";
import { createLogger, type Logger, type LogLevel } from "../util/logger.js";

/** Options accepted by every framework plugin: everything `optimize()` takes except `dir`. */
export type PluginOptions = Omit<OptimizeOptions, "dir"> & {
  /** Override the output directory (defaults to the framework's build output). */
  dir?: string;
};

interface FrameworkLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

/** Route mediakiln's logs through a framework logger so they match the host's output. */
export function adaptLogger(host: FrameworkLogger, level: LogLevel = "info"): Logger {
  const base = createLogger({ level });
  return {
    get level() {
      return base.level;
    },
    set level(l) {
      base.level = l;
    },
    error: (m) => base.level !== "silent" && host.error(m),
    warn: (m) => ["warn", "info", "debug"].includes(base.level) && host.warn(m),
    info: (m) => ["info", "debug"].includes(base.level) && host.info(m),
    debug: (m) => base.level === "debug" && (host.debug ?? host.info)(m),
  };
}

/**
 * Frameworks allow relative ("./") or absolute-URL bases; mediakiln emits root-relative URLs,
 * so take the URL's path, and fall back to "/" for relative bases.
 */
export function baseFromFramework(base: string | undefined, warn?: (m: string) => void): string {
  if (!base) return "/";
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(base)) return new URL(base).pathname;
  if (base.startsWith("/")) return base;
  warn?.(
    `mediakiln: relative base "${base}" is not supported; generated URLs will start at "/". ` +
      `Pass { base: "/your/path/" } to override.`,
  );
  return "/";
}
