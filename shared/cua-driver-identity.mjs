// One fd-bound integrity check for every Windows driver exe Murage launches (DESIGN 1022-cua-windows D6 a/b).
// Owner: the Windows builder lane (build-1022-cua-windows). Used by electron/cua-windows-runtime.cjs before each daemon
// spawn and by the harness before each per-turn MCP child.
//
// The file is opened ONCE; the hash is read only through that fd; the fd's identity must not change while it is read
// (an in-place write) and the path must still name the same file object right before the spawn (a rename or replace).
// On win32 the open denies write and delete sharing for the duration of the hash. A hash by path is never used.
import { createHash } from "node:crypto";
import nodeFs from "node:fs";

const EXLOCK = nodeFs.constants?.UV_FS_O_EXLOCK ?? 0x10000000;
const IDENTITY_KEYS = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];
const CHUNK = 1 << 20;

const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (error, ...out) => (error ? reject(error) : resolve(out.length > 1 ? out : out[0]))));

/** The default fs: node's callback API over plain numeric fds, so a test can inject the same five calls. */
export const defaultIdentityFs = Object.freeze({
  open: (file, flags) => call(nodeFs.open, file, flags),
  read: (fd, buffer, offset, length, position) => call(nodeFs.read, fd, buffer, offset, length, position).then(([bytesRead]) => bytesRead),
  fstat: (fd) => call(nodeFs.fstat, fd, { bigint: true }),
  stat: (file) => call(nodeFs.stat, file, { bigint: true }),
  close: (fd) => call(nodeFs.close, fd),
});

export function fileIdentity(stat) {
  return Object.fromEntries(IDENTITY_KEYS.map((key) => [key, String(stat[key])]));
}

const sameIdentity = (a, b) => IDENTITY_KEYS.every((key) => a[key] === b[key]);

/** { ok: true, identity } only when the bytes read through one fd hash to `pinSha256` and the fd and the path name
 * the same unchanged file object throughout; otherwise { ok: false, reason }. Never throws. */
export async function verifyExeIdentity(file, pinSha256, fs = defaultIdentityFs, { platform = process.platform, exclusive = platform === "win32" } = {}) {
  let fd = null;
  try {
    // exclusive (D6 a, before a daemon spawn): no write or delete sharing while hashed. The harness check (D6 b) runs
    // while the daemon executes the same exe, so it opens shared-read and relies on the fd and path identity checks.
    fd = await fs.open(file, exclusive ? nodeFs.constants.O_RDONLY | EXLOCK : nodeFs.constants.O_RDONLY);
    const before = fileIdentity(await fs.fstat(fd));
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(CHUNK);
    let position = 0;
    for (;;) {
      const bytesRead = await fs.read(fd, buffer, 0, CHUNK, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fileIdentity(await fs.fstat(fd));
    if (!sameIdentity(before, after)) return { ok: false, reason: "changed-while-hashed" };
    const digest = hash.digest("hex");
    const closing = fd;
    fd = null;
    await fs.close(closing);
    if (typeof pinSha256 !== "string" || digest !== pinSha256) return { ok: false, reason: "hash-mismatch" };
    if (!sameIdentity(before, fileIdentity(await fs.stat(file)))) return { ok: false, reason: "path-replaced" };
    return { ok: true, identity: before };
  } catch (error) {
    return { ok: false, reason: error?.code === "EBUSY" || error?.code === "EPERM" ? "busy" : "unreadable" };
  } finally {
    if (fd !== null) {
      try { await fs.close(fd); } catch { /* the answer is already decided */ }
    }
  }
}
