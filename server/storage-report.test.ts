// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/storage's answer (1.0.3): free disk space, the floor Murage keeps,
// and what attachments and Files hold.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const DATA_ROOT = mkdtempSync(join(tmpdir(), "murage-storage-report-"));
process.env.MURAGE_DATA_DIR = join(DATA_ROOT, "data");
const { storageReport } = await import("./storage-report.ts");
const { saveImage, __resetAttachmentAccountingForTests } = await import("./attachments.ts");
const { DISK_FLOOR_BYTES, __setFreeDiskProbeForTests } = await import("./disk-space.ts");

afterEach(() => { __setFreeDiskProbeForTests(undefined); __resetAttachmentAccountingForTests(); });

it("answers free bytes, the floor and what Murage keeps", () => {
  __setFreeDiskProbeForTests(() => 50 * 1024 ** 3);
  saveImage(Buffer.alloc(2048, 1), "image/png");
  mkdirSync(join(DATA_ROOT, "data", "artifact-files"), { recursive: true });
  writeFileSync(join(DATA_ROOT, "data", "artifact-files", "b".repeat(64) + ".txt"), "x".repeat(300));
  expect(storageReport(join(DATA_ROOT, "data"))).toEqual({
    freeBytes: 50 * 1024 ** 3,
    floorBytes: DISK_FLOOR_BYTES,
    attachments: { bytes: 2048, inProgressBytes: 0 },
    files: { bytes: 300 },
  });
});

it("says the free space is unknown when the disk cannot be read", () => {
  __setFreeDiskProbeForTests(() => { throw new Error("statfs failed"); });
  expect(storageReport(join(DATA_ROOT, "data")).freeBytes).toBeNull();
});
