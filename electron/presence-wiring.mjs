// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// NOTIFY-EVERYWHERE-1019 S3R R6: events request complete reads; only committed
// presence changes release held notifications. All Electron objects are injected.

export function wirePresence({ lock, presenceGuard, attentionMain, powerMonitor }) {
  // Invoke immediately, including noteEvent's revision bump, while containing a
  // rejected async consumer so an OS event cannot become an unhandled rejection.
  const invoke = fn => { try { Promise.resolve(fn()).catch(() => {}); } catch { /* keep event delivery running */ } };
  const note = () => invoke(() => presenceGuard.noteEvent());
  const reconcile = () => invoke(() => attentionMain.reconcile());
  const offLock = lock.onChange(locked => {
    note();
    if (!locked) reconcile();
  });
  const offGuard = presenceGuard.onChange(() => invoke(() => attentionMain.quietChanged()));
  const handlers = new Map();
  for (const event of ["lock-screen", "unlock-screen", "suspend", "resume"]) {
    const handler = () => { note(); if (event === "resume") reconcile(); };
    handlers.set(event, handler);
    powerMonitor.on(event, handler);
  }
  let stopped = false;
  return function off() {
    if (stopped) return;
    stopped = true;
    offLock();
    offGuard();
    for (const [event, handler] of handlers) powerMonitor.removeListener(event, handler);
  };
}
