import { afterEach, describe, expect, it, vi } from "vitest";

describe("findFfmpeg", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("finds ffmpeg and ffprobe", async () => {
    const { findFfmpeg } = await import("../../src/ffmpeg/binary.js");
    const bins = await findFfmpeg();
    expect(bins.version).toMatch(/ffmpeg version/);
  });

  it("explains how to install when nothing is found", async () => {
    vi.stubEnv("PATH", "/nonexistent");
    vi.stubEnv("FFMPEG_PATH", "/nonexistent/ffmpeg");
    vi.stubEnv("FFPROBE_PATH", "/nonexistent/ffprobe");
    vi.doMock("node:module", async (orig) => {
      const real = await orig<typeof import("node:module")>();
      return {
        ...real,
        createRequire: () => () => {
          throw new Error("not installed");
        },
      };
    });
    const { findFfmpeg, FfmpegNotFoundError } = await import("../../src/ffmpeg/binary.js");
    await expect(findFfmpeg()).rejects.toBeInstanceOf(FfmpegNotFoundError);
    await expect(findFfmpeg()).rejects.toThrow(/brew install ffmpeg/);
    vi.doUnmock("node:module");
  });
});
