import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateAll } from "../helpers/genMedia.js";
import { silentLogger } from "../../src/util/logger.js";
import viteMediakiln from "../../src/plugins/vite.js";
import eleventyMediakiln from "../../src/plugins/eleventy.js";
import astroMediakiln from "../../src/plugins/astro.js";
import { baseFromFramework } from "../../src/plugins/shared.js";

const TMP = path.resolve(import.meta.dirname, "../.tmp");
const FAST = {
  configFile: false as const,
  cache: false,
  logger: silentLogger,
  video: { mp4: { preset: "ultrafast" as const } },
};

let media: Awaited<ReturnType<typeof generateAll>>;
let root: string;
beforeAll(async () => {
  media = await generateAll();
  mkdirSync(TMP, { recursive: true });
  root = mkdtempSync(path.join(TMP, "plugins-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("vite plugin", () => {
  it("optimizes build.outDir after a production build, honoring base", async () => {
    const { build } = await import("vite");
    const project = path.join(root, "vite");
    mkdirSync(path.join(project, "public"), { recursive: true });
    cpSync(media.short, path.join(project, "public/clip.mp4"));
    cpSync(media.small, path.join(project, "src-hero.png"));
    writeFileSync(
      path.join(project, "index.html"),
      `<!doctype html><html><body>
<video controls src="/clip.mp4"></video>
<img src="./src-hero.png" alt="hero">
</body></html>`,
    );
    await build({
      root: project,
      base: "/app/",
      logLevel: "silent",
      configFile: false,
      plugins: [viteMediakiln(FAST)],
    });
    const html = readFileSync(path.join(project, "dist/index.html"), "utf8");
    expect(html).toMatch(/<source src="\/app\/_mediakiln\/[0-9a-f]{12}\/video\.mp4"/);
    // Vite emitted the image as a hashed asset; mediakiln still found and optimized it.
    expect(html).toMatch(/<picture><source type="image\/avif" srcset="\/app\/_mediakiln\//);
    expect(html).toContain('src="/app/_mediakiln/runtime/loader.js"');
    expect(existsSync(path.join(project, "dist/_mediakiln/runtime/loader.js"))).toBe(true);
  });

  it("does nothing in dev (apply: build)", () => {
    expect(viteMediakiln().apply).toBe("build");
  });
});

describe("eleventy plugin", () => {
  async function run(runMode: "build" | "serve", enabled?: boolean) {
    const project = mkdtempSync(path.join(root, "eleventy-"));
    const input = path.join(project, "src");
    const output = path.join(project, "_site");

    mkdirSync(path.join(input, "media"), { recursive: true });
    cpSync(media.short, path.join(input, "media/clip.mp4"));
    writeFileSync(
      path.join(input, "index.html"),
      `<video controls src="/media/clip.mp4"></video>\n`,
    );
    const { default: Eleventy } = await import("@11ty/eleventy");
    // Eleventy resolves input, output and passthrough paths against the cwd.
    const cwd = process.cwd();
    process.chdir(project);
    try {
      const elev = new Eleventy("src", "_site", {
        quietMode: true,
        runMode,
        config(cfg) {
          cfg.addPassthroughCopy("src/media");
          cfg.addPlugin(eleventyMediakiln, { ...FAST, enabled });
        },
      });
      await elev.write();
    } finally {
      process.chdir(cwd);
    }
    return readFileSync(path.join(output, "index.html"), "utf8");
  }

  it("optimizes the output dir after a build", async () => {
    const html = await run("build");
    expect(html).toMatch(/<source src="\/_mediakiln\/[0-9a-f]{12}\/video\.mp4"/);
  });

  it("skips --serve unless enabled", async () => {
    expect(await run("serve")).toBe(`<video controls src="/media/clip.mp4"></video>\n`);
    expect(await run("serve", true)).toContain("/_mediakiln/");
  });
});

describe("astro integration", () => {
  it("runs on astro:build:done with the configured base", async () => {
    const dir = mkdtempSync(path.join(root, "astro-"));
    mkdirSync(path.join(dir, "blog/media"), { recursive: true });
    cpSync(media.short, path.join(dir, "blog/media/clip.mp4"));
    // Astro emits pages under outDir without the base prefix.
    writeFileSync(
      path.join(dir, "index.html"),
      `<video controls src="/blog/media/clip.mp4"></video>`,
    );
    const integration = astroMediakiln(FAST);
    integration.hooks["astro:config:done"]({
      config: { base: "/blog", root: pathToFileURL(dir + "/") },
    });
    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(m),
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    // A different layout to prove the dir comes from the hook, not the config.
    rmSync(path.join(dir, "blog"), { recursive: true });
    mkdirSync(path.join(dir, "media"), { recursive: true });
    cpSync(media.short, path.join(dir, "media/clip.mp4"));
    await integration.hooks["astro:build:done"]({ dir: pathToFileURL(dir + "/"), logger });
    const html = readFileSync(path.join(dir, "index.html"), "utf8");
    expect(html).toMatch(/<source src="\/blog\/_mediakiln\/[0-9a-f]{12}\/video\.mp4"/);
  });
});

describe("baseFromFramework", () => {
  it("maps framework bases to a path", () => {
    expect(baseFromFramework(undefined)).toBe("/");
    expect(baseFromFramework("/docs/")).toBe("/docs/");
    expect(baseFromFramework("https://cdn.example.com/site/")).toBe("/site/");
    const warnings: string[] = [];
    expect(baseFromFramework("./", (m) => warnings.push(m))).toBe("/");
    expect(warnings).toHaveLength(1);
  });
});
