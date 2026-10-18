/**
 * Records the README demo: the same 30 s 1080p video, raw vs. optimized, played over a
 * 6 Mbps connection from a cold start. Run scripts/bench.mts first (it builds both sites).
 *
 *   npx tsx scripts/demo-gif.mts   →  docs/demo.gif
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serveStatic } from "../test/e2e/server.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = path.join(ROOT, "test/.tmp/bench");
const OUT = path.join(ROOT, "docs/demo.gif");
const W = 480;
const H = 330;
const SECONDS = 10;

const page = (label: string, color: string, video: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#111;color:#eee;font:600 18px system-ui;overflow:hidden}
  .bar{display:flex;justify-content:space-between;padding:8px 12px;height:22px}
  .label{color:${color}} #t{font-variant-numeric:tabular-nums}
  video{display:block;width:${W}px;height:270px;background:#000;object-fit:contain}
</style></head><body>
<div class="bar"><span class="label">${label}</span><span id="t">0.00 s</span></div>
${video}
<script>
  const v = document.getElementById("main");
  const t = document.getElementById("t");
  const fmt = (n) => n.toFixed(1) + " s";
  const tick = () => {
    const state = v.paused ? "" : v.readyState < 3 ? "⏳ buffering · " : "▶ ";
    t.textContent = state + "played " + fmt(v.currentTime);
    requestAnimationFrame(tick);
  };
  window.start = () => { v.muted = true; v.play().catch(() => {}); tick(); };
</script></script></body></html>`;

// Raw page: the original markup. Optimized page: the exact <video> mediakiln produced.
const optIndex = readFileSync(path.join(WORK, "optimized/index.html"), "utf8");
const optVideo = /<video id="main"[\s\S]*?<\/video>/
  .exec(optIndex)![0]
  .replace(/ data-mk-lazy/, "");
const loader = `<script type="module" src="/_mediakiln/runtime/loader.js"></script>`;
writeFileSync(
  path.join(WORK, "raw/demo.html"),
  page("raw MP4", "#f87171", `<video id="main" src="media/hero.mp4"></video>`),
);
writeFileSync(
  path.join(WORK, "optimized/demo.html"),
  page("mediakiln", "#fb923c", optVideo + loader),
);

const throttle = { bytesPerSec: (6 * 1e6) / 8, latencyMs: 80 };
const servers = [
  await serveStatic(path.join(WORK, "raw"), 4701, throttle),
  await serveStatic(path.join(WORK, "optimized"), 4702, throttle),
];
const recDir = path.join(WORK, "rec");
rmSync(recDir, { recursive: true, force: true });
const browser = await chromium.launch();
const files: string[] = [];
for (const [i, port] of [4701, 4702].entries()) {
  const dir = path.join(recDir, String(i));
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir, size: { width: W, height: H } },
  });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}/demo.html`, { waitUntil: "domcontentloaded" });
  await p.evaluate("window.start()");
  await p.waitForTimeout(SECONDS * 1000);
  await ctx.close();
  files.push(path.join(dir, readdirSync(dir)[0]!));
}
await browser.close();
servers.forEach((s) => s.close());

// Stack side by side, palette-optimized GIF.
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    "0.8",
    "-t",
    String(SECONDS - 0.5),
    "-i",
    files[0]!,
    "-ss",
    "0.8",
    "-t",
    String(SECONDS - 0.5),
    "-i",
    files[1]!,
    "-filter_complex",
    "[0:v][1:v]hstack=inputs=2,fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
    OUT,
  ],
  { stdio: "inherit" },
);
console.log(`wrote ${path.relative(ROOT, OUT)}`);
