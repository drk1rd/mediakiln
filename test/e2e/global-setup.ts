import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { optimize } from "../../src/index.js";
import { silentLogger } from "../../src/util/logger.js";
import { makeSite } from "../helpers/site.js";
import { serveStatic } from "./server.js";

export const PORT = 4321;

/** Build, optimize the fixture site (plus a lazy-loading page), and serve it. */
export default async function globalSetup() {
  const root = path.resolve(import.meta.dirname, "../..");
  execFileSync("npm", ["run", "build", "--silent"], { cwd: root, stdio: "inherit" });
  const site = await makeSite();
  writeFileSync(
    path.join(site.dir, "lazy.html"),
    `<!doctype html><html><body>
<div style="height:3000px">spacer</div>
<video id="lazy" controls src="/media/short.mp4"></video>
<video id="lazyhls" controls muted src="/media/long.mp4"></video>
</body></html>`,
  );
  writeFileSync(
    path.join(site.dir, "subs.vtt"),
    "WEBVTT\n\n00:00:00.500 --> 00:00:05.000\nHello from mediakiln\n",
  );
  writeFileSync(
    path.join(site.dir, "captions.html"),
    `<!doctype html><html><body>
<video id="cc" controls muted src="/media/long.mp4">
  <track kind="subtitles" src="/subs.vtt" srclang="en" label="English" default>
</video>
</body></html>`,
  );
  const summary = await optimize({
    dir: site.dir,
    configFile: false,
    cache: false,
    images: { enabled: false },
    video: { mp4: { preset: "ultrafast" } },
    logger: silentLogger,
  });
  if (summary.failures.length) throw new Error(JSON.stringify(summary.failures));
  const server = await serveStatic(site.dir, PORT);
  return async () => {
    await new Promise((r) => server.close(r));
    site.cleanup();
  };
}
