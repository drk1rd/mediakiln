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
