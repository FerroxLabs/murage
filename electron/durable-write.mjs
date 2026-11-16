// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EMAIL-ACCOUNT-CHANGE r4 section 1: what "on disk" means for credentials.bin. The temp file is written and fsynced, renamed over the real
// file, and then the rename itself is made durable: POSIX (macOS, Linux) fsyncs the parent directory; Windows reopens the renamed file and
// flushes it (FlushFileBuffers; NTFS journals the rename). Any failed step rejects, so no ack is ever sent for it. `fs` is injected for tests.

/** Writes `data` to `file` durably (see above). `fs` is node:fs (sync API). */
export function writeFileDurable(fs, file, data, { platform = process.platform, mode = 0o600, pid = process.pid } = {}) {
  const temporary = `${file}.${pid}.tmp`;
  const fd = fs.openSync(temporary, "w", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  if (platform === "win32") {
    const again = fs.openSync(file, "r+");
    try { fs.fsyncSync(again); } finally { fs.closeSync(again); }
  } else {
    const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
    const dir = slash > 0 ? file.slice(0, slash) : ".";
    const dirFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }
}
