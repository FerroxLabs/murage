// SPDX-License-Identifier: AGPL-3.0-or-later
import type { writeSync } from "node:fs";

/** Inject a short physical write at the counted writer, retaining its actual
 * admission and accounting. The pristine native methods bypass node:fs mocks. */
export function writeJournalPrefix(write: typeof writeSync, args: unknown[], limit: number): number {
  const [fd, data, offset, length, position] = args;
  if (typeof data === "string") {
    const bytes = Buffer.from(data);
    return write(fd as number, bytes, 0, Math.min(limit, bytes.length), typeof offset === "number" ? offset : null);
  }
  const bytes = data as Uint8Array;
  const start = typeof offset === "number" ? offset : 0;
  return write(fd as number, bytes, start, Math.min(limit, typeof length === "number" ? length : bytes.byteLength - start), position as number | null ?? null);
}
