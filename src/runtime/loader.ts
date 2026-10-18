/**
 * mediakiln runtime loader. Injected as a module script into pages with optimized videos.
 *
 * - Lazy videos (`data-mk-lazy`) keep `preload="none"` until they come within 200px of the
 *   viewport, then switch to `preload="metadata"`.
 * - HLS videos (`data-mk-hls`) play the adaptive stream: natively where the browser supports
 *   HLS (Safari/iOS), via a self-hosted hls.js loaded on demand where MSE is available, and
 *   otherwise from the MP4 `<source>`, which needs no JavaScript at all.
 * - Respects `prefers-reduced-motion: reduce` by not auto-playing.
 * - Captions mediakiln also put into the HLS stream (`track[data-mk-in-hls]`) are removed once
 *   the stream exposes them, so they aren't listed twice, and restored on MP4 fallback.
 *
 * Dependency-free and tiny; hls.js is only fetched on pages that need it, at most once.
 */

interface HlsInstance {
  on(event: string, cb: (event: string, data: { fatal?: boolean }) => void): void;
  loadSource(url: string): void;
  attachMedia(media: HTMLMediaElement): void;
  destroy(): void;
}
interface HlsClass {
  new (config: Record<string, unknown>): HlsInstance;
  isSupported(): boolean;
  Events: { ERROR: string };
}

const runtimeDir = new URL(".", import.meta.url);
const outRoot = new URL("..", runtimeDir).href;
const win = window as unknown as Record<string, unknown> & typeof globalThis;
const reduceMotion = !!win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const attached = new WeakSet<HTMLVideoElement>();
let hlsPromise: Promise<HlsClass | undefined> | undefined;

function loadHls(): Promise<HlsClass | undefined> {
  return (hlsPromise ??= import(/* @vite-ignore */ new URL("hls.light.min.js", runtimeDir).href)
    .then((m: { default?: HlsClass }) => m.default ?? (win.Hls as HlsClass | undefined))
    .catch(() => undefined));
}

function play(video: HTMLVideoElement): void {
  if (video.autoplay && !reduceMotion) video.play()?.catch(() => {});
}

/** `<track>`s removed because the HLS stream provides the same subtitles. */
const parked = new WeakMap<HTMLVideoElement, HTMLTrackElement[]>();

/**
 * Captions mediakiln also put into the HLS stream are kept until the player actually exposes
 * the in-stream track (WebKit and hls.js do; Chromium's native HLS doesn't), then the duplicate
 * `<track>` is removed, handing its `default` state to the in-stream one.
 */
function dedupeTracks(video: HTMLVideoElement): void {
  const els = Array.from(video.querySelectorAll<HTMLTrackElement>("track[data-mk-in-hls]"));
  if (!els.length) return;
  const removed: HTMLTrackElement[] = [];
  parked.set(video, removed);
  const own = new Set(els.map((e) => e.track));
  const check = () => {
    for (const t of Array.from(video.textTracks)) {
      if (own.has(t)) continue;
      const dup = els.find(
        (e) =>
          e.isConnected &&
          (e.srclang || "") === (t.language || "") &&
          (!e.label || e.label === t.label),
      );
      if (!dup) continue;
      if (dup.default && t.mode === "disabled") t.mode = "showing";
      dup.remove();
      removed.push(dup);
    }
  };
  video.textTracks.addEventListener("addtrack", check);
  check();
}

function fallbackToMp4(video: HTMLVideoElement): void {
  video.removeAttribute("src");
  (parked.get(video) ?? []).forEach((t) => video.appendChild(t));
  video.load();
  play(video);
}

function attach(video: HTMLVideoElement): void {
  const url = video.dataset.mkHls;
  if (!url || attached.has(video)) return;
  attached.add(video);

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    dedupeTracks(video);
    video.src = url;
    play(video);
    return;
  }
  if (!win.MediaSource && !win.ManagedMediaSource) return; // MP4 <source> plays natively

  loadHls().then((Hls) => {
    if (!Hls || !Hls.isSupported()) return;
    // The page's own <track>s already work with MSE playback; hls.js's copy would double the cues.
    const hls = new Hls({ capLevelToPlayerSize: true, startLevel: -1, enableWebVTT: false });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        hls.destroy();
        fallbackToMp4(video);
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    play(video);
  });
}

function activate(video: HTMLVideoElement): void {
  video.preload = "metadata";
  attach(video);
  play(video);
}

function isOurs(video: HTMLVideoElement): boolean {
  if (video.dataset.mkHls !== undefined || video.dataset.mkLazy !== undefined) return true;
  const src = video.querySelector("source")?.src ?? video.currentSrc;
  return !!src && src.startsWith(outRoot);
}

function init(): void {
  const videos = Array.from(document.querySelectorAll("video")).filter(isOurs);

  if (reduceMotion) {
    for (const v of videos) {
      if (v.autoplay) {
        v.autoplay = false;
        v.pause();
      }
    }
  }

  const lazy = videos.filter((v) => v.dataset.mkLazy !== undefined);
  const observer =
    "IntersectionObserver" in win
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              observer!.unobserve(e.target);
              activate(e.target as HTMLVideoElement);
            }
          },
          { rootMargin: "200px" },
        )
      : undefined;

  for (const v of lazy) {
    if (observer) observer.observe(v);
    else activate(v);
  }
  for (const v of videos) {
    if (v.dataset.mkLazy === undefined) attach(v);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
