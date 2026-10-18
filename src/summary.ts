import { formatBytes, formatDuration } from "./util/format.js";

export interface AssetFailure {
  file: string;
  kind: "video" | "image";
  error: string;
}

export interface Summary {
  version: string;
  dir: string;
  dryRun: boolean;
  videos: {
    processed: number;
    cached: number;
    hls: number;
    mp4Only: number;
    failed: number;
    bytesBefore: number;
    bytesAfter: number;
  };
  images: {
    processed: number;
    cached: number;
    failed: number;
    bytesBefore: number;
    bytesAfter: number;
  };
  pages: { scanned: number; rewritten: number };
  durationMs: number;
  failures: AssetFailure[];
}

export function emptySummary(version: string, dir: string, dryRun: boolean): Summary {
  return {
    version,
    dir,
    dryRun,
    videos: {
      processed: 0,
      cached: 0,
      hls: 0,
      mp4Only: 0,
      failed: 0,
      bytesBefore: 0,
      bytesAfter: 0,
    },
    images: { processed: 0, cached: 0, failed: 0, bytesBefore: 0, bytesAfter: 0 },
    pages: { scanned: 0, rewritten: 0 },
    durationMs: 0,
    failures: [],
  };
}

export function formatSummary(s: Summary): string {
  const header = `mediakiln v${s.version} — ${s.dir}${s.dryRun ? " (dry run)" : ""}`;
  const v = s.videos;
  const i = s.images;
  if (v.processed + v.cached + v.failed + i.processed + i.cached + i.failed === 0) {
    return `${header}\n  nothing to do (${s.pages.scanned} pages scanned, no local media found)`;
  }
  const verb = s.dryRun ? "to process" : "processed";
  const pad = (n: number) => String(n).padStart(3);
  const sizes = (before: number, after: number) =>
    before > 0 && !s.dryRun ? `     ${formatBytes(before)} → ${formatBytes(after)}` : "";
  const failed = (n: number) => (n > 0 ? `, ${n} failed` : "");

  const lines = [header];
  if (v.processed + v.cached + v.failed > 0) {
    const detail = s.dryRun ? "" : ` (${v.hls} HLS, ${v.mp4Only} MP4-only)`;
    lines.push(
      `  videos ${pad(v.processed)} ${verb}${detail}, ${v.cached} cached${failed(v.failed)}` +
        sizes(v.bytesBefore, v.bytesAfter),
    );
  }
  if (i.processed + i.cached + i.failed > 0) {
    lines.push(
      `  images ${pad(i.processed)} ${verb}, ${i.cached} cached${failed(i.failed)}` +
        sizes(i.bytesBefore, i.bytesAfter),
    );
  }
  lines.push(`  pages  ${pad(s.pages.rewritten)} ${s.dryRun ? "to rewrite" : "rewritten"}`);
  lines.push(`  time   ${formatDuration(s.durationMs)}`);
  for (const f of s.failures) lines.push(`  ✗ ${f.kind} ${f.file}: ${f.error.split("\n")[0]}`);
  return lines.join("\n");
}
