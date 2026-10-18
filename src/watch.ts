import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";
import { optimize, type OptimizeOptions } from "./optimize.js";
import type { Summary } from "./summary.js";

export interface WatchOptions extends OptimizeOptions {
  /** Quiet period before re-running after the last change, in ms. Default 300. */
  debounceMs?: number;
  onRun?: (summary: Summary) => void;
  onError?: (error: unknown) => void;
}

export interface Watcher {
  /** Resolves after the current run (if any) finishes. */
  close(): Promise<void>;
  /** The run in progress or the last one. */
  readonly idle: Promise<void>;
}

/**
 * Optimize once, then again whenever files in `dir` change (e.g. a static site generator in
 * watch mode rewriting its output). Runs never overlap; changes during a run trigger one more
 * run afterwards. mediakiln's own output folder is ignored, and because re-runs are
 * idempotent, the pages it rewrites settle after one extra no-op pass.
 */
export function watch(options: WatchOptions): Watcher {
  const { debounceMs = 300, onRun, onError, ...opts } = options;
  const dir = path.resolve(opts.cwd ?? process.cwd(), opts.dir);
  const outDirName = opts.outDirName ?? "_mediakiln";
  let running: Promise<void> = Promise.resolve();
  let pending = false;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const run = () => {
    running = running.then(async () => {
      if (closed) return;
      pending = false;
      try {
        onRun?.(await optimize(opts));
      } catch (err) {
        onError?.(err);
      }
      if (pending && !closed) schedule();
    });
  };
  const schedule = () => {
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  };

  const ignored = (file: string | null) => {
    if (!file) return false;
    const first = file.split(/[\\/]/)[0];
    return first === outDirName || first === "_headers" || first === ".DS_Store";
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = fsWatch(dir, { recursive: true }, (_event, file) => {
      if (!ignored(file?.toString() ?? null)) schedule();
    });
  } catch (err) {
    onError?.(err);
  }
  run();

  return {
    get idle() {
      return running;
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      watcher?.close();
      await running;
    },
  };
}
