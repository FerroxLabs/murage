// Image attachments: pasted/dropped images become files under
// ~/.murage/attachments so every CLI engine can open them by path —
// the app never ships image bytes through the prompt itself.
// Incremental accounting adapted from OpenMausBot PR #938 (2c6e4ece), with
// Murage quota-pressure cleanup and failed-partial byte accounting retained.
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { basename, join, extname, dirname, resolve } from "node:path";
import { DATA_DIR } from "./config.ts";
import { addOutstandingBytes, availableForNewBytes, diskSpaceError, freeDiskBytes, isNoSpaceError, outstandingBytes } from "./disk-space.ts";
import { DISK_FULL_MESSAGE } from "../shared/attachment-storage.ts";
import {
  ATTACHMENT_READ_CEILING, REMOVED_FOLDER, attachmentRemoved, attachmentsFolderForWriter, attachmentsHomeOf, isAttachmentName, probeAttachment,
  readAttachmentFile, type AttachmentsHome, type ProbeResult, type Refusal,
} from "./attachment-read.ts";

/** The attachment folder as an opaque value (attachment-read.ts). Readers
 * outside this module take this, never a path string. */
export const ATTACHMENTS_HOME: AttachmentsHome = attachmentsHomeOf(DATA_DIR);
/** The writer's own folder path. Not exported: every byte read goes through
 * attachment-read.ts, and the gate test holds this module to "wx" opens. */
const ATTACHMENTS_DIR = attachmentsFolderForWriter(ATTACHMENTS_HOME);
/** One empty marker file per removed name (SL-H): the record of a Remove. */
const REMOVED_DIR = join(ATTACHMENTS_DIR, REMOVED_FOLDER);

/** Free bytes on the disk that holds the attachment folder (Settings > Storage). */
export function attachmentsFreeBytes(): number | null {
  return freeDiskBytes(ATTACHMENTS_DIR);
}

/** The spec's ceiling: a screenshot bigger than this is rejected before it
 * is ever buffered, matching the composer's existing size discipline. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Images a generation provider returns: a 4K PNG can pass 10 MB, so the
 * generated-image path (retained receipt, conversation attachment, Files,
 * the media viewer, Save, and use as a reference) has its own larger cap,
 * the same 25 MiB every one of those accepts. Uploads keep IMAGE_MAX_BYTES. */
export const GENERATED_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
/** One image as the provider sends it may be larger; a render over the kept
 * cap is refused with its size, never cut. */
export const GENERATED_IMAGE_RECEIVE_MAX_BYTES = 40 * 1024 * 1024;

/** Shared documents are deliberately smaller than Cloudflare's transport
 * ceiling. This is a local inbox, not unbounded remote storage. */
export const FILE_MAX_BYTES = 25 * 1024 * 1024;

/** Attachments are durable because prompts refer to their paths. Never
 * silently evict them. There is no fixed total: room follows the disk
 * (disk-space.ts), and only a nearly full disk gets an explicit 507. */

/** A byte count as a person reads it: 512 MB, 25 MB, 1.5 GB. */
export function humanBytes(bytes: number): string {
  const units: Array<[number, string]> = [[1024 ** 3, "GB"], [1024 ** 2, "MB"], [1024, "KB"]];
  for (const [size, unit] of units) if (bytes >= size) return `${Number((bytes / size).toFixed(1))} ${unit}`;
  return `${bytes} bytes`;
}
/** The sentences a composer shows for attachment limits (0.1.60 audit C4:
 * "attachments storage is full (limit 536870912 bytes)" reached it). */
export const ATTACHMENTS_FULL_MESSAGE = DISK_FULL_MESSAGE;
export const FILE_TOO_LARGE_MESSAGE = `That file is too large. Files can be up to ${humanBytes(FILE_MAX_BYTES)}.`;
export const IMAGE_TOO_LARGE_MESSAGE = `That image is too large. Images can be up to ${humanBytes(IMAGE_MAX_BYTES)}.`;

/** Interrupted streamed uploads use private partial files. A crash can leave
 * one behind, so future uploads remove only our stale partials — never a
 * committed attachment that a transcript may still reference. */
export const ATTACHMENT_PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;

const PARTIAL_NAME = /^\.murage-upload-[0-9a-f-]+-[0-9a-f-]+\.partial$/i;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activePartials = new Set<string>();
const uploadLocks = new Map<string, Promise<void>>();
const STREAM_RESERVATION_INCREMENT_BYTES = 1024 * 1024;

/** Cached total of on-disk bytes Murage keeps as attachments: committed
 * attachments plus any partial file this process did not itself write (a
 * crash leftover, until it is cleaned up). `null` means a fresh scan is needed
 * after cold start or a cleanup failure. Every normal commit
 * and delete after that updates it in place instead of rescanning, which is
 * what makes reservation growth O(1) rather than O(directory size).
 *
 * This is single-process, in-memory state: it does not see files another
 * process adds or removes in ATTACHMENTS_DIR. That is an accepted limit
 * (the app runs one server per data dir; uploadLocks already assumes the
 * same), not a design gap this fix covers. */
let committedAttachmentBytes: number | null = null;
// An async link can finish while another upload invalidates or refreshes the
// cache. Its bytes must not be added again if a scan may already include it.
let attachmentAccountingVersion = 0;

/** Force a fresh disk total and invalidate any in-flight commit's snapshot. */
function invalidateAttachmentAccounting(): void {
  committedAttachmentBytes = null;
  attachmentAccountingVersion += 1;
}

/** Mimes the endpoint accepts, mapped to the extension stored on disk.
 * Sniffing is not attempted — a lie here only changes the filename. */
const IMAGE_MIMES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** Useful document formats accepted by the phone share sheet.
 * Generic archives, binaries, HTML, SVG, and executable/script mimes stay
 * out. Office/OpenDocument packages are allowed because they are documents,
 * despite using ZIP internally. The claimed mime determines the extension;
 * an attacker-controlled filename never does. */
const FILE_MIMES: Readonly<Record<string, string>> = {
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/rtf": ".rtf",
  "text/rtf": ".rtf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/vnd.oasis.opendocument.presentation": ".odp",
};

/** Frozen key lists of IMAGE_MIMES and FILE_MIMES, in declaration order, for the share-and-ask fixtures (apps/mobile/contract/share-types.json). */
export const SHARE_IMAGE_MIMES: readonly string[] = Object.freeze(Object.keys(IMAGE_MIMES));
export const SHARE_FILE_MIMES: readonly string[] = Object.freeze(Object.keys(FILE_MIMES));

export function extensionForMime(mime: string | undefined): string | null {
  if (!mime) return null;
  return IMAGE_MIMES[mime.split(";")[0]!.trim().toLowerCase()] ?? null;
}

export function ensureAttachmentsDir(): void {
  try {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw isNoSpaceError(error) ? diskSpaceError("disk-full") : error;
  }
}

export function validateAttachmentUploadId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!UPLOAD_ID.test(normalized)) {
    throw statusError(400, "uploadId must be a UUID");
  }
  return normalized;
}

/** The one full directory walk. Run from cold or invalidated accounting,
 * or from an explicit cleanup sweep — never
 * from the per-reservation hot path, which is what made PERF-03 quadratic. */
function scanAttachmentUsageAndCleanup(now = Date.now()): { bytes: number; removed: number } {
  // now = +Infinity (start-up) makes every inactive partial stale.
  ensureAttachmentsDir();
  let bytes = 0;
  let removed = 0;
  finishPendingRemovals();
  for (const entry of readdirSync(ATTACHMENTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(ATTACHMENTS_DIR, entry.name);
    // A live partial is represented by its in-memory reservation. A fresh
    // orphan from a crashed process still occupies disk and therefore counts
    // until this same scan is allowed to remove it.
    if (PARTIAL_NAME.test(entry.name) && activePartials.has(path)) continue;
    try {
      const stat = statSync(path);
      if (PARTIAL_NAME.test(entry.name) && now - stat.mtimeMs >= ATTACHMENT_PARTIAL_MAX_AGE_MS) {
        try { unlinkSync(path); removed += 1; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") bytes += stat.size;
        }
      } else {
        bytes += stat.size;
      }
    } catch (error) {
      // A vanished entry consumes zero. An unreadable one must not make the
      // quota cache optimistic about bytes that may still be on disk.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { bytes, removed };
}

/** SL-H H3: a marker whose file is still there (a crash between the marker
 * and the unlink, or an unlink the system refused) has its file unlinked
 * now. Bounded by the number of markers; a file that still cannot be
 * unlinked stays for the next scan, and readers refuse it from its marker. */
function finishPendingRemovals(): void {
  let markers: string[];
  try { markers = readdirSync(REMOVED_DIR); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  for (const name of markers) {
    if (!isAttachmentName(name)) continue;
    try { unlinkSync(join(ATTACHMENTS_DIR, name)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") console.warn(`[attachments] a removed attachment could not be deleted yet; the next scan tries again (${code ?? "error"})`);
    }
  }
}

/** Return cached usage, initializing it from disk after cold start or
 * invalidation. Reservations must use this rather than trusting a cold cache. */
function committedBytes(): number {
  if (committedAttachmentBytes === null) {
    committedAttachmentBytes = scanAttachmentUsageAndCleanup().bytes;
    attachmentAccountingVersion += 1;
  }
  return committedAttachmentBytes;
}

/** A newly committed file (saveFile/saveImage success path only — never the
 * idempotent-retry branches, which reuse bytes already counted) adds to the
 * cache. If accounting changed during an async link, a scan may already have
 * counted that file. Let the next reservation rescan instead of adding twice. */
function addCommittedBytes(delta: number, version = attachmentAccountingVersion): void {
  if (version !== attachmentAccountingVersion || committedAttachmentBytes === null) {
    invalidateAttachmentAccounting();
    return;
  }
  committedAttachmentBytes += delta;
}

/** Remove only abandoned temporary uploads, and refresh the cached usage
 * total from the same fresh scan. Outside accounting recovery, this is the
 * only full directory walk after start-up; nothing on the upload path calls it
 * per byte or per chunk anymore, so callers that want stale partials
 * reclaimed promptly should invoke it on their own schedule. */
export function cleanupStaleAttachmentPartials(now = Date.now(), options: { startup?: boolean } = {}): number {
  // At start-up no earlier process can still be writing (one server per data
  // dir), so every partial this process is not writing is a leftover, whatever
  // its age. A live upload's partial is in activePartials before it is opened.
  const { bytes, removed } = scanAttachmentUsageAndCleanup(options.startup ? Number.POSITIVE_INFINITY : now);
  committedAttachmentBytes = bytes;
  attachmentAccountingVersion += 1;
  return removed;
}

/** What attachments hold now, for storage settings: committed bytes on disk
 * (from the cache, scanning once when cold) and bytes held by uploads still
 * streaming. Reporting only; neither decides whether an upload fits. */
export function attachmentStorageUsage(): { attachmentBytes: number; reservedBytes: number } {
  return { attachmentBytes: committedBytes(), reservedBytes: outstandingBytes() };
}

/** Delete a committed attachment (e.g. a generated image whose owning
 * message/turn was retired) and keep the quota cache in sync. Every caller
 * outside this module that removes a file saveImage/saveFile created must
 * route through here instead of a raw unlink, or the cache will overcount
 * forever and eventually reject uploads that should fit. */
export type DeleteResult = { ok: true } | { ok: false; code: string };
export function deleteAttachment(path: string): DeleteResult {
  if (dirname(resolve(path)) !== resolve(ATTACHMENTS_DIR)) return { ok: false, code: "outside" };
  try {
    // Only bother sizing it if the cache is already warm — if it isn't, the
    // eventual first scan just won't see this file, which is correct.
    const size = committedAttachmentBytes !== null ? statSync(path).size : 0;
    unlinkSync(path);
    if (committedAttachmentBytes !== null) {
      committedAttachmentBytes = Math.max(0, committedAttachmentBytes - size);
    }
    return { ok: true };
  } catch (error) {
    // A previously counted entry may already have disappeared. Reconcile on
    // the next reservation instead of retaining its bytes indefinitely.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") { invalidateAttachmentAccounting(); return { ok: true }; }
    return { ok: false, code: code ?? "error" };
  }
}

/** What Remove did with one name (SL-H H1). `pending`: the marker stands but
 * the file could not be unlinked yet (Windows: a file open for a read); the
 * next scan finishes it (H3). `failed`: no marker could be written, so
 * nothing was unlinked. */
export type RemoveResult = { state: "removed" } | { state: "pending"; code: string } | { state: "failed"; code: string };

/** Remove one stored attachment for good (SL-H H1): first its marker, the
 * record that it was removed, then its file. Marker first, so a process that
 * stops between the two never leaves a file gone with no record; every
 * reader refuses the name from its marker on (H2), and the next scan unlinks
 * a file whose marker it finds (H3). A marker already there is fine: a second
 * Remove goes on to the unlink, which then finds nothing. The caller has
 * checked the name. */
export function removeAttachment(name: string): RemoveResult {
  if (!isAttachmentName(name)) return { state: "failed", code: "EINVAL" };
  try {
    ensureAttachmentsDir();
    mkdirSync(REMOVED_DIR, { recursive: true, mode: 0o700 });
    const markerPath = join(REMOVED_DIR, name);
    try { writeFileSync(markerPath, "", { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    console.warn(`[attachments] Remove could not record ${name} as removed, so nothing was deleted (${code})`);
    return { state: "failed", code };
  }
  const deleted = deleteAttachment(join(ATTACHMENTS_DIR, name));
  if (deleted.ok) return { state: "removed" };
  console.warn(`[attachments] ${name} is removed but its file could not be deleted yet; the next scan tries again (${deleted.code})`);
  invalidateAttachmentAccounting();
  return { state: "pending", code: deleted.code };
}

/** SL-H H5: a removed name is never written again. Asked as the last step
 * before an upload links its file into place. */
function refuseRemovedName(name: string): void {
  if (attachmentRemoved(ATTACHMENTS_HOME, name)) throw statusError(409, REMOVED_UPLOAD_MESSAGE);
}
export const REMOVED_UPLOAD_MESSAGE = "That attachment was removed";

/** Test-only: force the next quota check to rescan the directory instead of
 * trusting the cache. Needed because tests mutate ATTACHMENTS_DIR directly
 * (truncateSync, rmSync, writeFileSync) to simulate quota states, which the
 * cache can't observe. */
export function __resetAttachmentAccountingForTests(): void {
  invalidateAttachmentAccounting();
}

/** A retry owns the same UUID namespace as the interrupted attempt. Once it
 * holds that UUID's in-process lock, any inactive partial with the prefix is
 * from a crashed/failed process and can be replaced immediately instead of
 * consuming quota for an hour. */
function cleanupAttachmentPartialsForUpload(uploadId: string): void {
  ensureAttachmentsDir();
  const prefix = `.murage-upload-${uploadId}-`;
  for (const entry of readdirSync(ATTACHMENTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !PARTIAL_NAME.test(entry.name)) continue;
    const path = join(ATTACHMENTS_DIR, entry.name);
    if (activePartials.has(path)) continue;
    try {
      // Only bother sizing it if the cache is already warm — if it isn't,
      // the eventual first scan runs after this unlink and simply never
      // sees the file, so there is nothing to reconcile.
      const size = committedAttachmentBytes !== null ? statSync(path).size : 0;
      unlinkSync(path);
      if (committedAttachmentBytes !== null) {
        committedAttachmentBytes = Math.max(0, committedAttachmentBytes - size);
      }
    } catch {
      // A concurrent cleanup already removed the abandoned attempt.
    }
  }
}

class AttachmentReservation {
  private held = 0;
  private released = false;

  reserve(bytes: number): void {
    if (this.released || bytes <= 0) return;
    this.reserveAtLeast(bytes, bytes);
  }

  private reserveAtLeast(required: number, preferred: number): void {
    ensureAttachmentsDir();
    let available = availableForNewBytes(ATTACHMENTS_DIR);
    if (available < required) {
      // Old crash leftovers still take disk: reclaim them before refusing.
      cleanupStaleAttachmentPartials();
      available = availableForNewBytes(ATTACHMENTS_DIR);
    }
    if (available < required) {
      throw diskSpaceError("disk-full");
    }
    // Unknown-length HTTP bodies reserve in bounded chunks. Taking whatever
    // remains below the preferred increment avoids falsely rejecting a small
    // final upload near the quota while still bounding directory scans.
    const granted = Math.min(preferred, available);
    addOutstandingBytes(granted);
    this.held += granted;
  }

  ensure(bytes: number): void {
    if (bytes <= this.held) return;
    const required = bytes - this.held;
    const remainingPerFileCapacity = FILE_MAX_BYTES - this.held;
    const preferred = Math.min(
      Math.max(required, STREAM_RESERVATION_INCREMENT_BYTES),
      remainingPerFileCapacity,
    );
    this.reserveAtLeast(required, preferred);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    addOutstandingBytes(-this.held);
    this.held = 0;
  }
}

async function withUploadLock<T>(uploadId: string | undefined, operation: () => Promise<T>): Promise<T> {
  if (!uploadId) return operation();
  const previous = uploadLocks.get(uploadId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  uploadLocks.set(uploadId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (uploadLocks.get(uploadId) === current) uploadLocks.delete(uploadId);
  }
}

/** Every committed attachment name is `${uuid}${extension}` for one of these
 * fixed extensions — saveFile/saveImage never write any other suffix — so
 * whether a given upload ID is already committed, and under which content
 * type, can be answered with a handful of direct stats instead of a scan
 * over every file in the directory. */
const KNOWN_ATTACHMENT_EXTENSIONS = Array.from(
  new Set([...Object.values(IMAGE_MIMES), ...Object.values(FILE_MIMES)]),
);

const CHECK_AGAIN_MESSAGE = "Could not check the earlier upload. Try again.";

/** Only `missing` is absence. A busy or failing disk is never read as "not
 * there": it answers 503 so the client retries (Astra r3 item 5). */
function retryable(reason: Refusal): boolean { return reason === "io" || reason === "busy"; }

/** Find an idempotent retry without listing the directory, rejecting an ID
 * already committed under a different accepted content type. Anything at the
 * exact name that is not missing counts as committed; the compare that
 * follows refuses it unless it is the same bytes. */
async function committedUpload(uploadId: string, extension: string): Promise<string | null> {
  ensureAttachmentsDir();
  const exactName = `${uploadId}${extension}`;
  const exact = await probeAttachment(ATTACHMENTS_HOME, exactName, ATTACHMENT_READ_CEILING);
  if (!exact.ok && retryable(exact.reason)) throw statusError(503, CHECK_AGAIN_MESSAGE);
  if (exact.ok || exact.reason !== "missing") return join(ATTACHMENTS_DIR, exactName);
  for (const other of KNOWN_ATTACHMENT_EXTENSIONS) {
    if (other === extension) continue;
    const found = await probeAttachment(ATTACHMENTS_HOME, `${uploadId}${other}`, ATTACHMENT_READ_CEILING);
    if (!found.ok && retryable(found.reason)) throw statusError(503, CHECK_AGAIN_MESSAGE);
    if (found.ok || found.reason !== "missing") {
      throw statusError(409, "uploadId was already used for another content type");
    }
  }
  return null;
}

/** Compare a committed attachment with the retry's bytes through the bounded
 * reader. The retry answers the same requester the route authorized and
 * writes nothing on a refusal, so no membership re-check is needed here. */
async function committedMatches(path: string, size: number, matches: (bytes: Buffer) => boolean, conflict: string): Promise<void> {
  const read = await readAttachmentFile(ATTACHMENTS_HOME, basename(path), size);
  if (!read.ok && retryable(read.reason)) throw statusError(503, CHECK_AGAIN_MESSAGE);
  if (!read.ok || read.bytes.length !== size || !matches(read.bytes)) throw statusError(409, conflict);
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Results of saveImage that wrote a NEW file in that call (not an idempotent
 * retry that found the committed file). Kept off the result's own shape, which
 * is the upload route's JSON answer. */
const newlyWritten = new WeakSet<object>();
export const savedAsNewFile = (saved: object): boolean => newlyWritten.has(saved);

export interface SavedAttachment {
  path: string;
  mime: string;
  bytes: number;
}

export interface SavedFile extends SavedAttachment {
  /** Safe display name derived from the shared filename. The on-disk name is
   * always the UUID at the end of `path`. */
  name: string;
}

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function normalizedMime(mime: string | undefined): string | null {
  const value = mime?.split(";")[0]?.trim().toLowerCase();
  return value || null;
}

export function extensionForFileMime(mime: string | undefined): string | null {
  const value = normalizedMime(mime);
  return value ? FILE_MIMES[value] ?? null : null;
}

/** Strip platform-reserved characters and replace any sender-provided
 * extension with the canonical one for the accepted mime. Separators and
 * encoded separators are rejected rather than massaged so traversal attempts
 * remain visible as bad requests. */
export function sanitizeSharedFileName(name: string, mime: string): string {
  const extension = extensionForFileMime(mime);
  if (!extension) throw statusError(400, "content-type must be a supported document type");

  const normalized = name.normalize("NFKC").trim();
  if (!normalized) throw statusError(400, "name is required");
  if (normalized.length > 512) throw statusError(400, "name is too long");
  if (/[\\/]/.test(normalized) || /%(?:00|2f|5c)/i.test(normalized)) {
    throw statusError(400, "name must be a filename, not a path");
  }

  const dot = normalized.lastIndexOf(".");
  const withoutExtension = dot > 0 ? normalized.slice(0, dot) : normalized;
  const safeCharacters = Array.from(withoutExtension, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || "<>:\"|?*".includes(character) ? "_" : character;
  }).join("");
  const stem = safeCharacters
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const boundedStem = Array.from(stem).slice(0, 180).join("");
  if (!boundedStem) throw statusError(400, "name must contain visible characters");
  return `${boundedStem}${extension}`;
}

/** Stream one shared document to a generated file without ever collecting
 * the request in memory. A failed, empty, or oversized upload leaves no
 * partial file behind. */
export async function saveFile(
  chunks: AsyncIterable<Uint8Array>,
  originalName: string,
  mime: string,
  options: { uploadId?: string; expectedBytes?: number } = {},
): Promise<SavedFile> {
  const normalized = normalizedMime(mime);
  if (!normalized || !extensionForFileMime(normalized)) {
    throw statusError(400, "content-type must be a supported document type");
  }
  const name = sanitizeSharedFileName(originalName, normalized);
  const extension = extensionForFileMime(normalized)!;
  const uploadId = validateAttachmentUploadId(options.uploadId);
  const expectedBytes = options.expectedBytes;
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) {
    throw statusError(400, "content-length must be a non-negative integer");
  }
  if (expectedBytes !== undefined && expectedBytes > FILE_MAX_BYTES) {
    throw statusError(413, FILE_TOO_LARGE_MESSAGE);
  }

  return withUploadLock(uploadId, async () => {
    ensureAttachmentsDir();
    if (uploadId) cleanupAttachmentPartialsForUpload(uploadId);
    const existing = uploadId ? await committedUpload(uploadId, extension) : null;
    if (existing) {
      const incomingHash = createHash("sha256");
      let bytes = 0;
      for await (const value of chunks) {
        const chunk = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (chunk.byteLength === 0) continue;
        if (bytes + chunk.byteLength > FILE_MAX_BYTES) {
          throw statusError(413, FILE_TOO_LARGE_MESSAGE);
        }
        incomingHash.update(chunk);
        bytes += chunk.byteLength;
      }
      if (bytes === 0) throw statusError(400, "empty file");
      const incoming = incomingHash.digest("hex");
      await committedMatches(existing, bytes, saved => sha256Hex(saved) === incoming, "uploadId was already used for different file bytes");
      return { path: existing, name, mime: normalized, bytes };
    }

    const id = uploadId ?? randomUUID();
    const path = join(ATTACHMENTS_DIR, `${id}${extension}`);
    const partialPath = join(ATTACHMENTS_DIR, `.murage-upload-${id}-${randomUUID()}.partial`);
    const reservation = new AttachmentReservation();
    if (expectedBytes) reservation.reserve(expectedBytes);
    activePartials.add(partialPath);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    const writtenHash = createHash("sha256");
    let bytes = 0;
    let closed = false;
    let partialCleanupFailed = false;

    try {
      file = await open(partialPath, "wx", 0o600);
      for await (const value of chunks) {
        const chunk = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (chunk.byteLength === 0) continue;
        if (bytes + chunk.byteLength > FILE_MAX_BYTES) {
          throw statusError(413, FILE_TOO_LARGE_MESSAGE);
        }
        reservation.ensure(bytes + chunk.byteLength);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await file.write(chunk, offset, chunk.byteLength - offset, null);
          if (result.bytesWritten === 0) throw new Error("file write made no progress");
          offset += result.bytesWritten;
        }
        writtenHash.update(chunk);
        bytes += chunk.byteLength;
      }
      if (bytes === 0) throw statusError(400, "empty file");
      await file.close();
      closed = true;
      try {
        const accountingVersion = attachmentAccountingVersion;
        refuseRemovedName(basename(path));
        await link(partialPath, path);
        addCommittedBytes(bytes, accountingVersion);
        await unlink(partialPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // The chunks were hashed as they were written: the partial is never read back.
        const written = writtenHash.digest("hex");
        await committedMatches(path, bytes, saved => sha256Hex(saved) === written, "uploadId was already used for different file bytes");
        await unlink(partialPath);
      }
      return { path, name, mime: normalized, bytes };
    } catch (error) {
      if (file && !closed) await file.close().catch(() => undefined);
      await unlink(partialPath).catch(() => { partialCleanupFailed = true; });
      throw isNoSpaceError(error) ? diskSpaceError("disk-full") : error;
    } finally {
      activePartials.delete(partialPath);
      // A leftover partial was excluded from the cache while active. Rescan
      // after releasing it so a retry cannot subtract bytes never counted.
      if (partialCleanupFailed) invalidateAttachmentAccounting();
      reservation.release();
    }
  });
}

/** How an image is committed. writeImage itself never reads an existing file.
 * - fresh: a new random name; a collision is refused, never trusted.
 * - receipt: the name is the output receipt's id and the bytes were just
 *   verified against the receipt's sha256 and length, so an existing entry is
 *   atomically replaced with them. saveReceiptImage first compares an
 *   existing entry with them byte for byte through the leaf reader and
 *   reuses it when identical, so re-completion needs no room on a full disk;
 *   an entry that differs, or one that could not be read, is never vouched
 *   for: it is replaced, or the completion stays pending.
 * - upload: the HTTP path; an existing entry is handed back to the async
 *   caller, which compares it through the bounded reader. */
type ImageMode = { mode: "fresh" } | { mode: "receipt"; id: string } | { mode: "upload"; id: string };

function checkedImageExtension(bytes: Buffer, mime: string, maxBytes: number): string {
  const ext = extensionForMime(mime);
  if (!ext) throw Object.assign(new Error("unsupported image type"), { status: 400 });
  if (bytes.byteLength === 0) throw Object.assign(new Error("empty image"), { status: 400 });
  if (bytes.byteLength > maxBytes) {
    throw Object.assign(new Error(maxBytes === IMAGE_MAX_BYTES ? IMAGE_TOO_LARGE_MESSAGE : `That image is too large. Images can be up to ${humanBytes(maxBytes)}.`), { status: 413 });
  }
  return ext;
}

const imageMime = (mime: string) => mime.split(";")[0]!.trim().toLowerCase();

function writeImage(bytes: Buffer, mime: string, maxBytes: number, how: ImageMode): SavedAttachment | { exists: string } {
  const ext = checkedImageExtension(bytes, mime, maxBytes);
  const id = how.mode === "fresh" ? randomUUID() : validateAttachmentUploadId(how.id)!;
  ensureAttachmentsDir();
  const name = `${id}${ext}`;
  const path = join(ATTACHMENTS_DIR, name);
  const reservation = new AttachmentReservation();
  reservation.reserve(bytes.byteLength);
  const partialPath = join(ATTACHMENTS_DIR, `.murage-upload-${id}-${randomUUID()}.partial`);
  activePartials.add(partialPath);
  let partialCleanupFailed = false;
  let createdHere = false;
  let replaced = false;
  try {
    writeFileSync(partialPath, bytes, { mode: 0o600, flag: "wx" });
    try {
      if (how.mode !== "receipt") refuseRemovedName(name);
      linkSync(partialPath, path);
      addCommittedBytes(bytes.byteLength);
      createdHere = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (how.mode === "fresh") throw statusError(409, "Could not store the image. Try again.");
      if (how.mode === "upload") {
        unlinkSync(partialPath);
        return { exists: path };
      }
      // receipt: replace the entry with the verified bytes, atomically
      renameSync(partialPath, path);
      replaced = true;
    }
    if (!replaced) unlinkSync(partialPath);
    const result = { path, mime: imageMime(mime), bytes: bytes.byteLength };
    if (createdHere) newlyWritten.add(result);
    return result;
  } catch (error) {
    try {
      unlinkSync(partialPath);
    } catch {
      partialCleanupFailed = true;
    }
    throw isNoSpaceError(error) ? diskSpaceError("disk-full") : error;
  } finally {
    activePartials.delete(partialPath);
    if (partialCleanupFailed || replaced) invalidateAttachmentAccounting();
    reservation.release();
  }
}

/** Persist one image under a new random name and return its path. Write
 * only: nothing existing is read. */
export function saveImage(bytes: Buffer, mime: string, maxBytes = IMAGE_MAX_BYTES): SavedAttachment {
  return writeImage(bytes, mime, maxBytes, { mode: "fresh" }) as SavedAttachment;
}

/** Commit an output receipt's verified bytes under the receipt's id (see
 * ImageMode). An existing entry of the same size is read through the leaf
 * module and compared byte for byte; when identical it is reused and nothing
 * is written (re-completion on a full disk finishes). Otherwise, or when the
 * entry could not be read, the verified bytes are written; on a full disk
 * that refuses with the disk-space error and the completion stays pending. */
export async function saveReceiptImage(bytes: Buffer, mime: string, receiptId: string, maxBytes: number): Promise<SavedAttachment> {
  const ext = checkedImageExtension(bytes, mime, maxBytes);
  const name = `${validateAttachmentUploadId(receiptId)!}${ext}`;
  ensureAttachmentsDir();
  const existing = await readAttachmentFile(ATTACHMENTS_HOME, name, bytes.byteLength);
  if (existing.ok && existing.bytes.length === bytes.byteLength && existing.bytes.equals(bytes)) {
    return { path: join(ATTACHMENTS_DIR, name), mime: imageMime(mime), bytes: bytes.byteLength };
  }
  return writeNewReceiptImage(bytes, mime, receiptId, maxBytes);
}

/** Commit the verified bytes of a receipt retained in the same synchronous
 * step (its id is new, so no entry can exist yet). Write only: nothing is
 * read; an entry that somehow exists is atomically replaced, never reused. */
export function writeNewReceiptImage(bytes: Buffer, mime: string, receiptId: string, maxBytes: number): SavedAttachment {
  return writeImage(bytes, mime, maxBytes, { mode: "receipt", id: receiptId }) as SavedAttachment;
}

/** HTTP uploads take the same per-ID lock as streamed files, which prevents
 * an image and a document using the same caller-supplied UUID from
 * committing with different extensions at the same time. A retry is compared
 * through the bounded reader and answered without writing. */
export async function saveImageUpload(
  bytes: Buffer,
  mime: string,
  requestedUploadId?: string,
): Promise<SavedAttachment> {
  const uploadId = validateAttachmentUploadId(requestedUploadId);
  return withUploadLock(uploadId, async () => {
    if (uploadId) cleanupAttachmentPartialsForUpload(uploadId);
    const ext = checkedImageExtension(bytes, mime, IMAGE_MAX_BYTES);
    const same = (path: string) => committedMatches(path, bytes.byteLength, saved => saved.equals(bytes), "uploadId was already used for different image bytes")
      .then(() => ({ path, mime: imageMime(mime), bytes: bytes.byteLength }));
    if (!uploadId) return saveImage(bytes, mime);
    const existing = await committedUpload(uploadId, ext);
    if (existing) return same(existing);
    const written = writeImage(bytes, mime, IMAGE_MAX_BYTES, { mode: "upload", id: uploadId });
    return "exists" in written ? same(written.exists) : written;
  });
}

const SERVED_IMAGE = /^[A-Za-z0-9-]+\.(png|jpg|jpeg|gif|webp)$/;
const servedImageName = (name: string) => SERVED_IMAGE.test(name) && extname(name) !== ".jpeg"; // saved as .jpg; .jpeg is not a name we write

/** readAttachment's own name, folder and size rules without the read: a name
 * this accepts is one the attachment route can serve. */
export async function probeServedImage(name: string): Promise<ProbeResult> {
  if (!servedImageName(name)) return { ok: false, reason: "not-regular" };
  return probeAttachment(ATTACHMENTS_HOME, name, ATTACHMENT_READ_CEILING);
}

/** Existence check for avatars: "retry" when the disk could not answer, so a
 * busy disk is never reported as an invalid avatar. */
export async function attachmentExists(name: string): Promise<boolean | "retry"> {
  const probe = await probeServedImage(name);
  if (probe.ok) return true;
  return retryable(probe.reason) ? "retry" : false;
}

export type AttachmentServe =
  | { ok: true; bytes: Buffer; mime: string; version: string }
  | { ok: false; reason: Refusal; code?: string };

/** Read an attachment back for serving. Only names that are exactly a bare
 * filename (no separators, no dotfiles) inside ATTACHMENTS_DIR resolve —
 * the route must never become a general file server for the data dir.
 *
 * `version` names these bytes: their size and a digest of the bytes read.
 * A name is reused when its file was deleted and saved again under the same
 * uploadId. Size, mtime and inode did not tell those apart on Linux: the
 * freed inode came straight back and both writes landed in one clock tick,
 * so a cached thumbnail of the old image matched the new one (0.1.61 CI). */
export async function readAttachment(name: string): Promise<AttachmentServe> {
  if (!servedImageName(name)) return { ok: false, reason: "missing" };
  const read = await readAttachmentFile(ATTACHMENTS_HOME, name, ATTACHMENT_READ_CEILING);
  if (!read.ok) return read;
  return { ok: true, bytes: read.bytes, mime: mimeForExt(extname(name)), version: `${read.bytes.length}:${sha256Hex(read.bytes).slice(0, 32)}` };
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
