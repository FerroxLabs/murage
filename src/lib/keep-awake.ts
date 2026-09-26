// The keep-awake offer, as data. The switch itself lives in
// `components/KeepAwakeOffer.tsx`; the rule for when the computer is actually
// held awake lives in the main process (`electron/companion-keep-awake.mjs`),
// because only it owns the power blocker.
import type { CompanionBridge, CompanionState } from "@/components/PhoneSetupFlow";

export const KEEP_AWAKE_LABEL = "Keep this computer awake while a phone is paired";

/** Honest about the one thing an app cannot override. `prevent-app-
 *  suspension` stops idle sleep; a shut lid on battery sleeps regardless. */
export const KEEP_AWAKE_DETAIL =
  "Your phone reaches Murage through this computer, so it can’t answer while the computer is asleep. "
  + "This stops it going to sleep on its own. Closing the lid still puts a laptop to sleep.";

export interface KeepAwakeOffer { checked: boolean; disabled: boolean }

/** Null while there is nothing it would do: no sidecar, or a failed one. */
export function keepAwakeOffer(state: CompanionState | null, busy: boolean): KeepAwakeOffer | null {
  if (!state?.enabled || state.error) return null;
  return { checked: state.keepAwake === true, disabled: busy };
}

export function keepAwakeCall(offer: KeepAwakeOffer) {
  return (companion: CompanionBridge) => companion.keepAwake(!offer.checked);
}
