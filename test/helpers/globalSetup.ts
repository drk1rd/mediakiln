import { execFileSync } from "node:child_process";
import path from "node:path";

/** Build dist/ once so CLI and runtime tests exercise the real bundle. */
export default function setup(): void {
  const root = path.resolve(import.meta.dirname, "../..");
  // npm is npm.cmd on Windows, which Node only spawns through a shell.
  execFileSync("npm", ["run", "build", "--silent"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}
