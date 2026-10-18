import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * Open-source Chromium/WebKit builds may not decode H.264, so these tests assert on what the
 * runtime does (attributes, network requests, hls.js events) rather than on decoded frames.
 */

function collect(page: Page): Request[] {
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  return requests;
}
const urls = (rs: Request[]) => rs.map((r) => new URL(r.url()).pathname);

test("runtime loads once and only on pages with videos", async ({ page }) => {
  const requests = collect(page);
  await page.goto("/blog/post.html");
  await expect
    .poll(() => urls(requests).filter((u) => u.endsWith("/runtime/loader.js")).length)
    .toBe(1);
  const scripts = await page.locator('script[src$="/_mediakiln/runtime/loader.js"]').count();
  expect(scripts).toBe(1);
});

test("lazy video switches preload when scrolled near the viewport", async ({ page }) => {
  await page.goto("/lazy.html");
  const video = page.locator("#lazy");
  await page.waitForLoadState("load");
  expect(await video.evaluate((v: HTMLVideoElement) => v.preload)).toBe("none");
  await video.scrollIntoViewIfNeeded();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.preload)).toBe("metadata");
});

test("HLS video loads the master playlist and segments", async ({ page, browserName }) => {
  const requests = collect(page);
  await page.goto("/lazy.html");
  const video = page.locator("#lazyhls");
  const nativeHls = await video.evaluate(
    (v: HTMLVideoElement) => v.canPlayType("application/vnd.apple.mpegurl") !== "",
  );
  // Nothing HLS-related before the video comes into view.
  expect(urls(requests).some((u) => u.endsWith(".m3u8"))).toBe(false);

  await video.scrollIntoViewIfNeeded();
  if (nativeHls) {
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.src))
      .toMatch(/master\.m3u8$/);
  } else {
    test.skip(
      !(await page.evaluate(() => "MediaSource" in window || "ManagedMediaSource" in window)),
      `${browserName} has neither native HLS nor MSE`,
    );
    await expect
      .poll(() => urls(requests).some((u) => u.endsWith("/runtime/hls.light.min.js")))
      .toBe(true);
    await expect.poll(() => urls(requests).some((u) => u.endsWith("/hls/master.m3u8"))).toBe(true);
    await expect
      .poll(() => urls(requests).some((u) => /\/hls\/v\d\/index\.m3u8$/.test(u)))
      .toBe(true);
    await expect
      .poll(() => urls(requests).some((u) => /\/hls\/v\d\/seg_\d+\.ts$/.test(u)), {
        timeout: 15_000,
      })
      .toBe(true);
    // hls.js took over the element (blob: MediaSource URL)
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.src)).toMatch(/^blob:/);
  }
});

test("falls back to the MP4 <source> without MSE or native HLS", async ({ page }) => {
  await page.addInitScript(() => {
    // Simulate an old browser: no MediaSource and no native HLS.
    delete (window as unknown as Record<string, unknown>).MediaSource;
    delete (window as unknown as Record<string, unknown>).ManagedMediaSource;
    const orig = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type: string) {
      return /mpegurl/i.test(type) ? "" : orig.call(this, type);
    };
  });
  const requests = collect(page);
  await page.goto("/lazy.html");
  const video = page.locator("#lazyhls");
  await video.scrollIntoViewIfNeeded();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.preload)).toBe("metadata");
  await page.waitForTimeout(500);
  expect(urls(requests).some((u) => u.endsWith("hls.light.min.js"))).toBe(false);
  expect(urls(requests).some((u) => u.endsWith(".m3u8"))).toBe(false);
  expect(await video.evaluate((v: HTMLVideoElement) => v.getAttribute("src"))).toBeNull();
  await expect
    .poll(() => urls(requests).some((u) => /\/_mediakiln\/[0-9a-f]{12}\/video\.mp4$/.test(u)))
    .toBe(true);
});

test("reduced motion stops autoplay", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/");
  const autoplay = page.locator("video[muted][loop]");
  await expect.poll(() => autoplay.evaluate((v: HTMLVideoElement) => v.autoplay)).toBe(false);
  await context.close();
});
