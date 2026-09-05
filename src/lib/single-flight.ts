/** Run an async action, ignoring calls made while one is already in flight.
 *
 * Extracted so the rule can be TESTED. It lived inline in ModelPicker as a
 * ref plus a `.finally()`, and the repo's component tests are
 * renderToStaticMarkup on a node environment — no jsdom, no click — so every
 * test in the picker's own acceptance path still passed with the whole
 * production change reverted. A guard nothing can exercise is a guard nobody
 * can trust.
 *
 * The gate is SYNCHRONOUS on purpose. Two calls in the same tick must not
 * both read a stale `false`, which is why this is a plain flag rather than
 * React state: state updates are batched and would let both through.
 *
 * `busy` is reported separately for the spinner, and is cleared on the
 * rejection path too — a failed refresh must never wedge the control.
 */
export function singleFlight(run: () => Promise<unknown>, onBusy?: (busy: boolean) => void) {
  let inFlight = false;
  return () => {
    if (inFlight) return;
    inFlight = true;
    onBusy?.(true);
    void run()
      .catch(() => {
        // Swallowed on purpose: the caller keeps whatever it already had
        // rather than blanking it because the network blipped.
      })
      .finally(() => {
        inFlight = false;
        onBusy?.(false);
      });
  };
}
