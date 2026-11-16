// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Electron has ONE activation callback. Local/Cloud Open-only notifiers and
// actionable banners must share it; registering per controller loses routes.
const controllers = new WeakMap();

export function subscribeWindowsActivation(Notification, listener) {
  let listeners = controllers.get(Notification);
  if (!listeners) {
    listeners = new Set();
    controllers.set(Notification, listeners);
    try {
      Notification.handleActivation(details => {
        for (const receive of [...listeners]) {
          try { receive(details); } catch { /* One retired controller cannot break another. */ }
        }
      });
    } catch (error) { controllers.delete(Notification); throw error; }
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}
