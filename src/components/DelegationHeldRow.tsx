// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A hand-off that was not sent, or that Murage's restart cut off after the provider may have taken it. It does not run again by itself, because that could do
// the work twice. The line says so and offers Send again (queued as a new hand-off) and Dismiss. The server removes the control once the owner chose. A choice
// that does not go through puts both buttons back and says so, so the owner can try again.
import { useState } from "react";
import { RotateCcw, X } from "lucide-react";
import type { Action } from "../state/store";

/** Sends the owner's choice and resolves when the server accepted it; rejects when it did not. */
export function heldAction(dispatch: (action: Action) => void, type: "resendDelegation" | "dismissDelegation", delegationId: string, threadId?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => dispatch({ type, delegationId, ...(threadId ? { threadId } : {}), settled: { resolve, reject } }));
}

/** What the owner reads when a choice did not go through. */
export const HELD_ACTION_FAILED = "That did not go through. Try again.";

/** Runs one choice: both buttons are off while it is out, and come back whatever the outcome (a refusal also says so). */
export async function performHeldAction(action: () => Promise<void>, ui: { setBusy(busy: boolean): void; setFailed(failed: boolean): void }): Promise<void> {
  ui.setBusy(true);
  ui.setFailed(false);
  try { await action(); }
  catch { ui.setFailed(true); }
  finally { ui.setBusy(false); }
}

const button = "inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-hairline/70 bg-control px-3 py-1 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-50";
/** The row as it is drawn for a state: `busy` while a choice is out, `failed` after one was refused. */
export function DelegationHeldView({ text, busy, failed, onSendAgain, onDismiss }: { text: string; busy: boolean; failed: boolean; onSendAgain: () => void; onDismiss: () => void }) {
  return (
    <div className="flex justify-start">
      <div role="status" data-testid="delegation-held" className="flex max-w-[42rem] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-hairline/50 bg-card px-3 py-2 text-[13px] text-ink-secondary">
        <span className="min-w-0 flex-1">{text}</span>
        <button type="button" disabled={busy} onClick={onSendAgain} className={button}>
          <RotateCcw size={12} aria-hidden="true" />Send again
        </button>
        <button type="button" disabled={busy} onClick={onDismiss} className={button}>
          <X size={12} aria-hidden="true" />Dismiss
        </button>
        {failed && <span role="alert" className="basis-full text-[12px] text-danger">{HELD_ACTION_FAILED}</span>}
      </div>
    </div>
  );
}

export function DelegationHeldRow({ text, onSendAgain, onDismiss }: { text: string; onSendAgain: () => Promise<void>; onDismiss: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ui = { setBusy, setFailed };
  return <DelegationHeldView text={text} busy={busy} failed={failed} onSendAgain={() => { void performHeldAction(onSendAgain, ui); }} onDismiss={() => { void performHeldAction(onDismiss, ui); }} />;
}
