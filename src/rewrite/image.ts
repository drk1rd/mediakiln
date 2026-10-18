import type { ImageResult } from "../assets.js";
import type { ResolvedConfig } from "../config.js";
import type { Edit } from "../html.js";
import type { ImageRef } from "../scan.js";

export function rewriteImage(
  _html: string,
  _ref: ImageRef,
  _out: { result: ImageResult; baseUrl: string },
  _config: ResolvedConfig,
): Edit[] {
  return [];
}
