// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The help panel's words. The panel's own lines are main-pack keys
// (src/locales/en-ux/l4a.json, prefix ux.l4a.*), answered by t(); the words
// for each screen are Help keys (src/locales/en-help/*.json), answered from
// the active language's Help pack by the help copy store
// (src/lib/help-copy-store.ts). This module is help chunk only: the
// always-loaded part (HelpHost.tsx, the Workspace pane's "?", Keyboard
// shortcuts) uses t() and never imports it (src/first-paint.test.ts).
import { hx } from "@/lib/help-copy-store";

export { hx };

/** The modifier key as an owner reads it in a sentence ("Cmd K", "Ctrl K"),
 *  in the app's language (de "Strg K"): main-pack keys, never fixed English. */
export function modWord(mac: boolean): string {
  return hx(mac ? "ux.l4a.mod.mac" : "ux.l4a.mod.other");
}
