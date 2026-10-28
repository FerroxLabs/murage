// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot email after a restore (BOT-EMAIL-MURAGE-109 section 7, F23). Runs inside the restore preparation's transaction on the restored
// database. Every live binding lands in `restored_unverified`: no polling, no tools, no sends until the owner's "Reconnect email" re-obtains
// the owner credential, lists #4, matches bot_id and mints a new email key. A removal in flight stays a removal (the reaper finishes it after
// Reconnect). Event cursors are dropped (the restored install re-lists after Reconnect); send receipts stay so open rows reconcile against
// #19 and #20, and a held row whose payload was not carried shows "This email was waiting before the restore" with Don't send only.
import type { DatabaseSync } from "node:sqlite";

/** Returns how many bindings now wait for Reconnect. A database without the email tables (email never on) is not touched. */
export function prepareRestoredEmail(db: DatabaseSync): number {
  const has = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (!has("email_bindings")) return 0;
  const moved = Number(db.prepare("UPDATE email_bindings SET state='restored_unverified', revision=revision+1 WHERE state NOT IN ('removing','remove_requested','restored_unverified')").run().changes);
  // the long-poll cursor belonged to the old install's session; install-id and ever-enabled stay
  if (has("email_event_cursor")) db.prepare("DELETE FROM email_event_cursor WHERE scope NOT IN ('install-id','ever-enabled')").run();
  return moved;
}
