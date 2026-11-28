// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Transport fixture: no content policy, but the same real, non-forgeable
// transaction context as production. It cannot manufacture a split admission.
import { DatabaseSync } from "node:sqlite";
import type { LearningGate, LearningPurpose } from "../memory/learning-send.ts";
import { releaseTransaction, type ReleaseContext } from "../memory/release-transaction.ts";
export interface OpenLearningGate extends LearningGate { readonly sent: number }
export function openLearningGate(purpose: LearningPurpose = "extraction"): OpenLearningGate {
  let released = 0;
  return {
    purpose,
    // never refuses, so there is no refusal cause (learning-send.ts LearningGate.cause, 1.0.22 mem-strict)
    cause: undefined,
    get released() { return released; },
    get sent() { return released; },
    refused: false,
    check() { /* content is always current in this transport fixture */ },
    send<R>(emit: () => R, validate?: (context: ReleaseContext) => void): R {
      const db = new DatabaseSync(":memory:");
      try { return releaseTransaction(db, { validate, onRelease: () => { released++; }, emit: () => ({ value: emit() }) }).value; }
      finally { db.close(); }
    },
  };
}
