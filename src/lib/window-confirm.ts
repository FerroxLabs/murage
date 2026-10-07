// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Yes-or-no questions that sit over the Murage window. Adapted from
// OpenMausBot #1840 (Apache-2.0): window.confirm() has no parent window, so
// tiling window managers on Linux place it at the screen origin instead.

type ConfirmHost = {
  muragebox?: { confirm?(message: string, confirmLabel?: string): Promise<boolean> };
  confirm?(message: string): boolean;
};

/** True only when the person picks the action button. The desktop app asks
 * through the main process, anchored to its window; a plain browser falls
 * back to its own confirm. */
export async function confirmInWindow(message: string, confirmLabel?: string, host: ConfirmHost = globalThis as ConfirmHost): Promise<boolean> {
  const bridge = host.muragebox?.confirm;
  if (bridge) return bridge(message, confirmLabel);
  return host.confirm?.(message) ?? false;
}

/** Runs one action at a time. A second click while the first action, or the
 * question before it, is still open is ignored and resolves undefined. */
export function oneAtATime() {
  let busy = false;
  return async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return undefined;
    busy = true;
    try {
      return await action();
    } finally {
      busy = false;
    }
  };
}
