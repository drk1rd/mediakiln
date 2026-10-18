export function posterTime(atSec: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.max(0, Math.min(atSec, duration * 0.1));
}

export function posterArgs(input: string, output: string, atSec: number): string[] {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    atSec.toFixed(3),
    "-i",
    input,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    output,
  ];
}
