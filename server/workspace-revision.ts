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
//
// The rule stands on ctime being the kernel's own record of the last change.
// Where the stamps cannot promise that, the digest is not remembered and the
// file is hashed on every observation (canRememberDigest):
// - both stamps on a whole second. A coarse mount whose server clock lags
//   the local one makes a fresh write look settled at once, and the next
//   rewrite inside that second keeps every field.
// - a stamp ahead of the local clock: the settle window means nothing then.
// - ctime equal to mtime, to the full precision the stat reports, unless the
//   volume has shown that its ctime is a change time of its own (below). A
//   plain write sets both from one clock reading, and a mount that has no
//   change time of its own (FUSE, SMB, FAT) mirrors mtime into ctime; the
//   two look the same. On the first, a rewrite that puts mtime back still
//   moves ctime; on the second it moves nothing, and the remembered digest
//   would name bytes that are gone. A rename, chmod or an editor save
//   (staged file, renamed into place) gives ctime its own value again.
//
// Nearly every file a bot writes is a plain write that nothing renamed or
// chmod'ed afterwards, so refusing every ctime-equals-mtime state would hash
// every bot-written file on every discovery page and every 5 s parent-folder
// probe of an open document. Instead the volume is asked once, the first
// time such a state is otherwise fit to remember (probeVolumeClock): a hidden
// temp file is written in the workspace root, chmod'ed and given an mtime ten
// seconds in the past with utimes, and its stamps must show sub-second
// precision, sit at or behind the local clock, keep mtime through the chmod,
// and move ctime forward while mtime goes back. A mirror mount fails the last
// check (its ctime follows mtime into the past), a whole-second mount the
// first, a share whose clock runs ahead the second. On a volume that passes,
// ctime equal to mtime is exactly the "written once, never changed since"
// state and is remembered after the settle window like any other; a volume
// that fails keeps the refusal. Verdicts are held per device number: a pass
// for the life of the process, a failure (or a probe that could not run, say
// on a read-only root) until VOLUME_CLOCK_RETRY_MS have gone by, so an
// untrusted volume costs one temp file a minute at most, not one per file.
// The probe speaks only for the root's own device: a listing descends into a
// volume mounted inside the root (an image, a share, a FUSE mount), and a file
// there reports that volume's device number, which nobody probed. Such a file
// keeps the refusal, whatever the root's verdict; probing inside a user's
// subfolder would leave temp files there, so it is not done.
//
// Cost, measured on the 0.1.52 build Mac (Apple silicon, APFS) with the
// independent bench (200 x 2 MiB files through listWorkspaceDirectory, stamps
// left as writeFileSync made them, settled 6 s). Load average above 20: one
// page hashes in 0.26-0.39 s from a cold disk, 0.19-0.28 s page-cached, and
// answers in 2-6 ms once remembered. Load average 45 (eight build lanes):
// first listing 1.0-2.2 s including the probe (files renamed into place, the
// path that was always remembered: 1.4-1.9 s), warm listings 5-20 ms on both
// paths with the odd scheduler stall; the probe itself takes 0.7-5 ms. Before
// the probe a plain-written page paid the hashing cost on every listing
// (290-620 ms under load). On the Linux runner (Ubuntu 24.04 container,
// kernel 6.8, ext4 bind mount and overlay, idle) both volumes pass the probe
// in 15 ms (one tick wait: a utimes inside the write's coarse tick could not
// move ctime) and the same page lists in 316-362 ms first, 3-7 ms warm,
// plain-written and renamed alike. No further bound is applied at that cost.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_TEXT_MAX_BYTES, type FileRevision } from "../shared/workspace-files.ts";

/** Files up to this size carry a content digest in their revision. */
export const WORKSPACE_REVISION_CONTENT_MAX_BYTES = WORKSPACE_TEXT_MAX_BYTES;
/** Wider than the coarsest common timestamp granularity (FAT: 2 s). */
export const WORKSPACE_REVISION_SETTLE_MS = 5_000;
/** A volume that failed the clock probe (or could not be probed) is asked
 * again no sooner than this. */
export const VOLUME_CLOCK_RETRY_MS = 60_000;
const DIGEST_CACHE_MAX = 20_000;
/** Date.now() is whole milliseconds; a stamp is sub-millisecond. A stamp
 * taken just before the clock was read may sit up to one unit past it. */
const PROBE_CLOCK_SLACK_MS = 2;
/** How far the probe pushes mtime into the past: well past any tick. */
const PROBE_MTIME_BACK_MS = 10_000;
/** Linux stamps come from the coarse kernel clock (up to 10 ms a tick), so a
 * utimes inside the tick of the write cannot move ctime past it. The probe
 * waits this long and tries again, a bounded number of times. */
const PROBE_TICK_WAIT_MS = 15;
const PROBE_TICK_ATTEMPTS = 4;

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
/** Per device number: whether its ctime is a change time of its own, and
 * when a failed verdict may be asked again. */
const volumeClocks = new Map<number, { trusted: boolean; retryAt: number }>();
let forcedVolumeClock: boolean | undefined;

/** Test seam: forget remembered digests and volume verdicts. */
export function __resetWorkspaceRevisionCacheForTests(): void { digests.clear(); volumeClocks.clear(); forcedVolumeClock = undefined; }
/** Test seam: every volume answers the clock probe with `trusted` (no file
 * is written); undefined restores the real probe. */
export function __setVolumeClockForTests(trusted: boolean | undefined): void { forcedVolumeClock = trusted; volumeClocks.clear(); }

function remember(key: string, digest: string): void {
  if (digests.size >= DIGEST_CACHE_MAX) digests.delete(digests.keys().next().value!);
  digests.set(key, digest);
}

const wholeSecond = (ms: number) => ms % 1000 === 0;
const pause = (ms: number) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* not allowed here: try again at once */ } };

/**
 * Whether the volume holding `directory` keeps a change time of its own with
 * sub-second precision behind the local clock (the file header lists the
 * checks and what each one excludes). Writes, chmods, back-dates and removes
 * one hidden temp file there; false when any step fails or cannot run.
 * Exported for the tests only.
 */
export function probeVolumeClock(directory: string): boolean {
  const path = join(directory, `.murage-clock-probe-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    writeFileSync(path, "murage volume clock probe\n", { mode: 0o600, flag: "wx" });
    const written = lstatSync(path);
    const behindClock = (stat: Stats, now: number) => stat.mtimeMs <= now + PROBE_CLOCK_SLACK_MS && stat.ctimeMs <= now + PROBE_CLOCK_SLACK_MS;
    if (!Number.isFinite(written.mtimeMs) || !Number.isFinite(written.ctimeMs) || !behindClock(written, Date.now())) return false;
    chmodSync(path, 0o640);
    const changed = lstatSync(path);
    if (changed.mtimeMs !== written.mtimeMs || changed.ctimeMs < written.ctimeMs || !behindClock(changed, Date.now())) return false;
    for (let attempt = 0; attempt < PROBE_TICK_ATTEMPTS; attempt++) {
      if (attempt > 0) pause(PROBE_TICK_WAIT_MS);
      utimesSync(path, new Date(written.atimeMs), new Date(written.mtimeMs - PROBE_MTIME_BACK_MS));
      const dated = lstatSync(path);
      if (!behindClock(dated, Date.now())) return false;
      if (dated.mtimeMs >= written.mtimeMs) return false;
      if (dated.ctimeMs <= dated.mtimeMs) return false;
      if (dated.ctimeMs <= written.ctimeMs) continue;
      return !(wholeSecond(written.mtimeMs) && wholeSecond(written.ctimeMs) && wholeSecond(dated.ctimeMs));
    }
    return false;
  } catch { return false; }
  finally { try { unlinkSync(path); } catch { /* never written, or already gone */ } }
}

/** The held verdict for `dev`, probing `root` when none is fresh. Only the
 * root's own device can pass: the probe file is written there, so a device
 * the root does not sit on (a volume mounted inside it) was never probed and
 * is never trusted, whatever the root's verdict. */
function volumeClockTrusted(root: string, dev: number): boolean {
  if (forcedVolumeClock !== undefined) return forcedVolumeClock;
  const now = Date.now();
  const known = volumeClocks.get(dev);
  if (known && (known.trusted || now < known.retryAt)) return known.trusted;
  let rootDev: number | undefined;
  try { rootDev = lstatSync(root).dev; } catch { /* unreadable root: nothing was probed */ }
  const trusted = rootDev === dev && probeVolumeClock(root);
  volumeClocks.set(dev, { trusted, retryAt: now + VOLUME_CLOCK_RETRY_MS });
  return trusted;
}

/** Whether a digest read of `stat` that began at `startedAt` (local clock,
 * ms) may be reused for the same fingerprint later: the state is settled and
 * ctime is a change time of its own — either it differs from mtime, or the
 * volume passed the clock probe (`ctimeTrusted`). The file header says why
 * each stamp shape is refused. Exported for the tests only. */
export function canRememberDigest(stat: Pick<Stats, "mtimeMs" | "ctimeMs">, startedAt: number, ctimeTrusted = false): boolean {
  const { mtimeMs, ctimeMs } = stat;
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(ctimeMs)) return false;
  if (ctimeMs === mtimeMs && !ctimeTrusted) return false;
  if (wholeSecond(mtimeMs) && wholeSecond(ctimeMs)) return false;
  const newest = Math.max(mtimeMs, ctimeMs);
  if (newest > startedAt) return false;
  return newest <= startedAt - WORKSPACE_REVISION_SETTLE_MS;
}

/** SHA-256 of exactly the file state `stat` observed at `path` under `root`,
 * read through a descriptor that must still be that state before and after
 * the read. */
function digestOf(root: string, path: string, stat: Stats): string | "changed" | "unreadable" {
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
    // The volume is asked only for a state the stamps alone cannot vouch for
    // and every other rule already admits.
    if (canRememberDigest(stat, startedAt, true) && (stat.ctimeMs !== stat.mtimeMs || volumeClockTrusted(root, stat.dev))) remember(key, digest);
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
      const digest = digestOf(root, join(root, ...relativePath.split("/")), stat);
      if (digest === "changed" || digest === "unreadable") return { ok: false, reason: digest };
      sha256 = digest;
    }
  }
  const revision = `r1.${createHash("sha256").update(JSON.stringify([root, relativePath, workspaceStatFingerprint(stat), sha256])).digest("base64url")}` as FileRevision;
  return { ok: true, revision, sha256 };
}
