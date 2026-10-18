import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Total size in bytes of every file below `dir`. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else if (entry.isFile()) total += (await fs.stat(p)).size;
  }
  return total;
}

/** A fresh, unique sibling path used as a temp location before an atomic rename. */
export function tempSibling(target: string): string {
  return `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
}

/**
 * Atomically move a fully written directory into place. If `target` already exists
 * (another run won the race), the temp copy is discarded and the existing one is kept.
 */
export async function commitDir(tmp: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if ((code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM") && (await exists(target))) {
      await fs.rm(tmp, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/** Recursively copy a directory, hard-linking files where the filesystem allows it. */
export async function linkOrCopyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await linkOrCopyDir(s, d);
    } else if (entry.isFile()) {
      try {
        await fs.link(s, d);
      } catch {
        await fs.copyFile(s, d);
      }
    }
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
