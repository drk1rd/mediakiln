import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

export type Element = DefaultTreeAdapterMap["element"];
export type Document = DefaultTreeAdapterMap["document"];
export type ParentNode = DefaultTreeAdapterMap["parentNode"];
type ChildNode = DefaultTreeAdapterMap["childNode"];

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export function parseHtml(html: string): Document {
  return parse(html, { sourceCodeLocationInfo: true });
}

export function getAttr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

export function hasAttr(el: Element, name: string): boolean {
  return el.attrs.some((a) => a.name === name);
}

function isElement(node: ChildNode | ParentNode): node is Element {
  return "tagName" in node;
}

/** Depth-first walk over elements in document order. Skips <template> contents. */
export function* walkElements(node: ParentNode): Generator<Element> {
  for (const child of node.childNodes as ChildNode[]) {
    if (!isElement(child)) continue;
    yield child;
    if (child.tagName !== "template") yield* walkElements(child);
  }
}

export function childElements(el: Element): Element[] {
  return (el.childNodes as ChildNode[]).filter(isElement);
}

export function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Serialize one attribute. Empty values render as bare boolean attributes. */
export function attr(name: string, value: string | true): string {
  return value === true || value === "" ? name : `${name}="${escapeAttr(value)}"`;
}

/**
 * Rebuild an element's start tag. Existing attributes keep their exact original source text
 * unless they are listed in `remove` or overridden in `set`; new attributes are appended in
 * the order given. `tagName` renames the element (dropping any `/>` self-closing slash, since
 * the new element gets a real end tag).
 */
export function rebuildStartTag(
  html: string,
  el: Element,
  changes: {
    remove?: Iterable<string>;
    set?: Array<[string, string | true]>;
    tagName?: string;
  },
): string {
  const loc = el.sourceCodeLocation;
  if (!loc?.startTag) throw new Error(`<${el.tagName}> has no source location`);
  const remove = new Set(changes.remove ?? []);
  const set = new Map(changes.set ?? []);
  const parts: string[] = [];
  for (const a of el.attrs) {
    if (remove.has(a.name)) continue;
    if (set.has(a.name)) {
      parts.push(attr(a.name, set.get(a.name)!));
      set.delete(a.name);
      continue;
    }
    const aloc = loc.attrs?.[a.name];
    parts.push(aloc ? html.slice(aloc.startOffset, aloc.endOffset) : attr(a.name, a.value));
  }
  for (const [name, value] of set) parts.push(attr(name, value));
  const original = html.slice(loc.startTag.startOffset, loc.startTag.endOffset);
  const selfClosing = !changes.tagName && /\/\s*>$/.test(original) ? " /" : "";
  return `<${changes.tagName ?? el.tagName}${parts.length ? " " + parts.join(" ") : ""}${selfClosing}>`;
}

/**
 * Widen a removal range to swallow the indentation before it and the line break after it,
 * when the removed tag sits on its own line. Keeps the surrounding formatting tidy.
 */
export function widenToLine(html: string, start: number, end: number): [number, number] {
  let s = start;
  while (s > 0 && (html[s - 1] === " " || html[s - 1] === "\t")) s--;
  let e = end;
  while (e < html.length && (html[e] === " " || html[e] === "\t")) e++;
  const atLineStart = s === 0 || html[s - 1] === "\n";
  if (atLineStart && (e === html.length || html[e] === "\n" || html[e] === "\r")) {
    if (html[e] === "\r") e++;
    if (html[e] === "\n") e++;
    return [s, e];
  }
  return [start, end];
}

/** Apply non-overlapping edits to the source. */
export function applyEdits(html: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = html;
  let lastStart = Infinity;
  for (const e of sorted) {
    if (e.end > lastStart) throw new Error("Overlapping HTML edits");
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
  }
  return out;
}
