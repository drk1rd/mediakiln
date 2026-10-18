import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { runtimeLoaderPath } from "../../src/runtimeAssets.js";

describe("runtime loader bundle", () => {
  it("stays around 2 KB gzipped", () => {
    const code = readFileSync(runtimeLoaderPath());
    expect(gzipSync(code, { level: 9 }).length).toBeLessThan(2048);
  });

  it("keeps import.meta.url (needed to find hls.js next to it)", () => {
    expect(readFileSync(runtimeLoaderPath(), "utf8")).toContain("import.meta.url");
  });
});
