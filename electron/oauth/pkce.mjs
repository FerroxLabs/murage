// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PKCE (RFC 7636, S256 only) and the CSRF state, shared by plan sign-in
// (model-signin-oauth.mjs) and MCP server sign-in (mcp-signin/flow.mjs).
// Nothing here performs I/O except randomBytes and createHash.
import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 4.1: 43 to 128 characters. base64url of 32..96 bytes lands there,
 * and base64url only uses unreserved characters. */
export function createVerifier(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 32) throw new RangeError("A PKCE verifier needs at least 43 characters (32 bytes)");
  if (bytes > 96) throw new RangeError("A PKCE verifier has at most 128 characters (96 bytes)");
  return randomBytes(bytes).toString("base64url");
}

export function s256Challenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** An unguessable `state` for one authorization request. */
export function createState(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

/** A verifier, its S256 challenge and a state. */
export function createPkce({ verifierBytes = 32, stateBytes = 32 } = {}) {
  const verifier = createVerifier(verifierBytes);
  return { verifier, challenge: s256Challenge(verifier), state: createState(stateBytes), method: "S256" };
}
