// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Bytes of a sealed cursor's plaintext (cursor.ts): 6 bytes of expiry, then the helper's cursor, padded. */
export const CURSOR_PLAINTEXT_BYTES = 192;
/** The longest cursor token, in characters: 12 bytes of nonce, the plaintext and a 16 byte tag, as base64url. The memory tool and
 * route accept exactly this much for `cursor`. */
export const MEMORY_CURSOR_MAX_CHARS = Math.ceil((12 + CURSOR_PLAINTEXT_BYTES + 16) * 4 / 3);
