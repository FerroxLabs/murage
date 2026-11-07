// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 ERRORS-NAME relay 4. Flux names why it refused in a code, but not always in the same place. Recorded on flux-router
// origin/master:
//   rate_limiter.py  429 {"error":{"type":"rate_limit_exceeded","state":"free_cap_reached","message":"Your account's monthly
//                    free-tier token allowance is exhausted. ..."}}: the code is in `state`, never in the sentence, and LiteLLM
//                    flattens the dict into error.message as a Python repr ('state': 'free_cap_reached').
//   forge_hook.py    402 credit_exhausted (metering on): the body is a plain sentence plus "Top up at ..."; the code rides only the
//                    X-Flux-Hold-Reason header. Metering off: {"error":"credit_exhausted","message":...}.
//   flux_credit_state.py  402 credit_unresolved; 429 hold with X-Flux-Hold-Reason and "Retry in Ns." in the message.
// The engine relays some of this as sanitised prose (embedded JSON removed), so the code is read here from the raw error, its
// RPC data and Fuigo's retry notice, and travels on the runtime.error as its own field.

export type FluxRefusalCode = "free_cap_reached" | "credit_exhausted" | "credit_unresolved" | "hold";
export const FLUX_REFUSAL_CODES: ReadonlySet<string> = new Set<FluxRefusalCode>(["free_cap_reached", "credit_exhausted", "credit_unresolved", "hold"]);

const TEXT_MAX = 16_384;
const MAX_STRINGS = 64;
const HOLD_TEXT = /because other requests have temporarily reserved it/i;
const HOLD_HEADER = /^x-flux-hold-reason$/i;

/** Every string in a value, depth 4 at most and a bounded count, with the key each one sat under. */
function strings(value: unknown, out: Array<[string, string]>, key = "", depth = 0): void {
  if (out.length >= MAX_STRINGS || depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") { out.push([key, value.slice(0, TEXT_MAX)]); return; }
  if (value instanceof Error) { strings(value.message, out, "message", depth + 1); strings((value as { data?: unknown }).data, out, "data", depth + 1); return; }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value.slice(0, 16)) strings(item, out, key, depth + 1); return; }
  for (const name of Object.keys(value).slice(0, 32)) strings((value as Record<string, unknown>)[name], out, name, depth + 1);
}

/** The Flux refusal code anywhere in these sources, or undefined. A spent free allowance wins over a credit code, and a credit
 * code wins over a hold, so the strongest "sending again will not help" reading is the one kept. */
export function fluxRefusalCode(...sources: unknown[]): FluxRefusalCode | undefined {
  const found: Array<[string, string]> = [];
  for (const source of sources) strings(source, found);
  let credit: FluxRefusalCode | undefined;
  let hold = false;
  for (const [key, text] of found) {
    // A code this module already read and carried structurally (ProviderHttpError.data.flux_code) reads back as itself: a
    // header-only hold stores the bare word "hold", which the text patterns below do not match.
    if (key === "flux_code" && text === "hold") { hold = true; continue; }
    if (/\bfree_cap_reached\b/i.test(text)) return "free_cap_reached";
    if (/\bcredit_exhausted\b/i.test(text)) credit = "credit_exhausted";
    else if (!credit && /\bcredit_unresolved\b/i.test(text)) credit = "credit_unresolved";
    if (HOLD_HEADER.test(key) || /x-flux-hold-reason/i.test(text) || HOLD_TEXT.test(text)) hold = true;
  }
  return credit ?? (hold ? "hold" : undefined);
}

/** A code the engine may resend once (a hold names a real wait); the others never get a second send. */
export function fluxRefusalFinal(code: FluxRefusalCode | undefined): boolean {
  return code === "free_cap_reached" || code === "credit_exhausted" || code === "credit_unresolved";
}
