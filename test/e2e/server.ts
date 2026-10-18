import { createReadStream, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".txt": "text/plain",
};

export interface Throttle {
  /** Bandwidth per response in bytes per second. */
  bytesPerSec: number;
  /** Added before the first byte of every response. */
  latencyMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stream a file range at a limited rate (per response, like a slow connection). */
async function sendThrottled(
  res: http.ServerResponse,
  file: string,
  range: { start: number; end: number },
  t: Throttle,
) {
  await sleep(t.latencyMs);
  const chunk = 16 * 1024;
  const started = Date.now();
  let sent = 0;
  for await (const buf of createReadStream(file, { ...range, highWaterMark: chunk })) {
    if (res.destroyed) return;
    res.write(buf as Buffer);
    sent += (buf as Buffer).length;
    const due = started + (sent / t.bytesPerSec) * 1000;
    if (due > Date.now()) await sleep(due - Date.now());
  }
  res.end();
}

/** Minimal static file server with byte-range support (needed for <video>). */
export function serveStatic(root: string, port: number, throttle?: Throttle): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const file = path.join(root, rel);
      if (!file.startsWith(root)) throw new Error("outside root");
      const stat = await fs.stat(file);
      const type = TYPES[path.extname(file)] ?? "application/octet-stream";
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Number(range[2]) : stat.size - 1;
        res.writeHead(206, {
          "content-type": type,
          "content-length": end - start + 1,
          "content-range": `bytes ${start}-${end}/${stat.size}`,
          "accept-ranges": "bytes",
        });
        if (throttle) void sendThrottled(res, file, { start, end }, throttle);
        else createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "content-type": type,
          "content-length": stat.size,
          "accept-ranges": "bytes",
        });
        if (throttle) void sendThrottled(res, file, { start: 0, end: stat.size - 1 }, throttle);
        else createReadStream(file).pipe(res);
      }
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
