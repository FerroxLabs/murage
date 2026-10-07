// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { isClipboardKeyName } from "./browser-clipboard.ts";
describe("L8: dedicated clipboard key names are denied like the shortcuts", () => {
  it("denies Paste, Copy and Cut in any case", () => {
    for (const key of ["Paste", "Copy", "Cut", "paste", "COPY", "cUt", " Paste "]) expect(isClipboardKeyName(key), key).toBe(true);
  });
  it("still denies the shortcuts and allows ordinary keys", () => {
    for (const key of ["Control+v", "Meta+Shift+C", "Shift+Insert"]) expect(isClipboardKeyName(key), key).toBe(true);
    for (const key of ["Enter", "Tab", "a", "Control+z", "Pasted"]) expect(isClipboardKeyName(key), key).toBe(false);
  });
});
