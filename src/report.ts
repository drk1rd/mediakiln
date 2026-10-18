import { promises as fs } from "node:fs";
import type { Manifest } from "./manifest.js";
import { formatBytes } from "./util/format.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function detail(entry: Manifest["assets"][number]): string {
  const r = entry.result;
  switch (r.kind) {
    case "video": {
      const parts = [`${r.width}×${r.height}`, `${r.duration.toFixed(1)} s`, `MP4 ${r.mp4.mode}`];
      if (r.hls) parts.push(`HLS ${r.hls.variants.map((v) => `${v.height}p`).join("/")}`);
      if (r.thumbnails) parts.push("thumbnails");
      return parts.join(" · ");
    }
    case "image":
      return r.passthrough
        ? `${r.width}×${r.height} · kept as-is (re-encoding didn't help)`
        : `${r.width}×${r.height} · ${[...new Set(r.variants.map((v) => v.format))].join("/")} × ${new Set(r.variants.map((v) => v.width)).size} widths`;
    case "convert":
      return `${r.width}×${r.height} · ${r.variants.map((v) => v.format).join("/") || "kept as-is"}`;
    case "poster":
    case "og":
      return `${r.width}×${r.height}`;
    case "captions":
      return `${r.tracks} subtitle track(s)`;
  }
}

/** A self-contained HTML page listing every processed asset and the bytes saved. */
export function renderReport(manifest: Manifest): string {
  const rows = manifest.assets
    .map((a) => {
      const saved = a.bytesBefore > 0 ? Math.round((1 - a.bytesAfter / a.bytesBefore) * 100) : 0;
      return `<tr><td><code>${esc(a.source)}</code></td><td>${a.kind}</td><td>${esc(detail(a))}</td><td class="n">${formatBytes(a.bytesBefore)}</td><td class="n">${formatBytes(a.bytesAfter)}</td><td class="n">${a.bytesBefore ? `${saved}%` : "–"}</td><td>${a.cached ? "cached" : "built"}</td></tr>`;
    })
    .join("\n");
  const before = manifest.assets.reduce((n, a) => n + a.bytesBefore, 0);
  const after = manifest.assets.reduce((n, a) => n + a.bytesAfter, 0);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>mediakiln report</title>
<style>
:root { color-scheme: light dark; --fg: #1d1b19; --bg: #faf8f5; --muted: #6b645c; --line: #e3ddd5; --accent: #c4511f; }
@media (prefers-color-scheme: dark) { :root { --fg: #ece8e3; --bg: #141210; --muted: #a39a90; --line: #2e2a26; --accent: #f08a50; } }
body { margin: 0; padding: 24px 16px; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 1100px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 1.6rem; }
p.meta { color: var(--muted); margin: 0 0 24px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.card b { display: block; font-size: 1.4rem; color: var(--accent); }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
code { font-size: 13px; word-break: break-all; }
</style>
</head>
<body><main>
<h1>mediakiln report</h1>
<p class="meta">v${esc(manifest.version)} · generated ${esc(manifest.generatedAt)}</p>
<div class="cards">
<div class="card"><b>${manifest.assets.length}</b>assets</div>
<div class="card"><b>${formatBytes(before)}</b>before</div>
<div class="card"><b>${formatBytes(after)}</b>delivered after</div>
<div class="card"><b>${before ? Math.round((1 - after / before) * 100) : 0}%</b>smaller</div>
</div>
<div class="wrap"><table>
<thead><tr><th>Source</th><th>Kind</th><th>Output</th><th>Before</th><th>After</th><th>Saved</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
</main></body>
</html>
`;
}

/** Written only when the content changes, keeping re-runs byte-identical. */
export async function writeReport(file: string, manifest: Manifest): Promise<void> {
  const html = renderReport(manifest);
  const current = await fs.readFile(file, "utf8").catch(() => undefined);
  if (current !== html) await fs.writeFile(file, html);
}
