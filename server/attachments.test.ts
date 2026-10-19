// attachments.ts: save + read-back, the mime allowlist, size ceiling, and
// the name-lock that keeps the serving route inside the attachments dir.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { link, open, unlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, link: vi.fn(fs.link), unlink: vi.fn(fs.unlink), open: vi.fn(fs.open) };
});
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, unlinkSync: vi.fn(fs.unlinkSync), readdirSync: vi.fn(fs.readdirSync), writeFileSync: vi.fn(fs.writeFileSync), mkdirSync: vi.fn(fs.mkdirSync) };
});
const realUnlink = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).unlink;
const realLink = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).link;
const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const realUnlinkSync = actualFs.unlinkSync;
const realWriteFileSync = actualFs.writeFileSync;
const realMkdirSync = actualFs.mkdirSync;
afterEach(() => {
  vi.mocked(open).mockReset().mockImplementation(realOpen);
  vi.mocked(writeFileSync).mockReset().mockImplementation(realWriteFileSync);
  vi.mocked(unlink).mockReset().mockImplementation(realUnlink);
  vi.mocked(link).mockReset().mockImplementation(realLink);
  vi.mocked(unlinkSync).mockReset().mockImplementation(realUnlinkSync);
  vi.mocked(mkdirSync).mockReset().mockImplementation(realMkdirSync);
});

// The module reads DATA_DIR at import time, so the env var must be set
// before the import is evaluated.
const DATA_ROOT = mkdtempSync(join(tmpdir(), "murage-attachments-"));
process.env.MURAGE_DATA_DIR = join(DATA_ROOT, "data");

const {
  ATTACHMENT_PARTIAL_MAX_AGE_MS,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  __resetAttachmentAccountingForTests,
  attachmentStorageUsage,
  cleanupStaleAttachmentPartials,
  deleteAttachment,
  extensionForFileMime,
  extensionForMime,
  readAttachment,
  sanitizeSharedFileName,
  saveFile,
  saveImage,
  saveImageUpload,
  writeNewReceiptImage,
  savedAsNewFile,
  validateAttachmentUploadId,
} = await import("./attachments.ts");
const { storedPathOf } = await import("./attachment-read.ts");
const ATTACHMENTS_DIR = dirname(storedPathOf((await import("./attachments.ts")).ATTACHMENTS_HOME, "x.png"));
const { DISK_FLOOR_BYTES, __resetOutstandingBytesForTests, __setFreeDiskProbeForTests, outstandingBytes } = await import("./disk-space.ts");
const { DISK_FULL_MESSAGE, DISK_UNKNOWN_MESSAGE } = await import("../shared/attachment-storage.ts");

/** The room a modelled disk has above the floor in the quota-shaped tests.
 * 1.0.3: there is no fixed attachment total any more; these tests keep their
 * shape against a disk whose free space shrinks with what the folder holds. */
const TEST_ROOM = 512 * 1024 * 1024;
const NO_ROOM = /almost out of disk space/;
/** Free bytes on a disk holding only this folder: apparent sizes, each inode
 * once (a committed file and its not-yet-removed partial are one link). */
function modelledDiskFree(): number {
  let used = 0;
  const seen = new Set<number>();
  try {
    for (const name of actualFs.readdirSync(ATTACHMENTS_DIR)) {
      try {
        const stat = actualFs.statSync(join(ATTACHMENTS_DIR, name));
        if (!stat.isFile() || seen.has(stat.ino)) continue;
        seen.add(stat.ino); used += stat.size;
      } catch { /* vanished */ }
    }
  } catch { /* no folder yet */ }
  return DISK_FLOOR_BYTES + TEST_ROOM - used;
}

// The cache tracks committed bytes in memory; anything that mutates
// ATTACHMENTS_DIR directly on disk (rmSync/truncateSync/writeFileSync, all
// used below to force quota states without a real 512MiB file) must reset it
// so the next quota check rescans instead of trusting stale counts.
function resetDir() {
  removeTempDirSync(ATTACHMENTS_DIR);
  __resetAttachmentAccountingForTests();
}

const UPLOAD_A = "11111111-1111-4111-8111-111111111111";
const UPLOAD_B = "22222222-2222-4222-8222-222222222222";

describe("extensionForMime", () => {
  it("maps the accepted image mimes to extensions", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/gif")).toBe(".gif");
    expect(extensionForMime("image/webp")).toBe(".webp");
  });

  it("tolerates parameters and casing", () => {
    expect(extensionForMime("Image/PNG; charset=binary")).toBe(".png");
    expect(extensionForMime("  image/webp  ")).toBe(".webp");
  });

  it("refuses everything else — including svg, which executes script", () => {
    expect(extensionForMime("image/svg+xml")).toBeNull();
    expect(extensionForMime("text/plain")).toBeNull();
    expect(extensionForMime(undefined)).toBeNull();
  });
});

describe("saveImage", () => {
  beforeEach(() => {
    resetDir();
  });
  afterEach(() => {
    resetDir();
  });

  it("persists bytes under the attachments dir with a generated name", () => {
    const saved = saveImage(Buffer.from("png-bytes"), "image/png");
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.path.endsWith(".png")).toBe(true);
    expect(saved.bytes).toBe(9);
    expect(saved.mime).toBe("image/png");
    if (process.platform !== "win32") {
      expect(statSync(ATTACHMENTS_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips through readAttachment with the right mime", async () => {
    const saved = saveImage(Buffer.from("gif!"), "image/gif");
    const name = saved.path.split(/[\\/]/).pop()!;
    const back = await readAttachment(name);
    if (!back.ok) throw new Error(back.reason);
    expect(back.bytes.toString()).toBe("gif!");
    expect(back.mime).toBe("image/gif");
  });

  it("tells a newly written upload from an idempotent retry that found the file", async () => {
    const uploadId = "33333333-3333-4333-8333-333333333333";
    const first = await saveImageUpload(Buffer.from("pixels-N"), "image/png", uploadId);
    const retry = await saveImageUpload(Buffer.from("pixels-N"), "image/png", uploadId);
    expect(savedAsNewFile(first)).toBe(true);
    expect(savedAsNewFile(retry)).toBe(false);
    expect(savedAsNewFile(saveImage(Buffer.from("pixels-M"), "image/png"))).toBe(true);
  });

  it("names the bytes it read with a version that changes when a reused name gets other bytes", async () => {
    const uploadId = "22222222-2222-4222-8222-222222222222";
    const saved = await saveImageUpload(Buffer.from("pixels-A"), "image/png", uploadId);
    const name = saved.path.split(/[\\/]/).pop()!;
    const first = await readAttachment(name);
    if (!first.ok) throw new Error(first.reason);
    expect(first.version).toMatch(/^8:[0-9a-f]{32}$/);
    // the same digits as 1.0.2: size, then the first 32 hex of the sha256
    expect(first.version).toBe(`8:${createHash("sha256").update("pixels-A").digest("hex").slice(0, 32)}`);
    // Read again, unchanged: the same version, so a cached thumbnail is reused.
    const again = await readAttachment(name);
    expect(again.ok && again.version).toBe(first.version);
    // Deleted with its message, then saved again under the same uploadId with
    // other bytes of the same length: the thumbnail cache must not match.
    deleteAttachment(saved.path);
    await saveImageUpload(Buffer.from("pixels-B"), "image/png", uploadId);
    const second = await readAttachment(name);
    if (!second.ok) throw new Error(second.reason);
    expect(second.bytes.toString()).toBe("pixels-B");
    expect(second.version).not.toBe(first.version);
    deleteAttachment(saved.path);
  });

  it("rejects unsupported mimes, empty bodies, and oversize bodies", () => {
    expect(() => saveImage(Buffer.from("x"), "image/svg+xml")).toThrow(/unsupported image type/);
    expect(() => saveImage(Buffer.alloc(0), "image/png")).toThrow(/empty/);
    expect(() => saveImage(Buffer.alloc(IMAGE_MAX_BYTES + 1), "image/png")).toThrow(/too large/);
  });

  it("makes UUID-keyed image retries idempotent without changing legacy callers", async () => {
    const first = await saveImageUpload(Buffer.from("same"), "image/png", UPLOAD_A);
    const retry = await saveImageUpload(Buffer.from("same"), "image/png", UPLOAD_A.toUpperCase());
    expect(retry).toEqual(first);
    expect(readdirSync(ATTACHMENTS_DIR).filter((name) => !name.startsWith("."))).toEqual([`${UPLOAD_A}.png`]);

    await expect(saveImageUpload(Buffer.from("different"), "image/png", UPLOAD_A)).rejects.toThrow(/different image bytes/);
    await expect(saveImageUpload(Buffer.from("same"), "image/jpeg", UPLOAD_A)).rejects.toThrow(/another content type/);

    const legacyOne = saveImage(Buffer.from("same"), "image/png");
    const legacyTwo = saveImage(Buffer.from("same"), "image/png");
    expect(legacyOne.path).not.toBe(legacyTwo.path);
  });

  it("validates upload IDs before they can become filenames", () => {
    expect(validateAttachmentUploadId(UPLOAD_A.toUpperCase())).toBe(UPLOAD_A);
    for (const value of ["", "short", "../../escape", `${UPLOAD_A}.png`, "00000000-0000-0000-0000-000000000000"]) {
      expect(() => validateAttachmentUploadId(value)).toThrow(/UUID/);
    }
  });
});

describe("aggregate attachment storage", () => {
  beforeEach(() => {
    resetDir();
    __setFreeDiskProbeForTests(() => modelledDiskFree());
  });
  afterEach(() => {
    resetDir();
    __setFreeDiskProbeForTests(undefined);
    __resetOutstandingBytesForTests();
  });

  it("rejects new data at the aggregate ceiling without pruning committed attachments", () => {
    const referenced = saveImage(Buffer.from("x"), "image/png");
    truncateSync(referenced.path, TEST_ROOM);
    __resetAttachmentAccountingForTests();

    try {
      saveImage(Buffer.from("y"), "image/png");
      throw new Error("expected quota rejection");
    } catch (error) {
      expect(error).toMatchObject({ status: 507 });
      expect(error).toHaveProperty("message", DISK_FULL_MESSAGE);
      expect(error).toMatchObject({ code: "disk-full" });
    }
    expect(existsSync(referenced.path)).toBe(true);
    expect(statSync(referenced.path).size).toBe(TEST_ROOM);
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([referenced.path.split(/[\\/]/).pop()!]);
  });

  it("counts concurrent reservations so uploads cannot race past the ceiling", async () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, TEST_ROOM - 5);
    __resetAttachmentAccountingForTests();

    const first = saveFile((async function* () {
      yield Buffer.from("four");
    })(), "first.txt", "text/plain", { expectedBytes: 4 });

    expect(() => saveImage(Buffer.from("xx"), "image/png")).toThrow(NO_ROOM);
    await expect(first).resolves.toMatchObject({ bytes: 4 });
  });

  it("lets an unknown-length stream use the exact space left below a reservation increment", async () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, TEST_ROOM - 2);
    __resetAttachmentAccountingForTests();

    const saved = await saveFile((async function* () {
      yield Buffer.from("a");
    })(), "last-byte.txt", "text/plain");
    expect(saved.bytes).toBe(1);
    expect(() => saveImage(Buffer.from("b"), "image/png")).not.toThrow();
  });

  it("releases reservations and removes partials after failed uploads", async () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, TEST_ROOM - 3);
    __resetAttachmentAccountingForTests();

    await expect(saveFile((async function* () {})(), "empty.txt", "text/plain", { expectedBytes: 3 }))
      .rejects.toThrow(/empty file/);
    expect(() => saveImage(Buffer.from("123"), "image/png")).not.toThrow();
    expect(readdirSync(ATTACHMENTS_DIR).every((name) => !name.endsWith(".partial"))).toBe(true);
  });

  it("cleans only stale upload partials, never committed or active-looking files", () => {
    writeNewReceiptImage(Buffer.from("kept"), "image/png", UPLOAD_A, IMAGE_MAX_BYTES);
    const stale = `${ATTACHMENTS_DIR}/.murage-upload-${UPLOAD_A}-${UPLOAD_B}.partial`;
    const fresh = `${ATTACHMENTS_DIR}/.murage-upload-${UPLOAD_B}-${UPLOAD_A}.partial`;
    const unrelated = `${ATTACHMENTS_DIR}/notes.partial`;
    writeFileSync(stale, "stale");
    writeFileSync(fresh, "fresh");
    writeFileSync(unrelated, "not ours");
    const now = Date.now();
    const old = new Date(now - ATTACHMENT_PARTIAL_MAX_AGE_MS - 1_000);
    utimesSync(stale, old, old);

    expect(cleanupStaleAttachmentPartials(now)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(`${ATTACHMENTS_DIR}/${UPLOAD_A}.png`)).toBe(true);
  });

  it("counts fresh crash leftovers against quota, then reclaims them when stale", () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, TEST_ROOM - 2);
    __resetAttachmentAccountingForTests();
    const orphan = `${ATTACHMENTS_DIR}/.murage-upload-${UPLOAD_A}-${UPLOAD_B}.partial`;
    writeFileSync(orphan, "xx");

    expect(() => saveImage(Buffer.from("y"), "image/png")).toThrow(NO_ROOM);
    const old = new Date(Date.now() - ATTACHMENT_PARTIAL_MAX_AGE_MS - 1_000);
    utimesSync(orphan, old, old);
    // Quota pressure still triggers cleanup, without scanning each MiB of a
    // normal successful upload.
    expect(() => saveImage(Buffer.from("y"), "image/png")).not.toThrow();
    expect(existsSync(orphan)).toBe(false);
  });

  it("reclaims an inactive partial immediately when its upload ID retries", async () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, TEST_ROOM - 3);
    __resetAttachmentAccountingForTests();
    const orphan = `${ATTACHMENTS_DIR}/.murage-upload-${UPLOAD_A}-${UPLOAD_B}.partial`;
    writeFileSync(orphan, "old");

    const saved = await saveFile((async function* () {
      yield Buffer.from("new");
    })(), "retry.txt", "text/plain", { uploadId: UPLOAD_A, expectedBytes: 3 });
    expect(saved.path.endsWith(`${UPLOAD_A}.txt`)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it("frees quota after deleteAttachment, without a rescan, for a file the cache already knows about", () => {
    const first = saveImage(Buffer.from("x"), "image/png");
    truncateSync(first.path, TEST_ROOM - 2);
    __resetAttachmentAccountingForTests();
    expect(() => saveImage(Buffer.from("yyy"), "image/png")).toThrow(NO_ROOM);

    deleteAttachment(first.path);
    expect(existsSync(first.path)).toBe(false);
    const second = saveImage(Buffer.from("yyy"), "image/png");
    expect(second.bytes).toBe(3);
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([second.path.split(/[\\/]/).pop()!]);
  });

  it.each([1, 2])("counts a committed upload after %i partial-cleanup failures and an idempotent retry", async (failures) => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, TEST_ROOM - 3);
    __resetAttachmentAccountingForTests();
    const cleanupError = Object.assign(new Error("partial file is locked"), { code: "EPERM" });
    for (let attempt = 0; attempt < failures; attempt++) {
      vi.mocked(unlink).mockRejectedValueOnce(cleanupError);
    }
    const chunks = async function* () { yield Buffer.from("xx"); };

    await expect(saveFile(chunks(), "retry.txt", "text/plain", { uploadId: UPLOAD_A }))
      .rejects.toThrow("partial file is locked");
    expect(readFileSync(join(ATTACHMENTS_DIR, `${UPLOAD_A}.txt`), "utf8")).toBe("xx");
    expect(readdirSync(ATTACHMENTS_DIR).filter((name) => name.endsWith(".partial"))).toHaveLength(failures - 1);

    await expect(saveFile(chunks(), "retry.txt", "text/plain", { uploadId: UPLOAD_A }))
      .resolves.toMatchObject({ bytes: 2 });
    expect(readdirSync(ATTACHMENTS_DIR).some((name) => name.endsWith(".partial"))).toBe(false);
    expect(() => saveImage(Buffer.from("y"), "image/png")).not.toThrow();
    expect(() => saveImage(Buffer.from("z"), "image/png")).toThrow(NO_ROOM);
  });

  it.each([1, 2])("counts an image after %i partial-cleanup failures and an idempotent retry", async (failures) => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, TEST_ROOM - 3);
    __resetAttachmentAccountingForTests();
    for (let attempt = 0; attempt < failures; attempt++) {
      vi.mocked(unlinkSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("partial file is locked"), { code: "EPERM" });
      });
    }

    expect(() => writeNewReceiptImage(Buffer.from("xx"), "image/png", UPLOAD_A, IMAGE_MAX_BYTES)).toThrow("partial file is locked");
    expect(readFileSync(join(ATTACHMENTS_DIR, `${UPLOAD_A}.png`), "utf8")).toBe("xx");
    expect(readdirSync(ATTACHMENTS_DIR).filter((name) => name.endsWith(".partial"))).toHaveLength(failures - 1);
    await expect(saveImageUpload(Buffer.from("xx"), "image/png", UPLOAD_A)).resolves.toMatchObject({ bytes: 2 });
    expect(readdirSync(ATTACHMENTS_DIR).some((name) => name.endsWith(".partial"))).toBe(false);
    expect(() => saveImage(Buffer.from("y"), "image/png")).not.toThrow();
    expect(() => saveImage(Buffer.from("z"), "image/png")).toThrow(NO_ROOM);
  });

  it("does not count an in-flight commit twice when cleanup failure causes a rescan", async () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, TEST_ROOM - 5);
    __resetAttachmentAccountingForTests();
    let markLinked!: () => void;
    let finishCommit!: () => void;
    const linked = new Promise<void>((resolve) => { markLinked = resolve; });
    const finishing = new Promise<void>((resolve) => { finishCommit = resolve; });
    vi.mocked(link).mockImplementationOnce(async (...args) => {
      await realLink(...args);
      markLinked();
      await finishing;
    });
    const pending = saveFile((async function* () { yield Buffer.from("xx"); })(), "pending.txt", "text/plain", {
      uploadId: UPLOAD_A, expectedBytes: 2,
    });
    try {
      await linked;
      for (let attempt = 0; attempt < 2; attempt++) {
        vi.mocked(unlinkSync).mockImplementationOnce(() => {
          throw Object.assign(new Error("partial file is locked"), { code: "EPERM" });
        });
      }
      expect(() => writeNewReceiptImage(Buffer.from("x"), "image/png", UPLOAD_B, IMAGE_MAX_BYTES)).toThrow("partial file is locked");
      // This scan sees the linked file while its commit callback is pending.
      expect(() => saveImage(Buffer.from("y"), "image/png")).toThrow(NO_ROOM);
    } finally {
      finishCommit();
      await pending;
    }
    await saveImageUpload(Buffer.from("x"), "image/png", UPLOAD_B);
    expect(() => saveImage(Buffer.from("yy"), "image/png")).not.toThrow();
    expect(() => saveImage(Buffer.from("z"), "image/png")).toThrow(NO_ROOM);
  });

  it("initializes correctly on a fresh process against a directory that already has files", () => {
    // No saveImage/saveFile call has happened yet in this test, so the cache
    // is still cold (__resetAttachmentAccountingForTests in the previous
    // test's afterEach already guaranteed that) — this mirrors a process
    // restart that finds attachments already on disk from a prior run.
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const preexisting = join(ATTACHMENTS_DIR, "11111111-1111-4111-8111-111111111111.png");
    writeFileSync(preexisting, "x");
    truncateSync(preexisting, TEST_ROOM - 2);

    expect(() => saveImage(Buffer.from("yyy"), "image/png")).toThrow(NO_ROOM);
    expect(() => saveImage(Buffer.from("y"), "image/png")).not.toThrow();
  });

  it("does not rescan the directory for each MiB of an unknown-length upload", async () => {
    cleanupStaleAttachmentPartials();
    vi.mocked(readdirSync).mockClear();
    const saved = await saveFile((async function* () { for (let i = 0; i < 25; i++) yield Buffer.alloc(1024 * 1024, i); })(), "large.txt", "text/plain");
    expect(saved.bytes).toBe(FILE_MAX_BYTES);
    expect(readdirSync).not.toHaveBeenCalled();
    deleteAttachment(saved.path);
    expect(existsSync(saved.path)).toBe(false);
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it("counts a stale partial whose cleanup is denied rather than freeing phantom quota", () => {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const orphan = join(ATTACHMENTS_DIR, `.murage-upload-${UPLOAD_A}-${UPLOAD_B}.partial`);
    writeFileSync(orphan, "x"); truncateSync(orphan, TEST_ROOM);
    const old = new Date(Date.now() - ATTACHMENT_PARTIAL_MAX_AGE_MS - 1000); utimesSync(orphan, old, old);
    vi.mocked(unlinkSync).mockImplementation(() => { throw Object.assign(new Error("locked"), { code: "EPERM" }); });
    expect(() => saveImage(Buffer.from("x"), "image/png")).toThrow(NO_ROOM);
    expect(existsSync(orphan)).toBe(true);
  });

  it("does not delete a path outside the attachment store", () => {
    const outside = join(DATA_ROOT, "keep.txt"); writeFileSync(outside, "keep");
    deleteAttachment(outside); expect(readFileSync(outside, "utf8")).toBe("keep");
  });
});

describe("readAttachment name lock", () => {
  beforeEach(() => {
    resetDir();
  });
  afterEach(() => {
    resetDir();
  });

  it("refuses traversal, dotfiles, and names the saver never writes", async () => {
    for (const name of ["..%2F..%2Fconfig.json", ".env", "a/b.png", "no-extension", "uuid.jpeg" /* saved as .jpg */]) {
      expect(await readAttachment(name)).toEqual({ ok: false, reason: "missing" });
    }
  });
});

describe("shared files", () => {
  beforeEach(() => {
    resetDir();
  });
  afterEach(() => {
    resetDir();
  });

  it("allows useful document mimes but not executables, archives, or active markup", () => {
    expect(extensionForFileMime("text/plain; charset=utf-8")).toBe(".txt");
    expect(extensionForFileMime("application/pdf")).toBe(".pdf");
    expect(extensionForFileMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(".docx");
    expect(extensionForFileMime("application/zip")).toBeNull();
    expect(extensionForFileMime("application/x-msdownload")).toBeNull();
    expect(extensionForFileMime("application/octet-stream")).toBeNull();
    expect(extensionForFileMime("text/html")).toBeNull();
    expect(extensionForFileMime("image/svg+xml")).toBeNull();
  });

  it("sanitizes the display name and derives its extension from the mime", () => {
    expect(sanitizeSharedFileName("  Quarterly: report.exe  ", "application/pdf")).toBe("Quarterly_ report.pdf");
    expect(sanitizeSharedFileName("notes", "text/markdown")).toBe("notes.md");
    expect(() => sanitizeSharedFileName("../../secret.txt", "text/plain")).toThrow(/filename, not a path/);
    expect(() => sanitizeSharedFileName("..\\..\\secret.txt", "text/plain")).toThrow(/filename, not a path/);
    expect(() => sanitizeSharedFileName("..%2F..%2Fsecret.txt", "text/plain")).toThrow(/filename, not a path/);
    expect(() => sanitizeSharedFileName("notes.txt", "application/zip")).toThrow(/supported document/);
  });

  it("streams a file under a generated name with private permissions", async () => {
    async function* chunks() {
      yield Buffer.from("first ");
      yield Buffer.from("second");
    }
    const saved = await saveFile(chunks(), "Meeting notes.md", "Text/Markdown; charset=utf-8");
    expect(saved.name).toBe("Meeting notes.md");
    expect(saved.mime).toBe("text/markdown");
    expect(saved.bytes).toBe(12);
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.path).toMatch(/[0-9a-f-]+\.md$/);
    expect(readFileSync(saved.path, "utf8")).toBe("first second");
    if (process.platform !== "win32") {
      expect(statSync(ATTACHMENTS_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects empty and oversized streams without leaving partial files", async () => {
    await expect(saveFile((async function* () {})(), "empty.txt", "text/plain")).rejects.toThrow(/empty file/);
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([]);

    async function* tooLarge() {
      yield Buffer.from("partial");
      yield Buffer.alloc(FILE_MAX_BYTES);
    }
    await expect(saveFile(tooLarge(), "large.pdf", "application/pdf")).rejects.toMatchObject({ status: 413 });
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([]);
  });

  it("deduplicates concurrent and later file retries by upload ID", async () => {
    const makeChunks = async function* () {
      yield Buffer.from("same ");
      await Promise.resolve();
      yield Buffer.from("document");
    };
    const [first, concurrentRetry] = await Promise.all([
      saveFile(makeChunks(), "Report.pdf", "application/pdf", { uploadId: UPLOAD_A, expectedBytes: 13 }),
      saveFile(makeChunks(), "Report.pdf", "application/pdf", { uploadId: UPLOAD_A, expectedBytes: 13 }),
    ]);
    expect(concurrentRetry.path).toBe(first.path);
    expect(readFileSync(first.path, "utf8")).toBe("same document");
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([`${UPLOAD_A}.pdf`]);

    await expect(saveFile((async function* () {
      yield Buffer.from("other bytes");
    })(), "Report.pdf", "application/pdf", { uploadId: UPLOAD_A }))
      .rejects.toMatchObject({ status: 409 });
    expect(readFileSync(first.path, "utf8")).toBe("same document");
  });

  it("serializes the upload ID namespace across image and document routes", async () => {
    let started!: () => void;
    let finish!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const mayFinish = new Promise<void>((resolve) => { finish = resolve; });
    const document = saveFile((async function* () {
      yield Buffer.from("first");
      started();
      await mayFinish;
      yield Buffer.from("second");
    })(), "race.pdf", "application/pdf", { uploadId: UPLOAD_A, expectedBytes: 11 });

    await didStart;
    const image = saveImageUpload(Buffer.from("image"), "image/png", UPLOAD_A);
    finish();
    await expect(document).resolves.toMatchObject({ bytes: 11 });
    await expect(image).rejects.toMatchObject({ status: 409 });
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([`${UPLOAD_A}.pdf`]);
  });
});

// 0.1.60 audit C4: "attachments storage is full (limit 536870912 bytes)"
// reached the composer. Limits are said in human units and plain words.
describe("attachment limit sentences", () => {
  it("say sizes in human units, never a raw byte count", async () => {
    const { ATTACHMENTS_FULL_MESSAGE, FILE_TOO_LARGE_MESSAGE, IMAGE_TOO_LARGE_MESSAGE, humanBytes } = await import("./attachments.ts");
    // 1.0.3: the limit is the disk, so the refusal names no fixed size.
    expect(ATTACHMENTS_FULL_MESSAGE).toBe(DISK_FULL_MESSAGE);
    expect(FILE_TOO_LARGE_MESSAGE).toContain("25 MB");
    expect(IMAGE_TOO_LARGE_MESSAGE).toContain("10 MB");
    for (const text of [ATTACHMENTS_FULL_MESSAGE, FILE_TOO_LARGE_MESSAGE, IMAGE_TOO_LARGE_MESSAGE]) {
      expect(text).not.toMatch(/\d{5,}|bytes|limit \d|\(/);
      expect(text).toMatch(/^[A-Z].*\.$/);
    }
    expect([humanBytes(1536 * 1024 * 1024), humanBytes(2048), humanBytes(12)]).toEqual(["1.5 GB", "2 KB", "12 bytes"]);
  });
  it("the oversized image refusal is one of them", () => {
    expect(() => saveImage(Buffer.alloc(IMAGE_MAX_BYTES + 1), "image/png")).toThrow("That image is too large. Images can be up to 10 MB.");
  });
});

// 1.0.3 (ATTACHMENT-CAP-DESIGN.md): a 243 KB photo was refused with "Murage
// keeps up to 512 MB" on a computer with plenty of free space. The limit now
// follows the disk and keeps 1 GiB free.
describe("room follows the disk", () => {
  const PLENTY = 200 * 1024 * 1024 * 1024;
  beforeEach(() => {
    resetDir();
  });
  afterEach(() => {
    resetDir();
    __setFreeDiskProbeForTests(undefined);
    __resetOutstandingBytesForTests();
  });

  it("attaches a 243 KB photo while more than 512 MB of attachments already exist", () => {
    __setFreeDiskProbeForTests(() => PLENTY);
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, 600 * 1024 * 1024);
    __resetAttachmentAccountingForTests();

    const photo = saveImage(Buffer.alloc(243 * 1024, 7), "image/jpeg");
    expect(photo.bytes).toBe(243 * 1024);
    expect(statSync(photo.path).size).toBe(243 * 1024);
    expect(attachmentStorageUsage().attachmentBytes).toBe(600 * 1024 * 1024 + 243 * 1024);
  });

  it("refuses with the disk-full words and code when free space is under the floor, holding nothing after", async () => {
    __setFreeDiskProbeForTests(() => DISK_FLOOR_BYTES + 100);
    let refusal: unknown;
    try { saveImage(Buffer.alloc(243 * 1024), "image/png"); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ status: 507, code: "disk-full", message: DISK_FULL_MESSAGE });
    expect(outstandingBytes()).toBe(0);
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([]);

    // A stream that fails part way gives back every byte it held.
    __setFreeDiskProbeForTests(() => PLENTY);
    await expect(saveFile((async function* () {
      yield Buffer.from("first chunk");
      throw new Error("connection dropped");
    })(), "half.txt", "text/plain")).rejects.toThrow("connection dropped");
    expect(outstandingBytes()).toBe(0);
    expect(readdirSync(ATTACHMENTS_DIR).some((name) => name.endsWith(".partial"))).toBe(false);
  });

  it("refuses when the free space cannot be read, never unlimited", async () => {
    __setFreeDiskProbeForTests(() => { throw Object.assign(new Error("statfs failed"), { code: "EIO" }); });
    expect(() => saveImage(Buffer.from("png"), "image/png")).toThrow(DISK_UNKNOWN_MESSAGE);
    try { saveImage(Buffer.from("png"), "image/png"); } catch (error) { expect(error).toMatchObject({ status: 507, code: "disk-unknown" }); }
    await expect(saveFile((async function* () { yield Buffer.from("doc"); })(), "a.txt", "text/plain", { expectedBytes: 3 }))
      .rejects.toMatchObject({ status: 507, code: "disk-unknown" });
    __setFreeDiskProbeForTests(() => Number.NaN);
    expect(() => saveImage(Buffer.from("png"), "image/png")).toThrow(DISK_UNKNOWN_MESSAGE);
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([]);
    expect(outstandingBytes()).toBe(0);
  });

  it("answers a write that runs out of disk (ENOSPC) with the same disk-full refusal", async () => {
    __setFreeDiskProbeForTests(() => PLENTY);
    const noSpace = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    vi.mocked(writeFileSync).mockImplementationOnce(() => { throw noSpace(); });
    expect(() => saveImage(Buffer.from("png"), "image/png")).toThrow(DISK_FULL_MESSAGE);

    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args);
      Object.defineProperty(handle, "write", { value: async () => { throw noSpace(); } });
      return handle;
    });
    await expect(saveFile((async function* () { yield Buffer.from("doc"); })(), "a.txt", "text/plain"))
      .rejects.toMatchObject({ status: 507, code: "disk-full", message: DISK_FULL_MESSAGE });
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([]);
    expect(outstandingBytes()).toBe(0);
  });

  it("answers a full disk while creating the attachments folder with the disk-full refusal", async () => {
    __setFreeDiskProbeForTests(() => PLENTY);
    removeTempDirSync(ATTACHMENTS_DIR);
    const noSpace = () => Object.assign(new Error("ENOSPC: no space left on device, mkdir"), { code: "ENOSPC" });
    vi.mocked(mkdirSync).mockImplementationOnce(() => { throw noSpace(); });
    try { saveImage(Buffer.from("png"), "image/png"); expect.unreachable(); } catch (error) {
      expect(error).toMatchObject({ status: 507, code: "disk-full", message: DISK_FULL_MESSAGE });
    }
    vi.mocked(mkdirSync).mockImplementationOnce(() => { throw noSpace(); });
    await expect(saveFile((async function* () { yield Buffer.from("doc"); })(), "a.txt", "text/plain"))
      .rejects.toMatchObject({ status: 507, code: "disk-full", message: DISK_FULL_MESSAGE });
  });

  it("counts bytes another upload still holds before letting a second one in", async () => {
    __setFreeDiskProbeForTests(() => DISK_FLOOR_BYTES + 5);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = saveFile((async function* () { await gate; yield Buffer.from("four"); })(), "first.txt", "text/plain", { expectedBytes: 4 });
    expect(outstandingBytes()).toBe(4);
    expect(() => saveImage(Buffer.from("xx"), "image/png")).toThrow(DISK_FULL_MESSAGE);
    release();
    await expect(first).resolves.toMatchObject({ bytes: 4 });
    expect(outstandingBytes()).toBe(0);
  });

  it("start-up sweep clears a fresh leftover partial but never a live upload", async () => {
    __setFreeDiskProbeForTests(() => PLENTY);
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const leftover = join(ATTACHMENTS_DIR, `.murage-upload-${UPLOAD_A}-${UPLOAD_B}.partial`);
    writeFileSync(leftover, "left by a crash a minute ago");

    let started!: () => void;
    let release!: () => void;
    const streaming = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const live = saveFile((async function* () {
      yield Buffer.from("first ");
      started();
      await gate;
      yield Buffer.from("second");
    })(), "live.txt", "text/plain", { uploadId: UPLOAD_B });
    await streaming;
    const livePartial = readdirSync(ATTACHMENTS_DIR).find((name) => name.startsWith(`.murage-upload-${UPLOAD_B}-`));
    expect(livePartial).toBeTruthy();

    // An ordinary sweep keeps a partial younger than the hour.
    expect(cleanupStaleAttachmentPartials()).toBe(0);
    expect(existsSync(leftover)).toBe(true);
    // The start-up sweep removes it at any age, and leaves the live one alone.
    expect(cleanupStaleAttachmentPartials(Date.now(), { startup: true })).toBe(1);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(join(ATTACHMENTS_DIR, livePartial!))).toBe(true);

    release();
    const saved = await live;
    expect(readFileSync(saved.path, "utf8")).toBe("first second");
  });
});
