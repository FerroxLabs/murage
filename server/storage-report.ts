// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/storage (desktop only, the route-policy default): what the Storage
// page in Settings shows. The free space on the disk, the part Murage leaves
// untouched, and what Murage itself keeps as attachments and Files copies.
// Reporting only: nothing here decides whether an upload fits (disk-space.ts).
import { join } from "node:path";
import { artifactStorageBytes } from "./artifacts.ts";
import { attachmentStorageUsage, attachmentsFreeBytes } from "./attachments.ts";
import { DISK_FLOOR_BYTES, freeDiskBytes } from "./disk-space.ts";

export interface StorageReport {
  /** Free bytes on the disk that holds Murage's data, or null when the disk
   * cannot be read (uploads are refused then too). */
  freeBytes: number | null;
  /** Free space new attachments and Files copies always leave on the disk. */
  floorBytes: number;
  attachments: { bytes: number; inProgressBytes: number };
  files: { bytes: number };
}

export function storageReport(dataDir: string): StorageReport {
  let attachments = { bytes: 0, inProgressBytes: 0 };
  try {
    const usage = attachmentStorageUsage();
    attachments = { bytes: usage.attachmentBytes, inProgressBytes: usage.reservedBytes };
  } catch { /* an unreadable folder reports as empty; uploads still refuse on their own check */ }
  return {
    freeBytes: attachmentsFreeBytes() ?? freeDiskBytes(dataDir),
    floorBytes: DISK_FLOOR_BYTES,
    attachments,
    files: { bytes: artifactStorageBytes(join(dataDir, "artifact-files")) },
  };
}
