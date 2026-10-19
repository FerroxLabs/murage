// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings > Storage, as plain lines. Pure so it is tested without a renderer.
// The answer GET /api/storage gives (server/storage-report.ts).

export interface StorageReport {
  freeBytes: number | null;
  floorBytes: number;
  attachments: { bytes: number; inProgressBytes: number };
  files: { bytes: number };
}

/** A byte count as a person reads it: 1.5 GB, 243 KB, 12 bytes. */
export function readableBytes(bytes: number): string {
  const units = [["GB", 1024 ** 3], ["MB", 1024 ** 2], ["KB", 1024]] as const;
  for (const [unit, size] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${unit}`;
    }
  }
  return `${bytes} bytes`;
}

export interface StorageSummary {
  free: string;
  attachments: string;
  files: string;
  /** What to do next, in one sentence. */
  next: string;
  /** The disk is at or under the space Murage leaves free, or unreadable. */
  low: boolean;
}

export function storageSummary(report: StorageReport): StorageSummary {
  const unreadable = report.freeBytes === null;
  const low = unreadable || report.freeBytes! <= report.floorBytes;
  const next = unreadable
    ? "Murage could not read the free space on this disk, so it is not saving new attachments for now. Try again in a moment."
    : low
      ? `This computer is almost out of space. Murage always leaves ${readableBytes(report.floorBytes)} of space unused, so new attachments wait until there is more room. Empty the Trash or remove large files you no longer need, then try again.`
      : `There is room. Murage saves attachments until only ${readableBytes(report.floorBytes)} of space is left on this disk.`;
  return {
    free: unreadable ? "Unknown" : readableBytes(report.freeBytes!),
    attachments: readableBytes(report.attachments.bytes + report.attachments.inProgressBytes),
    files: readableBytes(report.files.bytes),
    next,
    low,
  };
}
