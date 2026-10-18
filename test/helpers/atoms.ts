import { readFileSync } from "node:fs";

/** Names of the top-level MP4 boxes, in file order. */
export function topLevelAtoms(file: string): string[] {
  const buf = readFileSync(file);
  const atoms: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(offset + 8));
    else if (size === 0) size = buf.length - offset;
    atoms.push(type);
    if (size < 8) break;
    offset += size;
  }
  return atoms;
}

export function isFaststart(file: string): boolean {
  const atoms = topLevelAtoms(file);
  const moov = atoms.indexOf("moov");
  const mdat = atoms.indexOf("mdat");
  return moov !== -1 && mdat !== -1 && moov < mdat;
}
