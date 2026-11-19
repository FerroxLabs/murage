// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FakeFlux with the fixed provider semantics used by the fault model. Pure functions over a FluxState
// the caller has already cloned. FIXED facts (not switches):
//   - DELETE has no freshness check. active -> closing for 30 days (closingSinceMs; until = closingSince + 30 d). A repeat DELETE on a
//     closing inbox is idempotent (no change, no new event). A DELETE carries reason "owner" or "bot_deleted" only.
//   - POST restore authenticates with the OWNER key only; a revoked bot key does not block it (a bot_key credential is refused, 401-like).
//     Refusals: 409 not_closing (inbox active), 410 restore_window_passed (now > closing_until, before the purge ran),
//     403 account_email_disabled. Restore of a Flux-initiated closing (billing/support/account_disabled) is allowed unless the account
//     email is disabled (the account_disabled closing sets that flag).
//   - A closing inbox accepts mail at the provider but drops it at intake, invisible through Flux (intake()).
//   - Events: email.inbox.closing {reason, until}, email.inbox.restored, email.inbox.deleted (purge). Closing reasons:
//     owner | bot_deleted | account_disabled | billing | support. Flux-initiated = the last three.
// The ONE switch: FluxConfig.listing, off by default (no listing exists until F-BACKFILL); "per_account" lists every inbox and key on
// the account INCLUDING other homes' (foreign) entries.
// FluxEvent.reason in the revised invariants file is DeleteReason | FluxCloseReason | null = the FluxMain strings below (aligned, no cast).

import type { EventId, FluxEvent, FluxInbox, FluxInboxState, FluxKey, FluxState, InboxId, RemoteRequest } from "./invariants.current.ts";
import { FLUX_PURGE_MS } from "./invariants.current.ts";
import type { FluxConfig, RequestResult } from "./model.ts";

export type FluxEventReason = NonNullable<FluxEvent["reason"]>; // owner | bot_deleted | account_disabled | billing | support
export const FLUX_INITIATED_REASONS: readonly FluxEventReason[] = ["account_disabled", "billing", "support"];
export const DELETE_REASONS: readonly FluxEventReason[] = ["owner", "bot_deleted"];

export interface FluxCtx { nowMs: number; step: number; cfg: FluxConfig; newEventId(): EventId; botHint: string | null; deleteReason: "owner" | "bot_deleted"; accountEmailDisabled: boolean }

export const closingUntil = (ib: FluxInbox): number | null => (ib.closingSinceMs === null ? null : ib.closingSinceMs + FLUX_PURGE_MS);

function emit(f: FluxState, c: FluxCtx, type: FluxEvent["type"], inboxId: InboxId, reason: FluxEventReason | null): void {
  f.events.push({ eventId: c.newEventId(), type, inboxId, atMs: c.nowMs, deliveredToHome: false, atStep: c.step, reason });
}

const res = (answer: RequestResult["answer"], code: string | null, seen: FluxInboxState | null): RequestResult => ({ answer, code, fluxStateSeen: seen });

/** Apply one request at Flux, at any time (arbitrarily late). Mutates f. */
export function applyRequest(f: FluxState, req: RemoteRequest, c: FluxCtx): RequestResult {
  // MAIN RULING: /fixture/jobs/_small/RULING-RESTORE-S1.md.
  // Apply is atomic in this model: held copies join whichever copy commits first.
  // Every copy remains schedulable (including after a completed GET), and replays the same result.
  if (req.kind === "RESTORE_INBOX") {
    const id = req.copyOf ?? req.requestId, stored = f.restoreOutcomes?.[id];
    if (stored) return res(stored.answer, stored.code, stored.fluxStateSeen);
    const result = executeRequest(f, req, c);
    (f.restoreOutcomes ??= {})[id] = { requestId: req.requestId, target: req.target, committedAtStep: c.step, ...result };
    return result;
  }
  return executeRequest(f, req, c);
}

function executeRequest(f: FluxState, req: RemoteRequest, c: FluxCtx): RequestResult {
  switch (req.kind) {
    case "DELETE_INBOX": {
      const ib = f.inboxes[req.target];
      if (!ib || ib.state === "purged") return res("not_found", "not_found", ib ? "purged" : null);
      if (ib.state === "active") {
        ib.state = "closing"; ib.closingCause = { kind: "delete", requestId: req.requestId, reason: c.deleteReason }; ib.closingSinceMs = c.nowMs; ib.closingSinceStep = c.step;
        emit(f, c, "email.inbox.closing", ib.inboxId, c.deleteReason);
        return res("ok", null, "closing");
      }
      return res("ok", "already_closing", "closing"); // idempotent, no freshness check, no event
    }
    case "REVOKE_KEY": {
      const k = f.keys[req.target];
      if (!k) return res("not_found", "not_found", null);
      k.state = "revoked";
      return res("ok", null, null);
    }
    case "RESTORE_INBOX": {
      const ib = f.inboxes[req.target];
      if (req.credential !== "owner") return res("refused", "owner_key_required", ib ? ib.state : null);
      if (!ib || ib.state === "purged") return res("not_found", "not_found", ib ? "purged" : null);
      if (c.accountEmailDisabled) return res("refused", "403_account_email_disabled", ib.state);
      if (ib.state === "active") return res("refused", "409_not_closing", "active");
      const until = closingUntil(ib);
      if (until !== null && c.nowMs > until) return res("refused", "410_restore_window_passed", "closing");
      ib.state = "active"; ib.closingCause = null; ib.closingSinceMs = null; ib.closingSinceStep = null;
      emit(f, c, "email.inbox.restored", ib.inboxId, null);
      return res("ok", null, "active");
    }
    case "GET_INBOX": {
      const ib = f.inboxes[req.target];
      return ib ? res("ok", null, ib.state) : res("not_found", "not_found", null);
    }
    case "CREATE_INBOX": {
      const id = "inb:" + req.target; // idempotent per provisioning op
      if (!f.inboxes[id]) f.inboxes[id] = { inboxId: id, installOwned: true, createdUnderOp: req.target, forBot: c.botHint, address: "addr:" + id, state: "active", closingCause: null, closingSinceMs: null, closingSinceStep: null };
      return res("ok", null, "active");
    }
    case "LIST_ACCOUNT": return res("ok", null, null); // the listing itself is delivered by the net.listing move (FluxConfig.listing)
    case "MINT_KEY": {
      const id = "key:" + req.target;
      if (!f.keys[id]) f.keys[id] = { keyId: id, installOwned: true, mintedUnderOp: req.target, forBot: c.botHint ?? "?", state: "live" };
      return res("ok", null, null);
    }
  }
}

/** Flux-initiated closing (billing / support / account_disabled), a separate cause from DELETE. */
export function fluxClose(f: FluxState, inboxId: InboxId, reason: Exclude<FluxEventReason, "owner" | "bot_deleted">, c: FluxCtx): boolean {
  const ib = f.inboxes[inboxId];
  if (!ib || ib.state !== "active") return false;
  ib.state = "closing"; ib.closingCause = { kind: "flux", reason }; ib.closingSinceMs = c.nowMs; ib.closingSinceStep = c.step;
  emit(f, c, "email.inbox.closing", inboxId, reason);
  return true;
}

export const canPurge = (ib: FluxInbox, nowMs: number): boolean => ib.state === "closing" && ib.closingSinceMs !== null && nowMs - ib.closingSinceMs >= FLUX_PURGE_MS;

export function purge(f: FluxState, inboxId: InboxId, c: FluxCtx): boolean {
  const ib = f.inboxes[inboxId];
  if (!ib || !canPurge(ib, c.nowMs)) return false;
  ib.state = "purged";
  emit(f, c, "email.inbox.deleted", inboxId, null);
  return true;
}

/** Inbound mail at the provider: accepted while active, dropped at intake (invisible through Flux) while closing. */
export const intake = (ib: FluxInbox): "accepted" | "dropped" | "bounced" => (ib.state === "active" ? "accepted" : ib.state === "closing" ? "dropped" : "bounced");

/** The per-account listing (F-BACKFILL): every inbox including closing, every key, INCLUDING other homes' entries. */
export function listing(f: FluxState): { inboxes: FluxInbox[]; keys: FluxKey[] } {
  return { inboxes: Object.values(f.inboxes).filter(i => i.state !== "purged"), keys: Object.values(f.keys) };
}
