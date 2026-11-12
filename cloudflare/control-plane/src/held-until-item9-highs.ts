// SPDX-License-Identifier: AGPL-3.0-or-later
// ITEM 9 FAIL-CLOSED GUARD (MurageMain, 11-03). Astra found four dormant Highs behind CLOUD_AUTOTOPUP_ENABLED (auto top-up charging) and
// DOOR_JOIN_REQUIRED (door device confirmation). Until their fixes land (branch cloud-v2/item9-dormant-highs), both switches read as OFF here,
// whatever the env vars or secrets say. This file is the ONE place both are decided: topup-charge.ts topupChargingEnabled and device-join.ts
// joinRequired re-export these, and every other reader goes through them.
// TO REMOVE: set HELD_UNTIL_ITEM9_HIGHS to false (or delete it and this file's guard) in the branch that lands the fixes.
export const HELD_UNTIL_ITEM9_HIGHS = true;

let releasedForTests = false;
/** Tests only: the suites of the held features (topup-charge, device-join, door-join) exercise them with the switch on. Nothing in src calls it. */
export function releaseItem9HoldForTests(released: boolean): void { releasedForTests = released; }

const warned = new Set<string>();
function held(name: string): boolean {
  if (!HELD_UNTIL_ITEM9_HIGHS || releasedForTests) return false;
  if (!warned.has(name)) { warned.add(name); console.warn(JSON.stringify({ message: name })); }
  return true;
}

/** Charging auto top-ups: only "1" charges, and never while held. */
export const topupChargingEnabled = (env: { CLOUD_AUTOTOPUP_ENABLED?: string }): boolean =>
  env.CLOUD_AUTOTOPUP_ENABLED === "1" && !held("autotopup_held_until_fix");

/** TOPUP-OFFERS-LIVE (MurageMain 11-03): auto top-up is not OFFERED while held (the account page, the disclosure, and switching it on), on
 *  the same path that hides it from a Link buyer (legal-routes.ts). Turning it off stays allowed. */
export const topupOffered = (): boolean => !held("autotopup_held_until_fix");
/** Said when an owner tries to switch auto top-up on while it is held. */
export const TOPUP_HELD_MESSAGE = "Auto top-up isn't available yet. Top up by hand in Billing for now.";

/** Door device confirmation: only "1" requires it, and never while held. */
export const joinRequired = (env: { DOOR_JOIN_REQUIRED?: string }): boolean =>
  env.DOOR_JOIN_REQUIRED === "1" && !held("door_join_held_until_fix");
