/**
 * Reproducible benchmark: builds a site with camera-like raw media, optimizes it with
 * mediakiln, and compares the raw and optimized pages on bytes, time-to-first-frame
 * (throttled connection, WebKit and Chromium) and Lighthouse performance.
 *
 *   npx tsx scripts/bench.mts            # needs ffmpeg and `npx playwright install`
 *   npx tsx scripts/bench.mts --no-lighthouse
 *   npx tsx scripts/bench.mts --reuse    # keep the generated site and finished phases
 *
 * Results are written to test/.tmp/bench/results.json after every phase.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { chromium, webkit, type BrowserType } from "@playwright/test";
import sharp from "sharp";
import { optimize } from "../src/index.js";
import { silentLogger } from "../src/util/logger.js";
import { serveStatic } from "../test/e2e/server.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = path.join(ROOT, "test/.tmp/bench");
const RAW = path.join(WORK, "raw");
const OPT = path.join(WORK, "optimized");
const CACHE = path.join(WORK, "cache");
const MBPS = 20;
const LATENCY = 40;
const RUNS = 3;
const lighthouse = !process.argv.includes("--no-lighthouse");
const reuse = process.argv.includes("--reuse");
const RESULTS = path.join(WORK, "results.json");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const results: Record<string, any> =
  reuse && existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")) : {};
async function phase<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  if (name in results) return results[name] as T;
  console.error(`bench: ${name}…`);
  results[name] = await fn();
  writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  return results[name] as T;
}

const ff = (...args: string[]) =>
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: "inherit",
  });
const size = (f: string) => statSync(f).size;

async function photo(file: string, w: number, h: number, seed: number) {
  // Smooth gradients plus per-pixel grain: compresses like a real photo, not a flat test card.
  const data = Buffer.alloc(w * h * 3);
  let s = seed;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = ((s >> 16) % 28) - 14;
      const i = (y * w + x) * 3;
      const fx = x / w;
      const fy = y / h;
      data[i] = Math.max(
        0,
        Math.min(255, 40 + 180 * fx * (1 - fy) + 30 * Math.sin(fy * 9 + seed) + n),
      );
      data[i + 1] = Math.max(0, Math.min(255, 70 + 120 * fy + 40 * Math.cos(fx * 7) + n));
      data[i + 2] = Math.max(0, Math.min(255, 150 - 90 * fx + 50 * Math.sin((fx + fy) * 5) + n));
    }
  await sharp(data, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 92 })
    .toFile(file);
}

async function buildSite() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(path.join(RAW, "media"), { recursive: true });
  mkdirSync(path.join(RAW, "img"), { recursive: true });
  // 30 s 1080p "camera export": ~16 Mbps, light grain, moov at the end, 192k audio.
  ff(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=duration=30:size=1920x1080:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:beep_factor=2:duration=30",
    "-vf",
    "noise=alls=6:allf=t",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-b:v",
    "16M",
    "-maxrate",
    "20M",
    "-bufsize",
    "32M",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    path.join(RAW, "media/hero.mp4"),
  );
  // 6 s background loop.
  ff(
    "-f",
    "lavfi",
    "-i",
    "mandelbrot=size=1280x720:rate=30",
    "-t",
    "6",
    "-vf",
    "noise=alls=4:allf=t",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-b:v",
    "6M",
    "-maxrate",
    "8M",
    "-bufsize",
    "12M",
    "-pix_fmt",
    "yuv420p",
    path.join(RAW, "media/loop.mp4"),
  );
  for (let i = 1; i <= 3; i++) await photo(path.join(RAW, `img/photo${i}.jpg`), 4000, 3000, i);
  ff(
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=2560x1440:rate=1",
    "-frames:v",
    "1",
    path.join(RAW, "img/screenshot.png"),
  );
  writeFileSync(
    path.join(RAW, "index.html"),
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>bench</title>
<style>body{margin:0;font:16px system-ui}video,img{display:block;width:100%;height:auto}.wrap{max-width:960px;margin:auto;padding:1rem}</style></head>
<body>
<video autoplay muted loop src="media/loop.mp4"></video>
<div class="wrap">
<h1>Benchmark page</h1>
<p>A hero loop, a 30-second 1080p video, three 12-megapixel photos and a screenshot.</p>
<video id="main" controls src="media/hero.mp4"></video>
<img src="img/photo1.jpg" alt="Photo 1">
<img src="img/photo2.jpg" alt="Photo 2">
<img src="img/photo3.jpg" alt="Photo 3">
<img src="img/screenshot.png" alt="Screenshot">
</div>
</body></html>
`,
  );
  cpSync(RAW, OPT, { recursive: true });
}

const MEASURE_PLAY = `new Promise((resolve, reject) => {
  const v = document.getElementById("main");
  v.muted = true;
  const t0 = performance.now();
  const done = () => resolve(performance.now() - t0);
  if ("requestVideoFrameCallback" in v) v.requestVideoFrameCallback(done);
  else v.addEventListener("playing", done, { once: true });
  v.play().catch(reject);
  setTimeout(() => reject(new Error("timeout")), 60000);
})`;

async function ttff(browserType: BrowserType, base: string): Promise<number> {
  const browser = await browserType.launch();
  const times: number[] = [];
  try {
    for (let i = 0; i < RUNS; i++) {
      const page = await browser.newPage();
      await page.goto(base + "/index.html", { waitUntil: "load" });
      const video = page.locator("#main");
      await video.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000); // let preload=metadata / lazy loading settle
      // Passed as a string: tsx would otherwise inject helpers that don't exist in the page.
      times.push(await page.evaluate<number>(MEASURE_PLAY));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

// Press play right after load, then watch for 10 s of wall time: how long until the first
// frame, how much video actually played, and how long playback was stalled.
const WATCH = `new Promise((resolve, reject) => {
  const v = document.getElementById("main");
  v.muted = true;
  const t0 = performance.now();
  let first = null, stallStart = null, stalled = 0;
  const onFrame = () => { if (first === null) first = performance.now() - t0; };
  if ("requestVideoFrameCallback" in v) v.requestVideoFrameCallback(onFrame);
  v.addEventListener("playing", () => { onFrame(); if (stallStart !== null) { stalled += performance.now() - stallStart; stallStart = null; } });
  v.addEventListener("waiting", () => { if (first !== null && stallStart === null) stallStart = performance.now(); });
  v.play().catch((e) => reject(String(e)));
  setTimeout(() => {
    if (stallStart !== null) stalled += performance.now() - stallStart;
    resolve({ ttff: first, played: v.currentTime, stalledMs: stalled, height: v.videoHeight });
  }, 10000);
})`;

interface Watch {
  ttff: number | null;
  played: number;
  stalledMs: number;
  height: number;
}

async function watch(browserType: BrowserType, base: string): Promise<Watch> {
  const browser = await browserType.launch();
  const runs: Watch[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      // Press play as soon as the DOM is ready: on slow links the raw page's "load" event
      // waits for megabytes of images.
      await page.goto(base + "/index.html", { waitUntil: "domcontentloaded", timeout: 120_000 });
      await page.locator("#main").scrollIntoViewIfNeeded();
      runs.push(await page.evaluate<Watch>(WATCH));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const avg = (f: (w: Watch) => number) => runs.reduce((a, w) => a + f(w), 0) / runs.length;
  return {
    ttff: avg((w) => w.ttff ?? 10000),
    played: avg((w) => w.played),
    stalledMs: avg((w) => w.stalledMs),
    height: Math.max(...runs.map((w) => w.height)),
  };
}

async function initialBytes(base: string): Promise<number> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let total = 0;
  page.on("requestfinished", async (req) => {
    const s = await req.sizes().catch(() => undefined);
    if (s) total += s.responseBodySize + s.responseHeadersSize;
  });
  await page.goto(base + "/index.html", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await browser.close();
  return total;
}

// Async on purpose: the servers run in this process and must keep answering requests.
async function runLighthouse(
  url: string,
): Promise<{ score: number; lcp: number; tbt: number; cls: number; bytes: number }> {
  const { stdout: out } = await promisify(execFile)(
    "npx",
    [
      "--yes",
      "lighthouse@13.5.0",
      url,
      "--quiet",
      "--output=json",
      "--only-categories=performance",
      "--chrome-flags=--headless=new",
    ],
    {
      env: { ...process.env, CHROME_PATH: chromium.executablePath() },
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const r = JSON.parse(out);
  return {
    score: Math.round(r.categories.performance.score * 100),
    lcp: r.audits["largest-contentful-paint"].numericValue,
    tbt: r.audits["total-blocking-time"].numericValue,
    cls: r.audits["cumulative-layout-shift"].numericValue,
    bytes: r.audits["total-byte-weight"].numericValue,
  };
}

if (!reuse || !existsSync(path.join(OPT, "_mediakiln"))) {
  for (const k of Object.keys(results)) delete results[k];
  await buildSite();
}

await phase("rawBytes", () => ({
  hero: size(path.join(RAW, "media/hero.mp4")),
  loop: size(path.join(RAW, "media/loop.mp4")),
  photos: [1, 2, 3].map((i) => size(path.join(RAW, `img/photo${i}.jpg`))),
  screenshot: size(path.join(RAW, "img/screenshot.png")),
}));

await phase("cold", async () => {
  const t0 = Date.now();
  const summary = await optimize({
    dir: OPT,
    configFile: false,
    cacheDir: CACHE,
    logger: silentLogger,
  });
  const manifest = JSON.parse(readFileSync(path.join(OPT, "_mediakiln/manifest.json"), "utf8"));
  return { ms: Date.now() - t0, summary, manifest };
});

await phase("warm", async () => {
  const warmDir = path.join(WORK, "warm");
  rmSync(warmDir, { recursive: true, force: true });
  cpSync(RAW, warmDir, { recursive: true });
  const t1 = Date.now();
  const summary = await optimize({
    dir: warmDir,
    configFile: false,
    cacheDir: CACHE,
    logger: silentLogger,
  });
  return { ms: Date.now() - t1, summary };
});

const throttle = { bytesPerSec: (MBPS * 1e6) / 8, latencyMs: LATENCY };
await phase("ttff", async () => {
  const rawServer = await serveStatic(RAW, 4501, throttle);
  const optServer = await serveStatic(OPT, 4502, throttle);
  const out: Record<string, { raw: number; opt: number }> = {};
  try {
    for (const bt of [webkit, chromium]) {
      out[bt.name()] = {
        raw: await ttff(bt, "http://127.0.0.1:4501"),
        opt: await ttff(bt, "http://127.0.0.1:4502"),
      };
    }
  } finally {
    rawServer.close();
    optServer.close();
  }
  return { mbps: MBPS, latencyMs: LATENCY, runs: RUNS, ...out };
});

await phase("playback", async () => {
  const profiles = [
    { name: "broadband", mbps: 20, latencyMs: 40 },
    { name: "mobile", mbps: 6, latencyMs: 80 },
  ];
  const out: Record<string, Record<string, { raw: Watch; opt: Watch }>> = {};
  for (const prof of profiles) {
    const t = { bytesPerSec: (prof.mbps * 1e6) / 8, latencyMs: prof.latencyMs };
    const a = await serveStatic(RAW, 4511, t);
    const b = await serveStatic(OPT, 4512, t);
    out[prof.name] = {};
    try {
      for (const bt of [webkit, chromium]) {
        out[prof.name]![bt.name()] = {
          raw: await watch(bt, "http://127.0.0.1:4511"),
          opt: await watch(bt, "http://127.0.0.1:4512"),
        };
      }
    } finally {
      a.close();
      b.close();
    }
  }
  return { profiles, ...out };
});

await phase("initialBytes", async () => {
  const a = await serveStatic(RAW, 4505);
  const b = await serveStatic(OPT, 4506);
  try {
    return {
      raw: await initialBytes("http://127.0.0.1:4505"),
      opt: await initialBytes("http://127.0.0.1:4506"),
    };
  } finally {
    a.close();
    b.close();
  }
});

if (lighthouse) {
  await phase("lighthouse", async () => {
    const a = await serveStatic(RAW, 4503);
    const b = await serveStatic(OPT, 4504);
    try {
      return {
        raw: await runLighthouse("http://127.0.0.1:4503/index.html"),
        opt: await runLighthouse("http://127.0.0.1:4504/index.html"),
      };
    } finally {
      a.close();
      b.close();
    }
  });
}

console.log(JSON.stringify(results, null, 2));
