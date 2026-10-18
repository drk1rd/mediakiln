import { execFileSync } from "node:child_process";
import path from "node:path";

/** Build dist/ once so CLI and runtime tests exercise the real bundle. */
export default function setup(): void {
  const root = path.resolve(import.meta.dirname, "../..");
  execFileSync("npm", ["run", "build", "--silent"], { cwd: root, stdio: "inherit" });
}
