import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  override name = "CommandError";
  constructor(
    message: string,
    readonly command: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Quote an argument list for display in logs (not for execution). */
export function formatCommand(command: string, args: readonly string[]): string {
  const q = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return [command, ...args].map(q).join(" ");
}

/** Run a binary without a shell and collect its output. Rejects on non-zero exit. */
export function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) =>
      reject(new CommandError(`Failed to start ${command}: ${e.message}`, command, args, null, "")),
    );
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split("\n").slice(-8).join("\n");
        reject(
          new CommandError(
            `${command} exited with code ${code}\n${tail}`,
            command,
            args,
            code,
            stderr,
          ),
        );
      }
    });
  });
}
