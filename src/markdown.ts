/**
 * Experimental Markdown support: media in `.md` files is rewritten in place as inline HTML,
 * which every CommonMark renderer passes through.
 */

/**
 * Replace fenced code blocks, indented-free inline code spans and HTML comments with spaces
 * (keeping newlines and every offset), so examples inside them are never treated as media.
 */
export function maskMarkdownCode(md: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  // A fence runs to a closing fence of the same kind, or to the end of the document. (`$`
  // means end-of-line under the m flag, hence the explicit end-of-input lookaheads.)
  let out = md.replace(
    /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm,
    blank,
  );
  out = out.replace(/<!--[\s\S]*?-->/g, blank);
  out = out.replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, blank);
  return out;
}

export interface MarkdownImage {
  start: number;
  end: number;
  alt: string;
  url: string;
  title?: string;
}

/** `![alt](url "title")` images (not reference-style), on masked Markdown. */
export function findMarkdownImages(masked: string): MarkdownImage[] {
  const re =
    /!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?\s*\)/g;
  const out: MarkdownImage[] = [];
  for (const m of masked.matchAll(re)) {
    const url = m[2]!.replace(/^<|>$/g, "");
    const title = m[3]?.slice(1, -1).replace(/\\(.)/g, "$1");
    out.push({
      start: m.index!,
      end: m.index! + m[0].length,
      alt: m[1]!.replace(/\\(.)/g, "$1"),
      url,
      ...(title !== undefined ? { title } : {}),
    });
  }
  return out;
}
