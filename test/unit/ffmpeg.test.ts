import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import {
  decideMp4Mode,
  maxReasonableBitrate,
  reencodeArgs,
  remuxArgs,
} from "../../src/ffmpeg/mp4.js";
import { posterArgs, posterTime } from "../../src/ffmpeg/poster.js";
import { parseProbe, type ProbeResult } from "../../src/ffmpeg/probe.js";

const mp4 = DEFAULT_CONFIG.video.mp4;

const base: ProbeResult = {
  width: 1920,
  height: 1080,
  rotation: 0,
  duration: 20,
  fps: 30,
  videoCodec: "h264",
  pixFmt: "yuv420p",
  hasAudio: true,
  audioCodec: "aac",
  bitrate: 5_000_000,
  size: 12_500_000,
};

describe("parseProbe", () => {
  const video = {
    codec_type: "video",
    codec_name: "h264",
    width: 1920,
    height: 1080,
    pix_fmt: "yuv420p",
    avg_frame_rate: "30000/1001",
  };

  it("extracts dimensions, duration, fps and audio", () => {
    const p = parseProbe(
      {
        streams: [video, { codec_type: "audio", codec_name: "aac" }],
        format: { duration: "12.5", bit_rate: "4000000" },
      },
      100,
    );
    expect(p).toMatchObject({
      width: 1920,
      height: 1080,
      duration: 12.5,
      hasAudio: true,
      audioCodec: "aac",
      bitrate: 4_000_000,
      rotation: 0,
    });
    expect(p.fps).toBeCloseTo(29.97, 2);
  });

  it("swaps width and height for 90/270 rotation (side data or tag)", () => {
    const side = parseProbe(
      { streams: [{ ...video, side_data_list: [{ rotation: -90 }] }], format: { duration: "1" } },
      1,
    );
    expect([side.width, side.height, side.rotation]).toEqual([1080, 1920, 270]);
    const tag = parseProbe(
      { streams: [{ ...video, tags: { rotate: "90" } }], format: { duration: "1" } },
      1,
    );
    expect([tag.width, tag.height, tag.rotation]).toEqual([1080, 1920, 90]);
    const flip = parseProbe(
      { streams: [{ ...video, tags: { rotate: "180" } }], format: { duration: "1" } },
      1,
    );
    expect([flip.width, flip.height]).toEqual([1920, 1080]);
  });

  it("derives bitrate from size when missing, ignores cover art", () => {
    const p = parseProbe(
      {
        streams: [
          {
            codec_type: "video",
            codec_name: "mjpeg",
            width: 10,
            height: 10,
            disposition: { attached_pic: 1 },
          },
          video,
        ],
        format: { duration: "8" },
      },
      1_000_000,
    );
    expect(p.bitrate).toBe(1_000_000);
    expect(p.width).toBe(1920);
    expect(p.hasAudio).toBe(false);
  });

  it("throws without a video stream", () => {
    expect(() => parseProbe({ streams: [{ codec_type: "audio" }] }, 1)).toThrow(/No video/);
  });
});

describe("decideMp4Mode", () => {
  it("remuxes web-ready sources", () => {
    expect(decideMp4Mode(base, mp4).mode).toBe("remux");
    expect(decideMp4Mode({ ...base, hasAudio: false, audioCodec: undefined }, mp4).mode).toBe(
      "remux",
    );
  });

  it("re-encodes incompatible codecs, tall or high-bitrate sources", () => {
    expect(decideMp4Mode({ ...base, videoCodec: "hevc" }, mp4).mode).toBe("reencode");
    expect(decideMp4Mode({ ...base, pixFmt: "yuv444p" }, mp4).mode).toBe("reencode");
    expect(decideMp4Mode({ ...base, audioCodec: "opus" }, mp4).mode).toBe("reencode");
    expect(decideMp4Mode({ ...base, width: 3840, height: 2160 }, mp4).mode).toBe("reencode");
    expect(decideMp4Mode({ ...base, bitrate: 12_000_000 }, mp4).mode).toBe("reencode");
    expect(decideMp4Mode({ ...base, width: 640, height: 360, bitrate: 2_500_000 }, mp4).mode).toBe(
      "reencode",
    );
  });

  it("honors always/never", () => {
    expect(decideMp4Mode(base, { ...mp4, reencode: "always" }).mode).toBe("reencode");
    expect(decideMp4Mode({ ...base, videoCodec: "vp9" }, { ...mp4, reencode: "never" }).mode).toBe(
      "remux",
    );
  });

  it("scales the bitrate ceiling by frame area", () => {
    expect(maxReasonableBitrate(1920, 1080)).toBe(8_000_000);
    expect(maxReasonableBitrate(1280, 720)).toBe(3_555_556);
    expect(maxReasonableBitrate(320, 180)).toBe(1_000_000);
  });
});

describe("argument builders", () => {
  it("remux", () => {
    expect(remuxArgs("in.mp4", "out/video.mp4")).toMatchInlineSnapshot(`
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "in.mp4",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "out/video.mp4",
      ]
    `);
  });

  it("re-encode with and without audio", () => {
    const withAudio = reencodeArgs("in.mov", "out.mp4", mp4, true);
    expect(withAudio.join(" ")).toMatchInlineSnapshot(
      `"-y -hide_banner -loglevel error -i in.mov -map 0:v:0 -map 0:a:0 -vf scale=-2:'min(1080,trunc(ih/2)*2)' -c:v libx264 -preset medium -crf 23 -profile:v high -pix_fmt yuv420p -c:a aac -b:a 128k -ac 2 -movflags +faststart out.mp4"`,
    );
    const noAudio = reencodeArgs("in.mov", "out.mp4", { ...mp4, crf: 28, maxHeight: 720 }, false);
    expect(noAudio.join(" ")).toMatchInlineSnapshot(
      `"-y -hide_banner -loglevel error -i in.mov -map 0:v:0 -vf scale=-2:'min(720,trunc(ih/2)*2)' -c:v libx264 -preset medium -crf 28 -profile:v high -pix_fmt yuv420p -an -movflags +faststart out.mp4"`,
    );
  });

  it("poster", () => {
    expect(posterTime(1, 20)).toBe(1);
    expect(posterTime(1, 4)).toBeCloseTo(0.4);
    expect(posterTime(1, 0)).toBe(0);
    expect(posterArgs("in.mp4", "p.jpg", 0.4).join(" ")).toBe(
      "-y -hide_banner -loglevel error -ss 0.400 -i in.mp4 -frames:v 1 -q:v 2 p.jpg",
    );
  });
});
