// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The capability to start a hand-off, as a runtime fact. server/handoff-dispatch.ts claims the minter when it loads (once: a second claim throws, so no other
// module, computed key or forwarded callback can ever obtain one), and a ticket is "live" only while the minter says so. `isLiveTicket` is what the host's
// startTurn asks of any hand-off run it is handed; a value that merely looks like a ticket is not one. A leaf module: it imports nothing.
const live = new WeakSet<object>();
const tokens = new WeakSet<object>();
let claimed = false;

/** Proof that a request is being dispatched as a hand-off's request, by the hand-off dispatch. Only the dispatcher's minter makes one. */
export interface HandoffDispatchToken { readonly kind: "handoff-dispatch" }

export interface HandoffMinter {
  /** a ticket the dispatcher made becomes startable */
  admit(ticket: object): void;
  /** a ticket cleared on a dispatch error can no longer start anything */
  revoke(ticket: object): void;
  /** the token that lets a hand-off's own request be marked running (room-requests.ts markRequestDispatched) */
  dispatchToken(): HandoffDispatchToken;
}

/** Claimed once, by the dispatcher, at load. Throws after. */
export function claimMinter(): HandoffMinter {
  if (claimed) throw new Error("HANDOFF_MINTER_CLAIMED: the hand-off minter belongs to the dispatcher");
  claimed = true;
  return { admit: (ticket) => { live.add(ticket); }, revoke: (ticket) => { live.delete(ticket); },
    dispatchToken: () => { const token = Object.freeze({ kind: "handoff-dispatch" as const }); tokens.add(token); return token; } };
}

/** Whether the value is a ticket the dispatcher made and has not cleared. */
export function isLiveTicket(candidate: unknown): boolean {
  return typeof candidate === "object" && candidate !== null && live.has(candidate);
}

/** Whether the value is a dispatch token the dispatcher made. */
export function isDispatchToken(candidate: unknown): candidate is HandoffDispatchToken {
  return typeof candidate === "object" && candidate !== null && tokens.has(candidate);
}
