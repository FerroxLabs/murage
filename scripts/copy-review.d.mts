// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
type LedgerEntry = { review: string; sha256: string };
export declare function ledgerFromRecords(input?: { dir?: string }): {
  version: 1;
  strings: Record<string, LedgerEntry>;
  files: Record<string, LedgerEntry>;
};
