import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import {
  complexityFactor,
  complexityProbeArgs,
  hlsArgs,
  keyframeExpr,
  parseMasterPlaylist,
  planVariants,
  scaleFilter,
  selectRenditions,
  shouldUseHls,
} from "../../src/ffmpeg/hls.js";

const hls = DEFAULT_CONFIG.video.hls;
const MB = 1024 * 1024;

describe("shouldUseHls", () => {
  it("uses duration OR size thresholds", () => {
    expect(shouldUseHls({ duration: 10, size: 1 * MB }, hls)).toBe(true);
    expect(shouldUseHls({ duration: 9.9, size: 1 * MB }, hls)).toBe(false);
    expect(shouldUseHls({ duration: 3, size: 5 * MB }, hls)).toBe(true);
    expect(shouldUseHls({ duration: 3, size: 4.9 * MB }, hls)).toBe(false);
  });

  it("respects enabled: false", () => {
    expect(shouldUseHls({ duration: 100, size: 100 * MB }, { ...hls, enabled: false })).toBe(false);
  });
});

describe("selectRenditions", () => {
  const heights = (w: number, h: number) =>
    selectRenditions(hls.renditions, { width: w, height: h }).map((r) => r.height);

  it("drops renditions above the source", () => {
    expect(heights(1920, 1080)).toEqual([360, 720, 1080]);
    expect(heights(3840, 2160)).toEqual([360, 720, 1080]);
    expect(heights(1280, 720)).toEqual([360, 720]);
    expect(heights(854, 480)).toEqual([360]);
  });

  it("uses the short side for portrait sources", () => {
    expect(heights(1080, 1920)).toEqual([360, 720, 1080]);
    expect(heights(720, 1280)).toEqual([360, 720]);
  });

  it("keeps one rendition at source size when the source is tiny", () => {
    const r = selectRenditions(hls.renditions, { width: 427, height: 241 });
    expect(r).toEqual([{ height: 240, videoKbps: 800, audioKbps: 96 }]);
  });

  it("sorts unsorted config", () => {
    const r = selectRenditions([...hls.renditions].reverse(), { width: 1920, height: 1080 });
    expect(r.map((x) => x.height)).toEqual([360, 720, 1080]);
  });
});

describe("hlsArgs", () => {
  const base = {
    input: "in.mp4",
    hlsDir: "out/hls",
    source: { width: 1920, height: 1080 },
    segmentSec: 4,
    preset: "medium" as const,
  };

  it("matches the reference command with audio (mpegts, no short first segment)", () => {
    const args = hlsArgs({
      ...base,
      variants: planVariants(hls.renditions, ["h264"]),
      hasAudio: true,
    });
    expect(args.join(" ")).toMatchInlineSnapshot(
      `"-y -hide_banner -loglevel error -i in.mp4 -filter_complex [0:v]split=3[v0][v1][v2];[v0]scale=-2:360[v0o];[v1]scale=-2:720[v1o];[v2]scale=-2:1080[v2o] -map [v0o] -c:v:0 libx264 -b:v:0 800k -maxrate:v:0 856k -bufsize:v:0 1200k -preset:v:0 medium -profile:v:0 high -map [v1o] -c:v:1 libx264 -b:v:1 2800k -maxrate:v:1 2996k -bufsize:v:1 4200k -preset:v:1 medium -profile:v:1 high -map [v2o] -c:v:2 libx264 -b:v:2 5000k -maxrate:v:2 5350k -bufsize:v:2 7500k -preset:v:2 medium -profile:v:2 high -map a:0 -c:a:0 aac -b:a:0 96k -ac 2 -map a:0 -c:a:1 aac -b:a:1 128k -ac 2 -map a:0 -c:a:2 aac -b:a:2 128k -ac 2 -pix_fmt yuv420p -force_key_frames expr:gte(t,n_forced*4) -sc_threshold 0 -f hls -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments -hls_segment_type mpegts -hls_segment_filename out/hls/v%v/seg_%03d.ts -master_pl_name master.m3u8 -var_stream_map v:0,a:0 v:1,a:1 v:2,a:2 out/hls/v%v/index.m3u8"`,
    );
  });

  it("fMP4 with a short first segment", () => {
    const args = hlsArgs({
      ...base,
      variants: planVariants(hls.renditions.slice(0, 1), ["h264"]),
      hasAudio: false,
      segmentType: "fmp4",
      firstSegmentSec: 1,
    });
    expect(args[args.indexOf("-hls_segment_type") + 1]).toBe("fmp4");
    expect(args[args.indexOf("-hls_init_time") + 1]).toBe("1");
    expect(args[args.indexOf("-hls_segment_filename") + 1]).toBe("out/hls/v%v/seg_%03d.m4s");
    expect(args[args.indexOf("-force_key_frames") + 1]).toBe(
      "expr:if(eq(n_forced,0),1,gte(t,1+(n_forced-1)*4))",
    );
  });

  it("drops audio mapping without audio", () => {
    const args = hlsArgs({
      ...base,
      variants: planVariants(hls.renditions.slice(0, 2), ["h264"]),
      hasAudio: false,
      segmentSec: 6,
    });
    expect(args).not.toContain("a:0");
    expect(args[args.indexOf("-var_stream_map") + 1]).toBe("v:0 v:1");
    expect(args[args.indexOf("-force_key_frames") + 1]).toBe("expr:gte(t,n_forced*6)");
  });

  it("skips split for a single rendition and scales portrait by width", () => {
    const args = hlsArgs({
      ...base,
      source: { width: 1080, height: 1920 },
      variants: planVariants([hls.renditions[0]!], ["h264"]),
      hasAudio: false,
    });
    expect(args[args.indexOf("-filter_complex") + 1]).toBe("[0:v]scale=360:-2[v0o]");
    expect(scaleFilter(hls.renditions[0]!, { width: 1920, height: 1080 })).toBe("scale=-2:360");
  });

  it("adds HEVC/AV1 variants with hardware encoders", () => {
    const args = hlsArgs({
      ...base,
      variants: planVariants([hls.renditions[1]!], ["h264", "hevc", "av1"]),
      hasAudio: true,
      hw: "videotoolbox",
    });
    expect(args).toContain("h264_videotoolbox");
    expect(args).toContain("hevc_videotoolbox");
    expect(args).toContain("libsvtav1"); // no AV1 VideoToolbox encoder
    expect(args[args.indexOf("-tag:v:1") + 1]).toBe("hvc1");
    expect(args[args.indexOf("-var_stream_map") + 1]).toBe("v:0,a:0 v:1,a:1 v:2,a:2");
  });
});

describe("planVariants and per-title", () => {
  it("orders H.264 first and discounts newer codecs", () => {
    const v = planVariants(hls.renditions.slice(0, 2), ["h264", "hevc", "av1"]);
    expect(v.map((x) => `${x.codec}@${x.height}:${x.videoKbps}`)).toEqual([
      "h264@360:800",
      "h264@720:2800",
      "hevc@360:520",
      "hevc@720:1820",
      "av1@360:440",
      "av1@720:1540",
    ]);
  });

  it("applies the per-title factor with a floor", () => {
    expect(planVariants(hls.renditions, ["h264"], 0.5).map((v) => v.videoKbps)).toEqual([
      400, 1400, 2500,
    ]);
    expect(
      planVariants([{ height: 144, videoKbps: 200, audioKbps: 64 }], ["av1"], 0.35)[0]!.videoKbps,
    ).toBe(150);
  });

  it("complexityFactor clamps and scales the reference for small sources", () => {
    expect(complexityFactor(2_500_000)).toBe(1);
    expect(complexityFactor(100_000)).toBe(0.35);
    expect(complexityFactor(9_000_000)).toBe(1.25);
    expect(complexityFactor(625_000, 360)).toBe(1);
  });

  it("samples the middle of the video", () => {
    const args = complexityProbeArgs("in.mp4", "out.mp4", {
      width: 1920,
      height: 1080,
      duration: 60,
    });
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4)).toEqual([
      "-ss",
      "24.00",
      "-t",
      "12.00",
    ]);
    expect(args).toContain("scale=-2:720");
  });

  it("keyframeExpr", () => {
    expect(keyframeExpr(4, 0)).toBe("expr:gte(t,n_forced*4)");
    expect(keyframeExpr(4, 4)).toBe("expr:gte(t,n_forced*4)");
    expect(keyframeExpr(6, 2)).toBe("expr:if(eq(n_forced,0),1,gte(t,2+(n_forced-1)*6))");
  });
});

describe("parseMasterPlaylist", () => {
  it("reads bandwidth and resolution", () => {
    const text = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=967448,AVERAGE-BANDWIDTH=946116,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"
v0/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=3106512,RESOLUTION=1280x720
v1/index.m3u8
`;
    expect(parseMasterPlaylist(text)).toEqual([
      {
        bandwidth: 967448,
        width: 640,
        height: 360,
        uri: "v0/index.m3u8",
        codecs: "avc1.64001e,mp4a.40.2",
      },
      { bandwidth: 3106512, width: 1280, height: 720, uri: "v1/index.m3u8" },
    ]);
  });

  it("throws when RESOLUTION is missing", () => {
    expect(() => parseMasterPlaylist("#EXT-X-STREAM-INF:BANDWIDTH=1\nv0/index.m3u8")).toThrow(
      /RESOLUTION/,
    );
  });
});
