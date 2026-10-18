import path from "node:path";

const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/** True for URLs mediakiln never touches: http(s), protocol-relative, data:, blob:, mailto:, … */
export function isExternalUrl(url: string): boolean {
  return EXTERNAL.test(url.trim());
}

/** Strip `?query` and `#hash`, then percent-decode. Returns undefined for malformed URLs. */
export function cleanUrlPath(url: string): string | undefined {
  const bare = url.trim().replace(/[?#].*$/, "");
  if (!bare) return undefined;
  try {
    return decodeURIComponent(bare);
  } catch {
    return undefined;
  }
}

export interface ResolveContext {
  /** Absolute site directory. */
  dir: string;
  /** Normalized base path, starting and ending with "/". */
  base: string;
}

/**
 * Map a URL found in `htmlFile` to an absolute file path inside the site dir.
 * Returns undefined for external URLs, empty URLs and anything escaping the site dir.
 */
export function resolveUrl(url: string, htmlFile: string, ctx: ResolveContext): string | undefined {
  if (isExternalUrl(url)) return undefined;
  const clean = cleanUrlPath(url);
  if (!clean) return undefined;

  let file: string;
  if (clean.startsWith("/")) {
    const rel = clean.startsWith(ctx.base)
      ? clean.slice(ctx.base.length)
      : ctx.base !== "/" && clean === ctx.base.slice(0, -1)
        ? ""
        : clean.slice(1);
    file = path.join(ctx.dir, rel);
  } else {
    file = path.join(path.dirname(htmlFile), clean);
  }
  file = path.resolve(file);
  const relToDir = path.relative(ctx.dir, file);
  if (!relToDir || relToDir.startsWith("..") || path.isAbsolute(relToDir)) return undefined;
  return file;
}

/** Public URL for a path relative to the site dir, honoring `base`. */
export function publicUrl(base: string, relPath: string): string {
  const encoded = relPath
    .split(/[\\/]/)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return base + encoded;
}
