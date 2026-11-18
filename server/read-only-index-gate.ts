// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md row A5): a read-only start builds no index. The turn index is required before the server
// listens, so a read-only start that finds it missing cannot serve; it must stop BEFORE anything else in the start writes (the lease, the roots, the
// stores, the upgrade note). The look is one read-only connection on the existing file, taken right after the start mode is decided.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TURN_INDEX, TurnIndexNotReadyError } from "./message-tables.ts";
import { isReadOnly } from "./read-only-start.ts";

export function assertRequiredIndexesForReadOnlyStart(dataDir: string): void {
  if (!isReadOnly()) return;
  const file = join(dataDir, "messages.db");
  if (!existsSync(file)) return; // a first start has no file to look at: the open path decides
  // A file this look cannot read ends the start here, with the look's own error: going on would let the lease, the roots and the stores write first.
  let present = false;
  const db = new DatabaseSync(file, { readOnly: true });
  try { present = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(TURN_INDEX)); } finally { db.close(); }
  if (present) return;
  console.error("[startup] read-only start: required index missing");
  throw new TurnIndexNotReadyError();
}
