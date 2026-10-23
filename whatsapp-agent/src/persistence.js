// Private, same-filesystem atomic JSON replacement. Never truncate the old
// file; remove an owned temporary on every failure (including serialization).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function atomicJSON(file, value, { space = 0 } = {}) {
  const content = JSON.stringify(value, null, space);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false, fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, content);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* failed write */ } }
    // Never unlink a pre-existing file if exclusive creation failed.
    if (created) { try { fs.unlinkSync(temp); } catch { /* renamed */ } }
  }
  return file;
}
