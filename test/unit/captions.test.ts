import { describe, expect, it } from "vitest";
import { captionsMaster, subtitlePlaylist, withTimestampMap } from "../../src/ffmpeg/captions.js";

describe("captions", () => {
  it("adds or replaces X-TIMESTAMP-MAP", () => {
    expect(withTimestampMap("﻿WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nHi\r\n", 0)).toBe(
      "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:01.000 --> 00:02.000\nHi\n",
    );
    expect(
      withTimestampMap("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:1,LOCAL:00:00:00.000\n\ncue", 126000),
    ).toBe("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n\ncue");
  });

  it("writes a single-segment subtitle playlist", () => {
    expect(subtitlePlaylist(12.3)).toContain(
      "#EXT-X-TARGETDURATION:13\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:12.300,\nsubs.vtt\n#EXT-X-ENDLIST",
    );
  });

  it("wraps a master with subtitle renditions", () => {
    const master = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360,CODECS="avc1.64001e"',
      "v0/index.m3u8",
      "",
      '#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1280x720,CODECS="avc1.64001f"',
      "v1/index.m3u8",
    ].join("\n");
    const out = captionsMaster(master, "../abc/hls/", [
      { file: "a.vtt", kind: "subtitles", srclang: "de", label: 'Deutsch "DE"', default: false },
      { file: "b.vtt", kind: "captions", default: true },
    ]);
    expect(out).toMatchInlineSnapshot(`
      "#EXTM3U
      #EXT-X-VERSION:7
      #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Deutsch 'DE'",LANGUAGE="de",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="subs/0/index.m3u8"
      #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Track 2",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound",URI="subs/1/index.m3u8"

      #EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360,CODECS="avc1.64001e",SUBTITLES="subs"
      ../abc/hls/v0/index.m3u8

      #EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1280x720,CODECS="avc1.64001f",SUBTITLES="subs"
      ../abc/hls/v1/index.m3u8"
    `);
  });
});
