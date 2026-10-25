import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';

/** Write JSON via temp file + fsync + rename so readers never see a torn document. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
