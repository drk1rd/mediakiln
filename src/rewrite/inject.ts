import type { Edit } from "../html.js";

export function runtimeScriptTag(base: string, runtimePath: string): string {
  return `<script type="module" src="${base}${runtimePath}"></script>`;
}

/**
 * Insert the runtime loader once, right before `</body>` (or at the end of the document).
 * When `</body>` sits on its own line, the script goes on a new line with the same indentation.
 */
export function injectRuntime(html: string, at: number, base: string, runtimePath: string): Edit {
  const tag = runtimeScriptTag(base, runtimePath);
  let lineStart = at;
  while (lineStart > 0 && (html[lineStart - 1] === " " || html[lineStart - 1] === "\t"))
    lineStart--;
  if (lineStart === 0 || html[lineStart - 1] === "\n") {
    const indent = html.slice(lineStart, at);
    return { start: lineStart, end: lineStart, text: `${indent}${tag}\n` };
  }
  return { start: at, end: at, text: tag };
}
