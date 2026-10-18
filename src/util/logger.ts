export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  level: LogLevel;
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Where log lines go. Defaults to stderr so stdout stays clean for `--json`. */
  write?: (line: string) => void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const write = opts.write ?? ((line: string) => process.stderr.write(line + "\n"));
  const logger: Logger = {
    level: opts.level ?? "info",
    error: (msg) => emit("error", msg),
    warn: (msg) => emit("warn", msg),
    info: (msg) => emit("info", msg),
    debug: (msg) => emit("debug", msg),
  };
  function emit(level: Exclude<LogLevel, "silent">, msg: string) {
    if (ORDER[level] > ORDER[logger.level]) return;
    const prefix =
      level === "error"
        ? "error "
        : level === "warn"
          ? "warn  "
          : level === "debug"
            ? "debug "
            : "";
    write(prefix + msg);
  }
  return logger;
}

export const silentLogger: Logger = createLogger({ level: "silent" });
