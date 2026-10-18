import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import {
  hlsArgs,
  parseMasterPlaylist,
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
    preset: "medium",
  };

  it("matches the reference command with audio", () => {
    const args = hlsArgs({ ...base, renditions: hls.renditions, hasAudio: true });
    expect(args.join(" ")).toMatchInlineSnapshot(
      `"-y -hide_banner -loglevel error -i in.mp4 -filter_complex [0:v]split=3[v0][v1][v2];[v0]scale=-2:360[v0o];[v1]scale=-2:720[v1o];[v2]scale=-2:1080[v2o] -map [v0o] -c:v:0 libx264 -b:v:0 800k -maxrate:v:0 856k -bufsize:v:0 1200k -map [v1o] -c:v:1 libx264 -b:v:1 2800k -maxrate:v:1 2996k -bufsize:v:1 4200k -map [v2o] -c:v:2 libx264 -b:v:2 5000k -maxrate:v:2 5350k -bufsize:v:2 7500k -map a:0 -c:a:0 aac -b:a:0 96k -ac 2 -map a:0 -c:a:1 aac -b:a:1 128k -ac 2 -map a:0 -c:a:2 aac -b:a:2 128k -ac 2 -preset medium -profile:v high -pix_fmt yuv420p -force_key_frames expr:gte(t,n_forced*4) -sc_threshold 0 -f hls -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments -hls_segment_type mpegts -hls_segment_filename out/hls/v%v/seg_%03d.ts -master_pl_name master.m3u8 -var_stream_map v:0,a:0 v:1,a:1 v:2,a:2 out/hls/v%v/index.m3u8"`,
    );
  });

  it("drops audio mapping without audio", () => {
    const args = hlsArgs({
      ...base,
      renditions: hls.renditions.slice(0, 2),
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
      renditions: [hls.renditions[0]!],
      hasAudio: false,
    });
    expect(args[args.indexOf("-filter_complex") + 1]).toBe("[0:v]scale=360:-2[v0o]");
    expect(scaleFilter(hls.renditions[0]!, { width: 1920, height: 1080 })).toBe("scale=-2:360");
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
      { bandwidth: 967448, width: 640, height: 360, uri: "v0/index.m3u8" },
      { bandwidth: 3106512, width: 1280, height: 720, uri: "v1/index.m3u8" },
    ]);
  });

  it("throws when RESOLUTION is missing", () => {
    expect(() => parseMasterPlaylist("#EXT-X-STREAM-INF:BANDWIDTH=1\nv0/index.m3u8")).toThrow(
      /RESOLUTION/,
    );
  });
});
