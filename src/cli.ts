#!/usr/bin/env node
import { cac } from "cac";
import { optimize, formatSummary, type OptimizeOptions } from "./index.js";
import { flagsToOverrides, type CliFlags } from "./cliFlags.js";
import { createLogger } from "./util/logger.js";
import { VERSION } from "./version.js";

async function main(argv: string[]): Promise<number> {
  const cli = cac("mediakiln");
  cli
    .command("<dir>", "Optimize the media in a built static site directory, in place")
    .option("-c, --config <file>", "Config file (default: mediakiln.config.{js,mjs,json} in cwd)")
    .option("--base <path>", 'Public base path the site is served from (default: "/")')
    .option("--cache-dir <dir>", "Cache directory (default: .mediakiln-cache)")
    .option("--no-cache", "Disable cache")
    .option("--no-video", "Skip video processing")
    .option("--no-images", "Skip image processing")
    .option("--no-hls", "Never generate HLS (faststart MP4 only)")
    .option("--concurrency <n>", "Parallel image jobs (default: CPU count)")
    .option("--dry-run", "Report what would change, write nothing")
    .option("--verbose", "Detailed logs (ffmpeg commands, timings)")
    .option("--json", "Machine-readable summary to stdout")
    .example("mediakiln ./dist")
    .example("mediakiln ./_site --base /blog/ --no-hls");
  cli.help((sections) =>
    sections.map((s) => ({ ...s, body: s.body.replace(/ \(default: true\)/g, "") })),
  );
  cli.version(VERSION, "-v, --version");

  const parsed = cli.parse(argv, { run: false });
  if (parsed.options.help || parsed.options.version) return 0;

  const dir = parsed.args[0];
  if (!dir) {
    cli.outputHelp();
    return 1;
  }
  const flags = parsed.options as CliFlags;
  const logger = createLogger({ level: flags.verbose ? "debug" : flags.json ? "warn" : "info" });

  const options: OptimizeOptions = {
    ...flagsToOverrides(flags),
    dir,
    configFile: flags.config,
    dryRun: Boolean(flags.dryRun),
    logger,
  };

  try {
    const summary = await optimize(options);
    if (flags.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    else process.stderr.write(formatSummary(summary) + "\n");
    return summary.failures.length > 0 ? 2 : 0;
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    if (flags.verbose && err instanceof Error && err.stack) logger.debug(err.stack);
    return 1;
  }
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`error ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
