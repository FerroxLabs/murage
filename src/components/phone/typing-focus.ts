// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// On Android the keyboard shrinks the WebView, so a fixed bottom bar rides up
// and sits on top of the keyboard. The phone tabs hide while the person is
// typing in a text box (Needs you replies, the Chats search) and come back
// when focus leaves it.
import { useEffect, useState } from "react";

const NOT_TYPED = new Set(["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image", "hidden"]);

type Focusable = { tagName?: string; type?: string; isContentEditable?: boolean; readOnly?: boolean } | null | undefined;

/** True when focus is on something the on-screen keyboard opens for. */
export function isTypingTarget(el: Focusable): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return !el.readOnly;
  if (tag === "INPUT") return !el.readOnly && !NOT_TYPED.has((el.type ?? "text").toLowerCase());
  return false;
}

type Listens = Pick<Document, "addEventListener" | "removeEventListener">;
type FocusDoc = Listens & { activeElement: unknown; visibilityState?: string };

/** A press that no event ever ends stops holding the bar back after this long. */
export const PRESS_HOLD_MAX_MS = 1500;

/**
 * Calls onChange(typing) on every focus move; returns the unsubscribe.
 * `win` is the window, for blur and focus; tests may leave it out.
 */
export function watchTyping(doc: FocusDoc, onChange: (typing: boolean) => void, win?: Listens): () => void {
  // focusout fires before the next element takes focus, so read activeElement a tick later.
  // A tap that leaves a text box (a pager button under the search box) must not
  // bring the bar back while the finger is still down: the page would move by
  // the bar's height between press and release and the tap would miss. The
  // bar returns once the pointer is up and its click has landed.
  // The hold fails open: anything that can end a press without a pointerup
  // (the window losing focus, the page going hidden, lost pointer capture, a
  // key press) ends it too, and no press holds the bar back past
  // PRESS_HOLD_MAX_MS. The tabs never stay hidden while no text box has focus.
  let pressed = false;
  let cap: ReturnType<typeof setTimeout> | undefined;
  const clearCap = () => { if (cap !== undefined) { clearTimeout(cap); cap = undefined; } };
  const check = () => {
    const typing = isTypingTarget(doc.activeElement as Focusable);
    if (!typing && pressed) return;
    onChange(typing);
  };
  const later = () => { setTimeout(check, 0); };
  const release = () => { clearCap(); pressed = false; later(); };
  const press = () => { pressed = true; clearCap(); cap = setTimeout(release, PRESS_HOLD_MAX_MS); };
  const releaseIfHidden = () => { if (doc.visibilityState === "hidden") release(); else later(); };
  const ends: [Listens, string, () => void, boolean][] = [
    [doc, "focusin", check, false],
    [doc, "focusout", later, false],
    [doc, "pointerdown", press, true],
    [doc, "pointerup", release, true],
    [doc, "pointercancel", release, true],
    [doc, "lostpointercapture", release, true],
    [doc, "keydown", release, true],
    [doc, "visibilitychange", releaseIfHidden, false],
  ];
  if (win) ends.push([win, "blur", release, false], [win, "focus", later, false]);
  for (const [target, type, fn, capture] of ends) target.addEventListener(type, fn, capture);
  check();
  return () => {
    clearCap();
    for (const [target, type, fn, capture] of ends) target.removeEventListener(type, fn, capture);
  };
}

export function useTypingFocus(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => (typeof document === "undefined" ? undefined : watchTyping(document, setTyping, window)), []);
  return typing;
}
