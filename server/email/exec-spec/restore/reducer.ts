// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// REDUCER SKELETON: reduce(state, event) -> { actions, state }. Pure; no I/O, no clock, no randomness (time arrives as event.nowMs).
// Every case is "unimplemented" until the lane fills it. placeholderReduce is NOT the reducer: it lets the harness run end to end
// (boots, keeps state, restores adopt the archive DB, no parking, no sends) so the checker, witnesses and coverage are testable now.

import type { HomeEvent, HomeState, ReduceCtx, ReduceResult, Reducer } from "./model.ts";
import { NOOP_CTX, HOME_EVENT_TYPES } from "./model.ts";

/** Every reducer branch id the lane intends to implement. Coverage reports the ones never taken. Add ids here as cases are filled. */
export const BRANCH_IDS: readonly string[] = [
  "boot.fresh", "boot.after_crash", "bootPrep.ok", "bootPrep.throw",
  "restored.park_pending_removals", "restored.no_outgoing_db", "restored.carry_key_targets",
  "owner.keep", "owner.remove", "owner.deleteBot", "owner.reconnect", "owner.tryAgainNow", "owner.setupEmail", "owner.viewSurface",
  "answer.delete", "answer.restore", "answer.get", "answer.stale_duplicate",
  "applyEvent.closing_owner", "applyEvent.closing_flux", "applyEvent.restored", "applyEvent.deleted",
  "guard.restore_on_event", "guard.restore_on_poll", "guard.release_by_answer", "guard.release_by_event", "guard.release_by_purge",
  "listing.reconcile",
  "placeholder.boot", "placeholder.restored", "placeholder.noop",
];

export function reduce(_state: HomeState, event: HomeEvent, _ctx: ReduceCtx = NOOP_CTX): ReduceResult {
  switch (event.e) {
    case "boot": throw new Error("unimplemented: boot");
    case "bootPrep": throw new Error("unimplemented: bootPrep");
    case "emailOn": throw new Error("unimplemented: emailOn");
    case "settle": throw new Error("unimplemented: settle");
    case "tick": throw new Error("unimplemented: tick");
    case "guardPoll": throw new Error("unimplemented: guardPoll");
    case "applyEvent": throw new Error("unimplemented: applyEvent");
    case "answer": throw new Error("unimplemented: answer");
    case "listing": throw new Error("unimplemented: listing");
    case "owner": throw new Error("unimplemented: owner");
    case "backup": throw new Error("unimplemented: backup");
    case "ownerRestore": throw new Error("unimplemented: ownerRestore");
    case "captureOutgoing": throw new Error("unimplemented: captureOutgoing");
    case "restoreAbort": throw new Error("unimplemented: restoreAbort");
    case "restoreSwap": throw new Error("unimplemented: restoreSwap");
    case "restorePrepare": throw new Error("unimplemented: restorePrepare");
    case "restoreJobClear": throw new Error("unimplemented: restoreJobClear");
    case "restoreArm": throw new Error("unimplemented: restoreArm");
    case "archiveFetch": throw new Error("unimplemented: archiveFetch");
  }
}

export const unimplementedReducer: Reducer = { name: "reduce(unimplemented)", reduce };

export function placeholderReduce(state: HomeState, event: HomeEvent, ctx: ReduceCtx = NOOP_CTX): ReduceResult {
  switch (event.e) {
    case "boot": {
      ctx.hit("placeholder.boot");
      const s: HomeState = { ...state, proc: { ...state.proc, processId: state.proc.processId + 1, phase: "running", emailOn: true } };
      return { actions: [{ k: "durable", write: "W1_desktop_prep_tx", after: s }], state: s };
    }
    case "restoreSwap": {
      ctx.hit("placeholder.restored");
      const s: HomeState = { ...state, local: event.archiveDb ?? state.local };
      return { actions: [{ k: "durable", write: "W4_consumer_tx", after: s }], state: s };
    }
    case "backup":
      return { actions: [{ k: "archive", kind: event.kind, topLevelNames: state.fs.messagesDbPresent ? ["messages.db"] : [], db: state.local }], state };
    case "owner":
      return { actions: [{ k: "ownerResult", ok: true }], state };
    default:
      ctx.hit("placeholder.noop");
      return { actions: [], state };
  }
}
export const placeholderReducer: Reducer = { name: "placeholder", reduce: placeholderReduce, wakeups: () => [] };

export const EVENT_TYPES_FOR_COVERAGE = HOME_EVENT_TYPES;
