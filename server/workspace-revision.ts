// The one identity a workspace file revision is built from (discovery,
// bounded read, Markdown write, save-version, native open and the media
// routes all issue and check the same string).
//
// Metadata alone cannot name a file state. A revision used to be a digest of
// the root, the path and the lstat fingerprint (dev, ino, size, mtime, ctime),
// and on a filesystem whose timestamps are coarser than the time between two
// writes (Linux takes them from the kernel tick, a few milliseconds; HFS+,
// ext3 and many network shares keep whole seconds; FAT two) an equal-length
// rewrite keeps every one of those fields. A bot tool or a quick human edit
// then left the old revision valid, and Save version copied bytes the person
// never chose. So the revision also carries the SHA-256 of the exact bytes,
// for every file within the text limit — every file the editor can open or
// write, and the images and small outputs discovery shows beside them.
//
// Above that limit hashing each listed file would be unbounded work on every
// discovery page, so a larger file keeps the metadata-only identity; the
// residual race needs an equal-length rewrite inside one timestamp tick of the
// write discovery observed.
//
// Hashing is not repeated for a state already seen: a digest is remembered
// under the path and full fingerprint, and only once the file's newest
// timestamp is at least WORKSPACE_REVISION_SETTLE_MS older than the clock
// before the read. Any later change lands after that read, so its ctime (which
// no caller can set) moves past the remembered one on every filesystem whose
// granularity is finer than the window. A file that is still settling is
// hashed again on every observation. This is Git's "racy clean" rule.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_TEXT_MAX_BYTES, type FileRevision } from "../shared/workspace-files.ts";

/** Files up to this size carry a content digest in their revision. */
export const WORKSPACE_REVISION_CONTENT_MAX_BYTES = WORKSPACE_TEXT_MAX_BYTES;
/** Wider than the coarsest common timestamp granularity (FAT: 2 s). */
export const WORKSPACE_REVISION_SETTLE_MS = 5_000;
const DIGEST_CACHE_MAX = 20_000;

/** Same fields as the artifact store's source fingerprint. */
export const workspaceStatFingerprint = (stat: Stats) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type WorkspaceRevisionResult =
  /** `sha256` is null for a file above the content limit. */
  | { ok: true; revision: FileRevision; sha256: string | null }
  /** `changed`: the file is no longer the observed state. `unreadable`: it
   * could not be opened or read. Either way no revision is issued. */
  | { ok: false; reason: "changed" | "unreadable" };

const digests = new Map<string, string>();

/** Test seam: forget remembered digests. */
export function __resetWorkspaceRevisionCacheForTests(): void { digests.clear(); }

function remember(key: string, digest: string): void {
  if (digests.size >= DIGEST_CACHE_MAX) digests.delete(digests.keys().next().value!);
  digests.set(key, digest);
}

/** SHA-256 of exactly the file state `stat` observed at `path`, read through
 * a descriptor that must still be that state before and after the read. */
function digestOf(path: string, stat: Stats): string | "changed" | "unreadable" {
  const key = JSON.stringify([path, workspaceStatFingerprint(stat)]);
  const known = digests.get(key);
  if (known !== undefined) return known;
  const startedAt = Date.now();
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ELOOP" ? "changed" : "unreadable";
  }
  try {
    const expected = workspaceStatFingerprint(stat);
    if (workspaceStatFingerprint(fstatSync(fd)) !== expected) return "changed";
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) return "changed";
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || workspaceStatFingerprint(fstatSync(fd)) !== expected) return "changed";
    const digest = sha256Hex(bytes);
    const newest = Math.max(stat.mtimeMs, stat.ctimeMs);
    if (Number.isFinite(newest) && newest <= startedAt - WORKSPACE_REVISION_SETTLE_MS) remember(key, digest);
    return digest;
  } catch { return "unreadable"; }
  finally { closeSync(fd); }
}

/**
 * The revision of one observed regular file under a canonical root.
 *
 * `bytes`, when given, must be exactly the content read for `stat` (a caller
 * that already verified its read, like the bounded text read); the file is
 * then not read a second time. Such a digest is not remembered, because the
 * caller's read time is unknown here.
 */
export function workspaceRevisionOf(root: string, relativePath: string, stat: Stats, bytes?: Uint8Array): WorkspaceRevisionResult {
  let sha256: string | null = null;
  if (stat.size <= WORKSPACE_REVISION_CONTENT_MAX_BYTES) {
    if (bytes !== undefined) {
      if (bytes.length !== stat.size) return { ok: false, reason: "changed" };
      sha256 = sha256Hex(bytes);
    } else {
      const digest = digestOf(join(root, ...relativePath.split("/")), stat);
      if (digest === "changed" || digest === "unreadable") return { ok: false, reason: digest };
      sha256 = digest;
    }
  }
  const revision = `r1.${createHash("sha256").update(JSON.stringify([root, relativePath, workspaceStatFingerprint(stat), sha256])).digest("base64url")}` as FileRevision;
  return { ok: true, revision, sha256 };
}
