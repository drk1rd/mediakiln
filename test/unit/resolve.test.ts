import { describe, expect, it } from "vitest";
import path from "node:path";
import { isExternalUrl, publicUrl, resolveUrl } from "../../src/resolve.js";

const dir = path.resolve("/site/dist");
const page = path.join(dir, "blog/post/index.html");

describe("resolveUrl", () => {
  const ctx = { dir, base: "/" };

  it("resolves absolute paths against the site dir", () => {
    expect(resolveUrl("/media/a.mp4", page, ctx)).toBe(path.join(dir, "media/a.mp4"));
  });

  it("resolves relative paths against the page directory", () => {
    expect(resolveUrl("a.mp4", page, ctx)).toBe(path.join(dir, "blog/post/a.mp4"));
    expect(resolveUrl("../../img/x.jpg", page, ctx)).toBe(path.join(dir, "img/x.jpg"));
    expect(resolveUrl("./x.jpg", page, ctx)).toBe(path.join(dir, "blog/post/x.jpg"));
  });

  it("strips the base path", () => {
    const blog = { dir, base: "/blog/" };
    expect(resolveUrl("/blog/media/a.mp4", page, blog)).toBe(path.join(dir, "media/a.mp4"));
    expect(resolveUrl("/media/a.mp4", page, blog)).toBe(path.join(dir, "media/a.mp4"));
  });

  it("strips query strings and hashes, decodes percent-escapes", () => {
    expect(resolveUrl("/media/a.mp4?v=3#t=10", page, ctx)).toBe(path.join(dir, "media/a.mp4"));
    expect(resolveUrl("/media/my%20clip.mp4", page, ctx)).toBe(path.join(dir, "media/my clip.mp4"));
  });

  it("ignores external, data and blob URLs", () => {
    for (const url of [
      "https://cdn.example.com/a.mp4",
      "http://x/a.jpg",
      "//cdn.example.com/a.mp4",
      "data:image/png;base64,xx",
      "blob:https://x/123",
      "",
      "?only=query",
    ]) {
      expect(resolveUrl(url, page, ctx)).toBeUndefined();
    }
    expect(isExternalUrl("HTTPS://X")).toBe(true);
    expect(isExternalUrl("/a")).toBe(false);
  });

  it("refuses paths escaping the site dir", () => {
    expect(resolveUrl("../../../../etc/passwd", page, ctx)).toBeUndefined();
    expect(resolveUrl("/%2e%2e/secret", page, ctx)).toBeUndefined();
  });
});

describe("publicUrl", () => {
  it("joins base and encodes segments", () => {
    expect(publicUrl("/", "_mediakiln/abc/video.mp4")).toBe("/_mediakiln/abc/video.mp4");
    expect(publicUrl("/blog/", "_mediakiln/a b/")).toBe("/blog/_mediakiln/a%20b/");
  });
});
