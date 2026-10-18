import sharp from "sharp";

// libvips keeps recently used input files open; on Windows that locks them, so deleting or
// overwriting a source (keepOriginals: false, re-builds) fails with EBUSY. Never cache files.
sharp.cache({ files: 0 });

export default sharp;
export type { Sharp } from "sharp";
