// SPDX-License-Identifier: AGPL-3.0-or-later
// The customer-facing cancellation reference ("CX-" and eight characters), one generator for the public cancel form
// (public-cancellation.ts) and the signed-in cancel plan (legal-routes.ts), so a customer quotes the same kind of reference on both.
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const newRef = (): string => `CX-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => REF_ALPHABET[x % REF_ALPHABET.length]).join("")}`;
export const isCancelRef = (v: unknown): v is string => typeof v === "string" && /^CX-[A-HJ-NP-Z2-9]{8}$/.test(v);

/** How many fresh references are tried before giving up (each try is one INSERT; a collision in 32^8 is already rare). */
export const CANCEL_REF_TRIES = 8;
/** The ONE allocator of cancellation references, shared by the public form (cancellation_requests) and the signed-in cancel (plan_cancellations):
 *  a reference is reserved in cancel_references (its primary key is the reference) before either table uses it, so the same "CX-" number can
 *  never name two cancellations, whichever table each is in. A collision is retried with a fresh reference; `owner` only says who took it.
 *  Throws only if every try collided or the table cannot be written: callers never let that block a cancellation. */
export async function allocateCancelRef(env: Env, owner: string, now: number, generate: () => string = newRef): Promise<string> {
  for (let i = 0; i < CANCEL_REF_TRIES; i++) {
    const ref = generate();
    const r = await env.DB.prepare("INSERT OR IGNORE INTO cancel_references (reference,owner,created_at) VALUES (?,?,?)").bind(ref, owner, now).run();
    if (r.meta.changes === 1) return ref;
  }
  throw new Error("cancel_reference_exhausted");
}
