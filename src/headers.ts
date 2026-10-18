import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResolvedConfig } from "./config.js";

const START = "# mediakiln:start";
const END = "# mediakiln:end";

/**
 * The `_headers` rule (Cloudflare Pages and Netlify syntax) marking every generated file as
 * immutable. Asset folders are content-hashed and runtime files are versioned, so a URL's
 * content never changes.
 */
export function headersBlock(config: ResolvedConfig): string {
  return [
    START,
    `${config.base}${config.outDirName}/*`,
    "  Cache-Control: public, max-age=31536000, immutable",
    END,
  ].join("\n");
}

/** Insert or update mediakiln's block in `<dir>/_headers`, leaving the user's rules alone. */
export function mergeHeaders(existing: string, block: string): string {
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + END.length);
  }
  if (!existing.trim()) return block + "\n";
  return existing.replace(/\n*$/, "\n\n") + block + "\n";
}

export async function writeHeaders(dir: string, config: ResolvedConfig): Promise<void> {
  const file = path.join(dir, "_headers");
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    // no _headers yet
  }
  const next = mergeHeaders(existing, headersBlock(config));
  if (next !== existing) await fs.writeFile(file, next);
}
