// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two things the send fence is handed (the server database and the bounded marker drain), held in a module that imports nothing.
// dispatch.ts and memory-revocation.ts set them when they load; send-fence.ts reads them at send time. They live here, not in send-fence.ts,
// because send-fence.ts now imports modules that reach memory-revocation.ts: a module that loads first through that path would otherwise
// set its hand-in before send-fence.ts had initialised the holder.
import type { DatabaseSync } from "node:sqlite";

export const sendFenceDeps: { classify?: import("./settle-target.ts").SettleClassifier | null; db: (() => DatabaseSync) | null; drain: ((db: DatabaseSync) => void) | null } = { db: null, drain: null };

/** dispatch.ts hands in the server database, memory-revocation.ts its bounded marker drain. */
export function setSendFenceDeps(deps: { classify?: import("./settle-target.ts").SettleClassifier | null; db?: (() => DatabaseSync) | null; drain?: ((db: DatabaseSync) => void) | null }): void {
  if (deps.classify !== undefined) sendFenceDeps.classify = deps.classify;
  if (deps.db !== undefined) sendFenceDeps.db = deps.db;
  if (deps.drain !== undefined) sendFenceDeps.drain = deps.drain;
}
