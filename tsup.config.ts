import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
      "plugins/vite": "src/plugins/vite.ts",
      "plugins/astro": "src/plugins/astro.ts",
      "plugins/eleventy": "src/plugins/eleventy.ts",
      "plugins/docusaurus": "src/plugins/docusaurus.ts",
    },
    format: ["esm"],
    target: "node20",
    platform: "node",
    dts: {
      entry: {
        index: "src/index.ts",
        "plugins/vite": "src/plugins/vite.ts",
        "plugins/astro": "src/plugins/astro.ts",
        "plugins/eleventy": "src/plugins/eleventy.ts",
        "plugins/docusaurus": "src/plugins/docusaurus.ts",
      },
    },
    external: ["vite"],
    clean: true,
    sourcemap: false,
    splitting: true,
  },
  {
    // Browser runtime: tiny, dependency-free, minified, copied into every optimized site.
    entry: { "runtime/loader": "src/runtime/loader.ts" },
    format: ["esm"],
    target: "es2020",
    platform: "browser",
    minify: true,
    dts: false,
    clean: false,
    sourcemap: false,
  },
]);
