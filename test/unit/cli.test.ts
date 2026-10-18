import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const cli = path.join(root, "dist/cli.js");

async function runCli(args: string[]) {
  try {
    const r = await exec("node", [cli, ...args], { cwd: root });
    return { code: 0, ...r };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("cli", () => {
  const empty = path.join(root, "test/.tmp/empty");
  beforeAll(() => mkdir(empty, { recursive: true }));

  it("prints help and version", async () => {
    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--no-hls");
    expect(help.stdout).not.toContain("(default: true)");
    const v = await runCli(["--version"]);
    expect(v.stdout).toMatch(/mediakiln\/\d+\.\d+\.\d+/);
  });

  it("exits 0 with nothing to do on an empty dir", async () => {
    const r = await runCli([empty]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("nothing to do");
  });

  it("emits JSON with --json", async () => {
    const r = await runCli([empty, "--json"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ pages: { scanned: 0 }, failures: [] });
  });

  it("exits 1 for a missing dir", async () => {
    const r = await runCli([path.join(empty, "missing")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Not a directory");
  });
});

describe("cli exit codes and output modes", () => {
  it("exits 2 when an asset fails, leaving that element untouched", async () => {
    const { mkdtemp, writeFile, readFile, mkdir: mk } = await import("node:fs/promises");
    const dir = await mkdtemp(path.join(root, "test/.tmp/cli-fail-"));
    await mk(path.join(dir, "media"));
    await writeFile(path.join(dir, "media/broken.mp4"), "this is not a video");
    const html = `<video controls src="/media/broken.mp4"></video>`;
    await writeFile(path.join(dir, "index.html"), html);
    const r = await runCli([dir, "--no-cache", "--json"]);
    expect(r.code).toBe(2);
    const s = JSON.parse(r.stdout);
    expect(s.videos.failed).toBe(1);
    expect(s.failures[0]).toMatchObject({ file: "media/broken.mp4", kind: "video" });
    expect(await readFile(path.join(dir, "index.html"), "utf8")).toBe(html);
  });

  it("--dry-run --json reports without writing", async () => {
    const { mkdtemp, writeFile, readdir, mkdir: mk } = await import("node:fs/promises");
    const sharp = (await import("sharp")).default;
    const dir = await mkdtemp(path.join(root, "test/.tmp/cli-dry-"));
    await mk(path.join(dir, "img"));
    await sharp({ create: { width: 600, height: 400, channels: 3, background: "#c63" } })
      .jpeg()
      .toFile(path.join(dir, "img/a.jpg"));
    await writeFile(path.join(dir, "index.html"), `<img src="/img/a.jpg" alt="">`);
    const r = await runCli([dir, "--dry-run", "--json", "--no-cache"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      dryRun: true,
      images: { processed: 1 },
      pages: { rewritten: 1 },
    });
    expect((await readdir(dir)).sort()).toEqual(["img", "index.html"]);
  });
});
