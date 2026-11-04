// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Snooze with Undo (UX L2B) on the local-only Undo host (src/lib/undo.ts): the
// host's undo never sends a request, so the snooze is held here and written
// only when the 8-second window ends without Undo. Undo inside the window puts
// the row back with no request at all. If the window was hidden early (Esc)
// and the window has ended, a later Undo still puts the row back on screen
// and `onUndo(true)` lets the caller send the one write that returns it.
import { UNDO_WINDOW_MS, type UndoHost } from "@/lib/undo";

export function offerSnoozeUndo(host: UndoHost, opts: {
  id: string;
  message: string;
  /** put the row back; `committed` = the snooze was already written */
  onUndo: (committed: boolean) => void;
  /** write the snooze */
  commit: () => void;
  /** this snooze's own Undo window (default the host's 8 s) */
  windowMs?: number;
}): void {
  let undone = false, committed = false, windowDone = false;
  const handle = host.offerUndo({
    kind: "local",
    key: `needs-snooze:${opts.id}`,
    message: opts.message,
    undo: () => { if (undone) return; undone = true; stop(); opts.onUndo(committed); },
  });
  const settle = () => {
    if (undone || committed) return;
    // Each snooze keeps its own window: a newer toast taking this one's place does not end it early.
    if (!windowDone) return;
    const view = host.view();
    if (view && view.id === handle.id) return;
    // Esc or X only hides the toast: the offer keeps its window, so the write still waits for it.
    // (Hidden with an offer open means this one, or a newer one that ended this; waiting longer is the only risk.)
    if (!view && host.hasOpen()) return;
    committed = true;
    unsubscribe();
    opts.commit();
  };
  // The host keeps the undo function with the offer, so a late Undo is still heard after this stops listening.
  const unsubscribe = host.subscribe(settle);
  const timer = setTimeout(() => { windowDone = true; settle(); }, opts.windowMs ?? UNDO_WINDOW_MS);
  function stop() { clearTimeout(timer); unsubscribe(); }
}
