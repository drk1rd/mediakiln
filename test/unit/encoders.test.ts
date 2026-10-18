import { describe, expect, it } from "vitest";
import { encoderFor, videoEncodeArgs } from "../../src/ffmpeg/encoders.js";
import { planThumbnails, thumbnailArgs, thumbnailVtt } from "../../src/ffmpeg/thumbnails.js";
import { reencodeArgs } from "../../src/ffmpeg/mp4.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

describe("encoders", () => {
  it("maps codecs to encoders per hardware", () => {
    expect(encoderFor("h264", "software")).toBe("libx264");
    expect(encoderFor("hevc", "videotoolbox")).toBe("hevc_videotoolbox");
    expect(encoderFor("av1", "videotoolbox")).toBe("libsvtav1");
    expect(encoderFor("av1", "nvenc")).toBe("av1_nvenc");
  });

  it("constant-quality args per encoder (MP4)", () => {
    const q = (
      hw: "software" | "videotoolbox" | "nvenc",
      codec: "h264" | "hevc" | "av1" = "h264",
    ) => videoEncodeArgs({ codec, hw, preset: "medium", crf: 23 }).join(" ");
    expect(q("software")).toBe("-c:v libx264 -crf:v 23 -preset:v medium -profile:v high");
    expect(q("videotoolbox")).toBe("-c:v h264_videotoolbox -q:v 60 -profile:v high -allow_sw:v 1");
    expect(q("nvenc")).toBe(
      "-c:v h264_nvenc -rc:v vbr -cq:v 23 -b:v 0 -preset:v p5 -profile:v high",
    );
    expect(q("software", "hevc")).toContain("-tag:v hvc1");
    expect(q("software", "av1")).toContain("-crf:v 33");
  });

  it("bitrate mode omits maxrate for SVT-AV1", () => {
    expect(
      videoEncodeArgs({ codec: "av1", hw: "software", preset: "fast", kbps: 1000 }, ":2").join(" "),
    ).toBe("-c:v:2 libsvtav1 -b:v:2 1000k -preset:v:2 8 -svtav1-params:v:2 log-level=1");
  });

  it("MP4 re-encode uses the hardware encoder", () => {
    const args = reencodeArgs(
      "in",
      "out",
      DEFAULT_CONFIG.video.mp4,
      { hasAudio: false, width: 1920, height: 1080 },
      "videotoolbox",
    );
    expect(args).toContain("h264_videotoolbox");
    expect(args).toContain("+faststart");
  });
});

describe("thumbnails", () => {
  const s = { enabled: true, intervalSec: 5, width: 160, columns: 10 };

  it("plans sheets and tile size", () => {
    expect(planThumbnails(s, { duration: 23, width: 1920, height: 1080 })).toEqual({
      count: 5,
      columns: 5,
      rows: 1,
      tileWidth: 160,
      tileHeight: 90,
      sheets: 1,
    });
    const long = planThumbnails(s, { duration: 3600, width: 1080, height: 1920 });
    expect(long).toMatchObject({ count: 720, columns: 10, rows: 10, tileHeight: 284, sheets: 8 });
  });

  it("builds the ffmpeg tile command", () => {
    const p = planThumbnails(s, { duration: 23, width: 1920, height: 1080 });
    expect(thumbnailArgs("in.mp4", "t/sheet_%03d.jpg", s, p)).toContain(
      "fps=1/5,scale=160:90,tile=5x1",
    );
  });

  it("writes a WebVTT sprite track", () => {
    const p = planThumbnails({ ...s, columns: 2 }, { duration: 23, width: 1920, height: 1080 });
    const vtt = thumbnailVtt({ ...s, columns: 2 }, p, 23, (i) => `sheet_${i + 1}.jpg`);
    expect(vtt.split("\n").slice(0, 6)).toEqual([
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:05.000",
      "sheet_1.jpg#xywh=0,0,160,90",
      "",
      "00:00:05.000 --> 00:00:10.000",
    ]);
    expect(vtt).toContain("00:00:20.000 --> 00:00:23.000\nsheet_1.jpg#xywh=0,180,160,90");
  });
});
