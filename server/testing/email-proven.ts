// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test support (EMAIL-ACCOUNT-CHANGE r6 4b): a binding with an inbox only sends and takes owner acts once an owner record proves it
// (`inbox-owner:<bot>`, written by the setup or adoption commit or a passing #5 read). Tests that put a live row straight into the store
// write the record a real setup would have written, for the owner credential the test signed in.
import type { BindingRow, EmailStore } from "../email/email-store.ts";

export function proveInbox(store: Pick<EmailStore, "setCursor">, botId: string, inboxId: string, ownerRef = "key_owner", now = 0): void {
  store.setCursor(`inbox-owner:${botId}`, JSON.stringify({ ownerRef, inboxId, at: now }), now);
}

/** store.insertBinding plus the owner record for a row that has an inbox. */
export function provenInsert(store: Pick<EmailStore, "setCursor" | "insertBinding">, row: Parameters<EmailStore["insertBinding"]>[0], ownerRef = "key_owner"): ReturnType<EmailStore["insertBinding"]> {
  const inserted = store.insertBinding(row);
  if (row.inboxId) proveInbox(store, row.botId, row.inboxId, ownerRef, row.updatedAt ?? 0);
  return inserted;
}
export type { BindingRow };
