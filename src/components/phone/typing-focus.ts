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

type FocusDoc = Pick<Document, "addEventListener" | "removeEventListener"> & { activeElement: unknown };

/** Calls onChange(typing) on every focus move; returns the unsubscribe. */
export function watchTyping(doc: FocusDoc, onChange: (typing: boolean) => void): () => void {
  // focusout fires before the next element takes focus, so read activeElement a tick later.
  const check = () => onChange(isTypingTarget(doc.activeElement as Focusable));
  const later = () => { setTimeout(check, 0); };
  doc.addEventListener("focusin", check);
  doc.addEventListener("focusout", later);
  check();
  return () => {
    doc.removeEventListener("focusin", check);
    doc.removeEventListener("focusout", later);
  };
}

export function useTypingFocus(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => (typeof document === "undefined" ? undefined : watchTyping(document, setTyping)), []);
  return typing;
}
