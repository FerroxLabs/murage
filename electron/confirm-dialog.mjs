// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A yes-or-no question anchored to the Murage window (`dialog:confirm`).
// Adapted from OpenMausBot #1840 (Apache-2.0): window.confirm() has no parent
// window, so tiling window managers on Linux place it at the screen origin
// instead of over the app, where it is easy to miss. Electron pieces are
// injected so node tests drive the same checks the app runs.
import { isOwnedMainSender } from "./main-trust.mjs";

const MAX_MESSAGE = 4096;
const MAX_LABEL = 40;

/**
 * Resolves true only when the person picks the action button. Cancel is the
 * default and the Escape answer. Any other window, a subframe, a bad message
 * or a closed window answers false without showing anything.
 */
export function createConfirmDialogHandler({ window, origin, showMessageBox }) {
  return async (event, message, confirmLabel) => {
    const parent = window();
    if (!isOwnedMainSender(event, { window: parent, origin: origin() })) return false;
    if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) return false;
    const label = typeof confirmLabel === "string" && confirmLabel.trim() && confirmLabel.length <= MAX_LABEL ? confirmLabel.trim() : "OK";
    const { response } = await showMessageBox(parent, {
      type: "warning",
      message,
      buttons: ["Cancel", label],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  };
}
