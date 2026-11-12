import type { ApprovalJournal, ApprovalOutcome } from "./approval-idempotency.ts";

const live = new Map<string, { digest: string; work: Promise<ApprovalOutcome> }>();

/** Register immediately after approval identity is known, before any await in
 * authorization or dispatch preparation. All live and recovered host paths for
 * that approval must enter here. The callback owns journal claim/settlement;
 * each caller must independently check authority before releasing its result.
 *
 * This outer lifetime is distinct from runApprovedWrite's claim/settle lifetime:
 * it covers the still-absent journal window. The owner may call runApprovedWrite
 * inside invoke, but must never nest this helper for the same approval (it would
 * await itself). There is no timeout/eviction: only completion or failure drops
 * ownership. After process loss the durable journal decides read-only recovery. */
export async function runApprovedInvocation(journal: ApprovalJournal, approvalId: string, requestDigest: string, invoke: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
  const key = JSON.stringify([journal.key, approvalId]);
  const running = live.get(key);
  if (running) {
    if (running.digest !== requestDigest) return { status: "conflict", reason: "approval_binding" };
    return structuredClone(await running.work);
  }
  // Publish synchronously, before invoke can suspend in authorization. A new
  // journal object for the same storage must still join this exact invocation.
  const work = Promise.resolve().then(invoke);
  live.set(key, { digest: requestDigest, work });
  try { return structuredClone(await work); }
  finally { if (live.get(key)?.work === work) live.delete(key); }
}
