// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LineageVerdict } from "./memory/lineage-types.ts";
import { SEND_NOTICE_ENGLISH, type NativeTurnNoticeCode } from "../shared/send-notice.ts";
import { afterCommit, inTxScope, onRollback } from "./tx-scope.ts";

export const LEDGER_REFUSAL_LINE = "I stopped this turn because some of its context is no longer available.";
const refusalReasons = new Set(["own-flag", "tombstone", "thread-deny", "deny-line", "deny-range", "watermark", "footprint",
  "deny-session", "session-forgotten", "deny-memory", "scope-deny", "murage-anchor", "door-epoch", "pack-ineligible",
  "no-lineage", "thread-not-ready", "pending", "footprint-wide", "lookup-error", "not-built", "retained-over", "retained-budget"]);
/** Fixed vocabulary only: never put retained words or caller-supplied reasons in logs. */
export function ledgerRefusalCause(verdict: LineageVerdict): string {
  return verdict && (verdict.state === "checking" || verdict.state === "withheld") && refusalReasons.has(verdict.reason)
    ? `${verdict.state}:${verdict.reason}` : "invalid-verdict";
}
export interface ConsumingIdentity {
  readonly botId: string;
  readonly threadId: string;
  readonly dispatchGeneration: string;
  readonly lineageTurnIds: readonly string[];
  readonly adapterLeaseId: string;
}
export interface LedgerRefusalPorts {
  /** These functions close over the admitted generation, never a mutable current-turn lookup. */
  seal(): void;
  interrupt(): Promise<boolean>;
  settle(reason: "memory-refused", verdict: LineageVerdict): void;
  present(line: string, notice?: NativeTurnNoticeCode): void;
  quarantine(): void;
  confirmed?(): void;
}
export function createLedgerRefusal(identity: ConsumingIdentity, ports: LedgerRefusalPorts) {
  const binding = Object.freeze({ ...identity, lineageTurnIds: Object.freeze([...identity.lineageTurnIds]) });
  let state: "open" | "refusing" | "settled" = "open";
  let first: LineageVerdict | undefined;
  let quarantined = false;
  const quarantine = () => {
    if (quarantined) return;
    quarantined = true;
    try { ports.quarantine(); } catch { /* local latch remains sealed even if cleanup fails */ }
  };
  const settle = () => {
    if (state !== "refusing") return;
    state = "settled";
    // A refusal can originate inside the emitter's writer transaction.
    // Its rollback must discard attribution, not the terminal source/notice.
    // Seal and latch above remain synchronous; persist after every enclosing
    // transaction ends, on either outcome, without letting a second event win.
    let persisted = false;
    const persist = () => {
      if (persisted) return;
      if (inTxScope()) { afterCommit(persist); onRollback(persist); return; }
      persisted = true;
      try { ports.settle("memory-refused", first!); } catch { quarantine(); }
      try { ports.present(LEDGER_REFUSAL_LINE); } catch { quarantine(); }
    };
    persist();
  };
  return Object.freeze({
    identity: binding,
    get state() { return state; },
    get verdict() { return first; },
    get quarantined() { return quarantined; },
    /** Provider completion shares the same terminal latch. A completion that
     * races a refusal cannot change its classification or present twice. */
    completed(): void { if (state === "open") state = "settled"; else settle(); },
    onLedgerRefused(verdict: LineageVerdict): void {
      if (state !== "open") return;
      first = Object.freeze({ ...verdict });
      state = "refusing";
      console.warn(`[memory] ledger refusal cause=${ledgerRefusalCause(first)}`);
      // Sealing and settlement precede every continuation, including synchronous interrupt failures.
      try { ports.seal(); } catch { quarantine(); }
      try {
        const stopping = ports.interrupt();
        const timer = setTimeout(() => { quarantine(); settle(); }, 5000);
        timer.unref?.();
        void stopping.then(confirmed => {
          if (confirmed !== true) quarantine();
          else { try { ports.confirmed?.(); } catch { quarantine(); } }
        }, quarantine)
          .finally(() => { clearTimeout(timer); settle(); });
      } catch { quarantine(); }
      settle();
    },
  });
}

/** Provider hand-back fills one slot; it never changes the admitted lease.
 * Refusal before hand-back still interrupts that exact id when it arrives. */
export function createLedgerLease(identity: ConsumingIdentity, ports: Omit<LedgerRefusalPorts, "interrupt"> & {
  interrupt(providerTurnId: string): Promise<boolean>;
}) {
  let providerTurnId: string | undefined;
  let notLaunched = false;
  let admissionNotice: NativeTurnNoticeCode | undefined;
  let confirmTeardown!: () => void;
  const teardownConfirmed = new Promise<void>(resolve => { confirmTeardown = resolve; });
  let handedBack!: (id: string | undefined) => void;
  const ready = new Promise<string | undefined>(resolve => { handedBack = resolve; });
  const lifecycle = createLedgerRefusal(identity, { ...ports, interrupt: async () => {
    const id = await ready;
    return id === undefined ? notLaunched : ports.interrupt(id);
  },
    present(line) { ports.present(admissionNotice ? SEND_NOTICE_ENGLISH[admissionNotice] : line, admissionNotice); },
    confirmed() { ports.confirmed?.(); confirmTeardown(); },
  });
  return Object.freeze({
    ...lifecycle,
    get state() { return lifecycle.state; },
    get verdict() { return lifecycle.verdict; },
    get quarantined() { return lifecycle.quarantined; },
    get providerTurnId() { return providerTurnId; },
    teardownConfirmed,
    admissionNotLaunched(notice?: NativeTurnNoticeCode): void {
      if (providerTurnId !== undefined) throw new Error("ADMISSION_ALREADY_LAUNCHED");
      if (lifecycle.state === "open") admissionNotice ??= notice;
      notLaunched = true;
      handedBack(undefined);
    },
    attach(id: string): void {
      if (notLaunched || !id || providerTurnId !== undefined && providerTurnId !== id) {
        lifecycle.onLedgerRefused({ state: "checking", reason: "not-built" });
        throw new Error("MEMORY_CONTEXT_REVOKED");
      }
      if (providerTurnId === undefined) { providerTurnId = id; handedBack(id); }
    },
  });
}
