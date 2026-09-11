import { timingSafeEqual } from "node:crypto";

/** Desktop-held uncertain fence for the generic model-provider bank (B4, U-14).
 *
 * The desktop main process sends this over Electron's private utility parent
 * port when a replace acknowledgement is lost and its compensation cannot be
 * confirmed, and releases it only after a revision readback confirms the live
 * bank. While held, the harness refuses new dispatch. The revision-bound
 * replace and the readback stay available so reconciliation can finish. In
 * memory only: a restarted harness loads the encrypted document the desktop
 * already holds, so it starts consistent. */
let uncertain = false;

export const PROVIDER_BANK_FENCE_ERROR =
  "Model connections are being reconciled after a failed save. Try again shortly, or restart Murage.";

export function applyProviderBankFenceMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  if (record.type !== "murage:provider-bank-fence" || typeof record.held !== "boolean") return false;
  if (Object.keys(record).some((key) => key !== "type" && key !== "held")) return false;
  uncertain = record.held;
  return true;
}

export function providerBankDispatchFenced(): boolean {
  return uncertain;
}

/** Exact bearer match for the per-launch token only the desktop main process holds. */
export function modelProviderCommitAuthorized(authorization: unknown, expected: string): boolean {
  if (typeof authorization !== "string" || !expected) return false;
  const supplied = /^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1] ?? "";
  return supplied.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}
