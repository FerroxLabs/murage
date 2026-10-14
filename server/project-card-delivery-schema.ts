// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import { ensureChildTable } from "./added-table-lifecycle.ts";

/** A finished card run whose result has not reached the project room yet. The row is written in the same transaction as
 * the run's terminal state and removed only after the delivery went through, so a restart (or a long lock) cannot lose it.
 * `payload` carries what the delivery needs that the request row does not (the review nonce). Created by the database
 * initializer and registered in the installation snapshot's reference schema. */
export function initializeProjectCardDelivery(db: DatabaseSync): void {
  // a child of room_requests: its definition and its cleanup live in added-table-lifecycle.ts
  ensureChildTable(db, "project_card_delivery_owed");
}
