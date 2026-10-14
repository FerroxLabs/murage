// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FTS5 stops accepting writes ("database or disk is full", SQLITE_FULL) once one index holds 2,000 segments.
export const FTS_SEGMENT_LIMIT = 2000;
export function isSegmentLimitError(error: unknown): boolean {
  return error instanceof Error && ((error as {errcode?: number}).errcode === 13 || /database or disk is full/i.test(error.message));
}
