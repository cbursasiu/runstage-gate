import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write JSON so readers only ever see the old or the new file, never a torn one:
 * write a temp file in the same directory, fsync it, then rename over the target.
 * Files are created 0600 because they hold token hashes and job data.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
