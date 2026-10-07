// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-only seams for guarded-http.mjs (review L2). Production code must never
// import this file. It is how a test serves plain http for an https URL or
// proves that the socket-address check catches a lookup that lies; neither is
// reachable from the public options.
import { SEAMS } from "./guarded-http.mjs";

/**
 * @param {object} options  the options for guardedRequest
 * @param {{ transportFor?: (scheme: "http" | "https") => typeof import("node:http"), tamperAddress?: (address: string) => string }} seams
 */
export function withSeams(options, seams) {
  return { ...options, [SEAMS]: seams };
}
