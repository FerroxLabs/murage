// The one rule for holding the computer awake on the phones' behalf. Kept out
// of main.mjs so it can be tested without Electron; main.mjs owns the power
// blocker itself.

/** Whether the computer should be held awake for the phones.
 *
 * All three, or no: the owner asked (`keepAwake`, an explicit opt-in, never
 * inferred), the sidecar is actually up, and at least one device is paired.
 * Unreadable input answers no — the failure mode of a wrong yes is a laptop
 * that never sleeps.
 * @param {{ enabled?: unknown, error?: unknown, keepAwake?: unknown, devices?: unknown } | null | undefined} state */
export function companionShouldStayAwake(state) {
  return Boolean(
    state
      && state.enabled === true
      && !state.error
      && state.keepAwake === true
      && Array.isArray(state.devices)
      && state.devices.length > 0,
  );
}
