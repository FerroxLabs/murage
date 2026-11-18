// SPDX-License-Identifier: AGPL-3.0-or-later
// The one shape of a pasted Google authorization code (AGY-ON-CLOUD design 13, Grok Medium 2). The relay's browser keyboard and the chat
// ingress guard both read this, so they cannot disagree: a whole line made only of these characters, 20 to 512 of them.
export const SIGNIN_CODE_SHAPE = /^[A-Za-z0-9._~/+#%-]{20,512}$/;
/** True when the whole trimmed text is code-shaped. No scan inside longer text: a hash, an id or a key in a sentence is not a code. */
export const looksLikeSignInCode = (text) => typeof text === "string" && SIGNIN_CODE_SHAPE.test(text.trim());
