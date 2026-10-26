// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed stop (designs/TYPED-STOP-107.md): the owner's plain "stop", typed in a direct chat while the bot works on that
// conversation, stops the work the way the Stop button does. Only the word itself counts ("stop", any case, optionally
// followed by "." or "!"): "stop using tabs", a quoted "stop" or any longer line stays an ordinary message.
const TYPED_STOP = /^stop[.!]*$/i;

/** True when the whole message is a plain "stop". */
export function isTypedStop(text: string): boolean {
  return TYPED_STOP.test(text.trim());
}

