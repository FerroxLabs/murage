// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The IME check below follows the approach in OpenMausBot (Apache-2.0), see NOTICE.

/** True while an input method (Japanese, Chinese, Korean) is mid-conversion.
 *  WebKit fires the confirming keydown after composition has ended, with
 *  isComposing already false and keyCode 229, so both signals count. Every
 *  key handler in the composer (send, @mention menu, slash menu) asks this
 *  first, so confirming a candidate never picks a menu row or sends. */
export function imeComposing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === 229;
}

import type { SendKey } from "./send-key";

/** Whether this Enter sends the message.
 *
 * Mouse and keyboard: by default Enter sends and Shift+Enter is a newline;
 * `mode` can move sending to Shift+Enter or Ctrl/Cmd+Enter (item 190).
 * Touch: Return is a newline and the arrow button sends — a phone keyboard
 * has no Shift+Return, so without this there is no way to write two lines.
 * ⌘/Ctrl+Enter still sends on touch, for a tablet with a keyboard attached.
 * Never mid-composition: that Enter commits an IME candidate. */
export function enterSends(
  key: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean; keyCode?: number },
  touch: boolean,
  mode: SendKey = "enter",
): boolean {
  if (key.key !== "Enter" || imeComposing(key)) return false;
  if (touch) return key.metaKey || key.ctrlKey;
  if (mode === "shift-enter") return key.shiftKey && !key.metaKey && !key.ctrlKey;
  if (mode === "mod-enter") return key.metaKey || key.ctrlKey;
  return !key.shiftKey;
}
