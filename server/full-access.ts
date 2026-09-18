// Full access: the approval level above Auto.
//
// Auto keeps a bot working but still stops at anything that looks
// destructive or sensitive. Full access stops at nothing the owner started:
// no approval card for commands, credential or personal-file reads, the
// host-control guard, or bot-to-bot contact. What still asks, because it is
// not the owner's own input or not a permission at all, is decided where each
// card is raised — `autoVerdict` for tool permissions, the peer-contact gate
// for ask/delegate — and the desktop's warning (src/components/FullAccessWarning.tsx)
// says so.
//
// This module owns only how the level is switched on. It is the desktop app's
// decision alone: a paired phone, a script or a bot calling the loopback API,
// and a webhook payload can never turn it on, and the first time for each bot
// the request must carry proof that the owner confirmed the warning.

export const FULL_ACCESS_ACK_REQUIRED =
  "Full access requires confirming the warning first (acknowledgeFullAccess)";

export type FullAccessChange =
  | { ok: true; autoApprove?: boolean; fullAccess?: boolean; acknowledgedAt?: number }
  | { ok: false; status: number; error: string };

/** What a settings PATCH does to the approval level.
 *
 * - `fullAccess: true` switches Full access on (and Auto with it). Only a
 *   request proven to come from the desktop app may do that; anything else
 *   gets the same 404 the other desktop-only settings give. The first time
 *   for a bot it also needs `acknowledgeFullAccess: true`, which only the
 *   desktop's warning dialog sends; the confirmation is then remembered on
 *   the bot and never asked again.
 * - `fullAccess: false` drops back to Auto (or to Ask, with
 *   `autoApprove: false`).
 * - Any `autoApprove` change that does not ask for Full access ends it, so a
 *   stale flag can never come back to life the next time Auto is switched on.
 */
export function fullAccessChange(
  body: Record<string, unknown>,
  bot: { fullAccessAcknowledgedAt?: number } | null | undefined,
  desktop: boolean,
  now: number = Date.now(),
): FullAccessChange {
  if (body.fullAccess !== undefined && typeof body.fullAccess !== "boolean") {
    return { ok: false, status: 400, error: "fullAccess must be true or false" };
  }
  if (body.acknowledgeFullAccess !== undefined && typeof body.acknowledgeFullAccess !== "boolean") {
    return { ok: false, status: 400, error: "acknowledgeFullAccess must be true or false" };
  }
  if (body.fullAccess === true) {
    if (!desktop) return { ok: false, status: 404, error: "not found" };
    if (body.autoApprove === false) return { ok: false, status: 400, error: "Full access needs Auto mode on" };
    const acknowledged = typeof bot?.fullAccessAcknowledgedAt === "number";
    if (!acknowledged && body.acknowledgeFullAccess !== true) {
      return { ok: false, status: 400, error: FULL_ACCESS_ACK_REQUIRED };
    }
    return { ok: true, autoApprove: true, fullAccess: true, ...(acknowledged ? {} : { acknowledgedAt: now }) };
  }
  if (body.fullAccess === false || body.autoApprove !== undefined) return { ok: true, fullAccess: false };
  return { ok: true };
}
