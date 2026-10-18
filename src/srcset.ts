export interface SrcsetCandidate {
  url: string;
  /** "480w", "2x", or undefined for a bare URL. */
  descriptor?: string;
}

/**
 * Parse a `srcset` attribute (WHATWG algorithm, simplified): candidates are separated by commas;
 * a URL runs until whitespace, and a trailing comma on the URL ends the candidate.
 */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  let i = 0;
  const s = value;
  while (i < s.length) {
    while (i < s.length && (/\s/.test(s[i]!) || s[i] === ",")) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j]!)) j++;
    let url = s.slice(i, j);
    i = j;
    if (url.endsWith(",")) {
      out.push({ url: url.replace(/,+$/, "") });
      continue;
    }
    let k = i;
    while (k < s.length && s[k] !== ",") k++;
    const descriptor = s.slice(i, k).trim();
    i = k + 1;
    url = url.trim();
    if (url) out.push(descriptor ? { url, descriptor } : { url });
  }
  return out;
}

export function serializeSrcset(candidates: SrcsetCandidate[]): string {
  return candidates.map((c) => (c.descriptor ? `${c.url} ${c.descriptor}` : c.url)).join(", ");
}
