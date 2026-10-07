// The two derived keys in the push contract, and the random values the host
// mints. Derived rather than stored so a retry, a restart and every event on
// a binding agree on them without a lookup.
//
// Keyed with an HMAC over a per-binding secret that only the host holds
// (push_bindings.key_secret): the relay knows the binding id, and bot ids are
// short slugs, so a plain hash of the two could be reversed with a dictionary.
// Phones only compare these values and never compute them.
import { createHmac, randomBytes } from "node:crypto";

const SECRET = /^[0-9a-f]{64}$/;
function keyed(secret: string, text: string): string {
  if (!SECRET.test(secret)) throw new Error("push key secret must be 32 bytes of hex");
  return createHmac("sha256", Buffer.from(secret, "hex")).update(text).digest("hex");
}

/** A fresh per-binding key secret: 32 random bytes, hex. Host only. */
export function newKeySecret(): string {
  return randomBytes(32).toString("hex");
}

/** Stable per request, so APNs and Android replace instead of stacking
 *  (spec §3.5). An event with no request collapses on its own ref. */
export function collapseKey(bindingSecret: string, requestIdOrRef: string): string {
  return keyed(bindingSecret, `murage-collapse\n${requestIdOrRef}`).slice(0, 32);
}

/** APNs thread-id is "binding plus bot"; keyed so the relay never holds a bot id. */
export function threadGroup(bindingSecret: string, botId: string): string {
  return keyed(bindingSecret, `murage-thread\n${botId}`).slice(0, 16);
}

export function newEventRef(): string {
  return randomBytes(32).toString("hex");
}

export function newToken(prefix: "murage_pd_" | "murage_pr_"): string {
  return prefix + randomBytes(32).toString("base64url");
}
