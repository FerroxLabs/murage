// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-H: Remove an attachment, with a marker (designs/SL-H.md). GATE
// tests of section 6, each named for the failure it prevents:
//  - Remove writes the marker before the unlink; a real unlink failure leaves
//    the marker and the file, answers "pending" and invalidates accounting;
//  - a marker that cannot be written deletes nothing;
//  - two Removes of one name are both fine;
//  - an upload retry with the same uploadId after Remove answers 409 and
//    recreates nothing (images and documents, the last step before link);
//  - the scan unlinks a file that has a marker (a crash between marker and
//    unlink) and leaves files without one;
//  - a bot's picture and any name that is not a stored attachment's are
//    refused, the second before any filesystem call.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, unlinkSync: vi.fn(fs.unlinkSync) };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
afterEach(() => {
  vi.mocked(unlinkSync).mockReset().mockImplementation(actualFs.unlinkSync);
});

const DATA_ROOT = mkdtempSync(join(tmpdir(), "murage-attachment-remove-"));
process.env.MURAGE_DATA_DIR = join(DATA_ROOT, "data");
afterAll(() => removeTempDirSync(DATA_ROOT));

const {
  ATTACHMENTS_HOME, REMOVED_UPLOAD_MESSAGE, __resetAttachmentAccountingForTests, attachmentStorageUsage, cleanupStaleAttachmentPartials,
  deleteAttachment, removeAttachment, saveFile, saveImage, saveImageUpload,
} = await import("./attachments.ts");
const { REMOVED_FOLDER, attachmentRemoved, storedPathOf } = await import("./attachment-read.ts");
const { PICTURE_IN_USE_MESSAGE, removeAttachments } = await import("./attachment-remove.ts");
const DIR = dirname(storedPathOf(ATTACHMENTS_HOME, "x.png"));
const MARKERS = join(DIR, REMOVED_FOLDER);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
const ID = "33333333-3333-4333-8333-333333333333";
const posixOnly = it.skipIf(process.platform === "win32");
const nameOf = (path: string) => path.split(/[\\/]/).pop()!;

beforeEach(() => {
  try { chmodSync(DIR, 0o700); } catch { /* not made yet */ }
  removeTempDirSync(DIR);
  __resetAttachmentAccountingForTests();
});

describe("Remove (H1): the marker, then the file", () => {
  it("writes the marker before it unlinks the file, and the file is gone after", () => {
    const saved = saveImage(png, "image/png");
    const name = nameOf(saved.path);
    let markerAtUnlink: boolean | undefined;
    vi.mocked(unlinkSync).mockImplementation((path) => {
      if (String(path) === saved.path) markerAtUnlink = existsSync(join(MARKERS, name));
      return actualFs.unlinkSync(path);
    });
    expect(removeAttachment(name)).toEqual({ state: "removed" });
    expect(markerAtUnlink).toBe(true);
    expect(existsSync(saved.path)).toBe(false);
    expect(statSync(join(MARKERS, name)).size).toBe(0);
    expect(attachmentRemoved(ATTACHMENTS_HOME, name)).toBe(true);
  });

  posixOnly("a real unlink failure leaves the marker and the file, answers pending and invalidates accounting; the next scan finishes it", () => {
    const saved = saveImage(png, "image/png");
    const name = nameOf(saved.path);
    mkdirSync(MARKERS, { recursive: true, mode: 0o700 });
    // warm accounting, so only an invalidation makes the next use rescan
    expect(attachmentStorageUsage().attachmentBytes).toBe(png.length);
    chmodSync(DIR, 0o500); // the folder refuses the unlink; the marker folder does not
    let result: ReturnType<typeof removeAttachment>;
    try { result = removeAttachment(name); } finally { chmodSync(DIR, 0o700); }
    expect(result).toMatchObject({ state: "pending", code: "EACCES" });
    expect(existsSync(join(MARKERS, name))).toBe(true);
    expect(existsSync(saved.path)).toBe(true);
    // invalidated: this use rescans, and the scan (H3) finishes the removal
    expect(attachmentStorageUsage().attachmentBytes).toBe(0);
    expect(existsSync(saved.path)).toBe(false);
  });

  it("deleteAttachment says when an unlink failed instead of swallowing it; a file already gone is fine", () => {
    const saved = saveImage(png, "image/png");
    vi.mocked(unlinkSync).mockImplementationOnce(() => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
    expect(deleteAttachment(saved.path)).toEqual({ ok: false, code: "EBUSY" });
    expect(existsSync(saved.path)).toBe(true);
    expect(deleteAttachment(saved.path)).toEqual({ ok: true });
    expect(deleteAttachment(saved.path)).toEqual({ ok: true });
  });

  it("a marker that cannot be written deletes nothing", () => {
    const saved = saveImage(png, "image/png");
    writeFileSync(MARKERS, "not a folder");
    expect(removeAttachment(nameOf(saved.path))).toMatchObject({ state: "failed" });
    expect(existsSync(saved.path)).toBe(true);
  });

  it("two Removes of one name are both fine", () => {
    const saved = saveImage(png, "image/png");
    expect(removeAttachment(nameOf(saved.path))).toEqual({ state: "removed" });
    expect(removeAttachment(nameOf(saved.path))).toEqual({ state: "removed" });
    expect(existsSync(saved.path)).toBe(false);
  });
});

describe("a removed name is terminal (H5, at link)", () => {
  it("an image upload retry with the same uploadId after Remove answers 409 and recreates nothing", async () => {
    const saved = await saveImageUpload(png, "image/png", ID);
    expect(removeAttachment(nameOf(saved.path)).state).toBe("removed");
    await expect(saveImageUpload(png, "image/png", ID)).rejects.toMatchObject({ status: 409, message: REMOVED_UPLOAD_MESSAGE });
    expect(existsSync(saved.path)).toBe(false);
    expect(readdirSync(DIR).filter(name => name !== REMOVED_FOLDER)).toEqual([]);
  });

  it("a document upload retry with the same uploadId after Remove answers 409 and recreates nothing", async () => {
    const chunks = async function* () { yield Buffer.from("notes"); };
    const saved = await saveFile(chunks(), "notes.txt", "text/plain", { uploadId: ID });
    expect(removeAttachment(nameOf(saved.path)).state).toBe("removed");
    await expect(saveFile(chunks(), "notes.txt", "text/plain", { uploadId: ID })).rejects.toMatchObject({ status: 409, message: REMOVED_UPLOAD_MESSAGE });
    expect(existsSync(saved.path)).toBe(false);
    expect(readdirSync(DIR).filter(name => name !== REMOVED_FOLDER)).toEqual([]);
  });

  it("other names still upload", async () => {
    const saved = await saveImageUpload(png, "image/png", ID);
    removeAttachment(nameOf(saved.path));
    await expect(saveImageUpload(png, "image/png", "44444444-4444-4444-8444-444444444444")).resolves.toMatchObject({ bytes: png.length });
  });
});

describe("the scan finishes a removal (H3)", () => {
  it("unlinks a file that has a marker (a crash between marker and unlink) and leaves files without one", () => {
    const kept = saveImage(png, "image/png");
    const gone = saveImage(Buffer.concat([png, Buffer.from([1])]), "image/png");
    mkdirSync(MARKERS, { recursive: true });
    writeFileSync(join(MARKERS, nameOf(gone.path)), "");
    __resetAttachmentAccountingForTests(); // a cold start
    expect(attachmentStorageUsage().attachmentBytes).toBe(png.length);
    expect(existsSync(gone.path)).toBe(false);
    expect(existsSync(kept.path)).toBe(true);
    // the marker stays: the name is still refused
    expect(attachmentRemoved(ATTACHMENTS_HOME, nameOf(gone.path))).toBe(true);
    // the start-up sweep does the same
    const again = saveImage(Buffer.concat([png, Buffer.from([2])]), "image/png");
    writeFileSync(join(MARKERS, nameOf(again.path)), "");
    cleanupStaleAttachmentPartials(Date.now(), { startup: true });
    expect(existsSync(again.path)).toBe(false);
    expect(existsSync(kept.path)).toBe(true);
  });

  it("the marker folder is never counted as attachment bytes", () => {
    const saved = saveImage(png, "image/png");
    removeAttachment(nameOf(saved.path));
    __resetAttachmentAccountingForTests();
    expect(attachmentStorageUsage().attachmentBytes).toBe(0);
  });
});

describe("the Remove request (H1, H4)", () => {
  const NAME = `${ID}.png`;
  it("refuses a `..` or non-managed name before any filesystem call", () => {
    const remove = vi.fn(() => ({ state: "removed" as const }));
    const bots = vi.fn(() => []);
    for (const names of [["../config.json"], [".removed"], ["x.png"], [NAME, "..%2fconfig.json"], ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.png"], []]) {
      expect(removeAttachments({ names }, { bots, remove }).status).toBe(400);
    }
    expect(removeAttachments({ names: [NAME], extra: true }, { bots, remove }).status).toBe(400);
    expect(removeAttachments(null, { bots, remove }).status).toBe(400);
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses a bot's picture with the sentence and removes nothing of it", () => {
    const remove = vi.fn(() => ({ state: "removed" as const }));
    const answer = removeAttachments({ names: [NAME] }, { bots: () => [{ avatarUrl: `/api/attachments/${NAME}` }], remove });
    expect(answer).toEqual({ status: 409, body: { results: [{ name: NAME, state: "refused", error: PICTURE_IN_USE_MESSAGE }] } });
    expect(remove).not.toHaveBeenCalled();
  });

  it("answers 200 with each name's state, and 500 when a marker could not be written", () => {
    const other = "55555555-5555-4555-8555-555555555555.pdf";
    const states = new Map<string, ReturnType<typeof removeAttachment>>([[NAME, { state: "pending", code: "EBUSY" }], [other, { state: "removed" }]]);
    expect(removeAttachments({ names: [NAME, other] }, { bots: () => [], remove: name => states.get(name)! })).toEqual({
      status: 200, body: { results: [{ name: NAME, state: "pending" }, { name: other, state: "removed" }] },
    });
    const failed = removeAttachments({ names: [NAME] }, { bots: () => [], remove: () => ({ state: "failed", code: "EACCES" }) });
    expect(failed.status).toBe(500);
  });

  it("removes for real through attachments.ts", () => {
    const saved = saveImage(png, "image/png");
    const answer = removeAttachments({ names: [nameOf(saved.path)] }, { bots: () => [], remove: removeAttachment });
    expect(answer.status).toBe(200);
    expect(existsSync(saved.path)).toBe(false);
  });
});
