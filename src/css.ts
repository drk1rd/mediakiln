import postcss, { type Declaration } from "postcss";

const URL_RE = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g;
const BACKGROUND_PROPS = new Set(["background", "background-image"]);

/** Every `url(...)` in background declarations of a stylesheet (or a style attribute body). */
export function findBackgroundUrls(css: string, opts: { inline?: boolean } = {}): string[] {
  const urls: string[] = [];
  forEachBackground(css, opts, (decl) => {
    for (const m of decl.value.matchAll(URL_RE)) urls.push(m[2]!.trim());
  });
  return urls;
}

export interface ImageSetEntry {
  url: string;
  mime: string;
}

function parse(css: string, inline: boolean) {
  // A style attribute holds declarations only; wrap them in a rule so postcss can parse them.
  return postcss.parse(inline ? `x{${css}}` : css);
}

function forEachBackground(
  css: string,
  opts: { inline?: boolean },
  fn: (decl: Declaration) => void,
): ReturnType<typeof parse> | undefined {
  let root;
  try {
    root = parse(css, Boolean(opts.inline));
  } catch {
    return undefined; // unparseable CSS is left alone
  }
  root.walkDecls((decl) => {
    if (BACKGROUND_PROPS.has(decl.prop.toLowerCase())) fn(decl);
  });
  return root;
}

function alreadyEnhanced(decl: Declaration): boolean {
  if (/image-set\(/i.test(decl.value)) return true;
  const next = decl.next();
  return (
    next?.type === "decl" &&
    next.prop.toLowerCase() === "background-image" &&
    /image-set\(/i.test(next.value)
  );
}

const imageSet = (entries: ImageSetEntry[]) =>
  `image-set(${entries.map((e) => `url('${e.url}') type('${e.mime}')`).join(", ")})`;

/**
 * Add a `background-image: image-set(...)` declaration after every background whose image has
 * modern-format alternatives. The original declaration stays first, as the fallback for
 * browsers without `image-set(type())`. Returns undefined when nothing changed.
 *
 * `alternatives(url)` returns the AVIF/WebP entries for a URL plus the original's MIME type,
 * or undefined to leave that URL alone.
 */
export function addImageSets(
  css: string,
  alternatives: (url: string) => { modern: ImageSetEntry[]; originalMime: string } | undefined,
  opts: { inline?: boolean } = {},
): string | undefined {
  let changed = false;
  const root = forEachBackground(css, opts, (decl) => {
    if (alreadyEnhanced(decl)) return;
    const matches = [...decl.value.matchAll(URL_RE)];
    if (matches.length === 0) return;
    const shorthand = decl.prop.toLowerCase() === "background";
    // A shorthand mixes images with position, size, colour…; only its single-image form maps
    // cleanly onto background-image.
    if (shorthand && (matches.length !== 1 || /gradient\(/i.test(decl.value))) return;

    let any = false;
    const replaced = (shorthand ? matches[0]![0] : decl.value).replace(
      URL_RE,
      (whole, _q, raw: string) => {
        const alt = alternatives(raw.trim());
        if (!alt || alt.modern.length === 0) return whole;
        any = true;
        return imageSet([...alt.modern, { url: raw.trim(), mime: alt.originalMime }]);
      },
    );
    if (!any) return;
    decl.cloneAfter({
      prop: "background-image",
      value: replaced,
      important: decl.important,
      // The first declaration of a block has no leading whitespace; keep ours readable.
      raws: { ...decl.raws, before: decl.raws.before || " " },
    });
    changed = true;
  });
  if (!root || !changed) return undefined;
  const out = root.toString();
  if (!opts.inline) return out;
  return out.slice(2, -1); // unwrap x{...}
}

export const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  tiff: "image/tiff",
  gif: "image/gif",
};
