// SPDX-License-Identifier: AGPL-3.0-or-later
// THE BILLING FLUX HOOKS THE WORKER RUNS WITH (step 1 of Flux for Murage Cloud).
//
// Billing (b5-billing.ts), the refunds (legal-refunds.ts) and B4 (b4-flux.ts fluxOn) all read ONE hooks object, and they read its `stub` and
// `capabilities` without an env. This module hands them an object that answers as the pre-B4 stub (stubFluxHooks, call for call) until
// the Flux route switch is exactly "1", and as the real hooks after it:
//   - grants, reversals, reversal targets, grant-state reads, account ensure, fence reconcile and the usage read: the router grants client
//     (flux-grants.ts grantsHooks) built with { reversalTargets: true }, so a paid invoice's grant (credit_grants body, one per invoice and
//     kind) is sent to FLUX_CLOUD_GRANTS_URL with FLUX_CLOUD_GRANTS_TOKEN, and a refund's versioned target and a non-refund reversal follow;
//   - changePlan and stopForBilling: the B4 implementations (b4-flux.ts);
//   - setAutoRecharge: Flux does no charging here, the Worker does (topup-charge.ts). While CLOUD_AUTOTOPUP_ENABLED is exactly "1" the hook
//     resolves, which only records the saved authorization as applied (nothing is written to Flux); otherwise it throws flux_not_wired and
//     the account page says automatic top-up is not active.
// Retries stay correct because nothing here keeps state: the grant is asked under the claim of credit_grants (one row per invoice and kind,
// attempts and last_error recorded by b5-billing.ts askGrant), the frozen body and its hash are what every ask re-sends, the router dedupes
// on grant_id, and the fence rows (b4-flux-ledger.ts, flux-grants-fence) decide whether a lost answer is read back or re-sent.
//
// THE SWITCH. selectFluxMode(env) is called once at the top of each fetch and scheduled invocation (a string compare, no D1 read, no
// request). the Flux route switch is a deployment variable, so every invocation of one deployment selects the same mode; the module
// state only carries that answer to the code that has no env at the point it reads `stub`. Off (unset or anything but "1"): every member of
// the object is the stub's own, so behaviour, D1 traffic and alerts are exactly those of stubFluxHooks.
import { b4RouterClient, changePlan as b4ChangePlan, raiseCapToCover, stopForBilling as b4StopForBilling } from "./b4-flux";
import { fluxCredentialsReady, fluxRoutesEnabled } from "./b4-flux-config";
import { topupChargingEnabled } from "./held-until-item9-highs";
import { stubFluxHooks, type FluxEntitlementHooks } from "./b5-billing";
import { grantsHooks } from "./flux-grants";

type FetchLike = Parameters<typeof grantsHooks>[0];
/** on: the switch is "1" (the real hooks answer). ready: AND both Flux credentials are set (PRODFLUX, Astra HIGH 2). Switched on with a
 *  credential missing the real hooks stay selected (a billing stop or plan change is still journaled by B4, never dropped into the stub's
 *  log), but they advertise NO capability: billing holds every grant and reversal as Flux off (no ask counted) and B4's gate stays shut. */
type Mode = { on: boolean; ready?: boolean };

export function createEnvFluxHooks(doFetch?: FetchLike): FluxEntitlementHooks & { readonly mode: Mode } {
  const mode: Mode = { on: false, ready: false };
  const client = grantsHooks(doFetch, { reversalTargets: true });
  const real: FluxEntitlementHooks = {
    ...client,
    changePlan: (env, input) => b4ChangePlan(env, input, { billingFlux: hooks }),
    stopForBilling: (env, homeId, _deps, options) => b4StopForBilling(env, homeId, { billingFlux: hooks }, options),
    topupBalance: async (env, homeId) => (await b4RouterClient(env, { billingFlux: hooks }).status(homeId)).accountSpendableMicrocents ?? null,
    raiseCapForTopup: (env, homeId) => raiseCapToCover(env, homeId, { billingFlux: hooks }),
    setAutoRecharge: async (env) => { if (!topupChargingEnabled(env)) throw new Error("flux_not_wired"); },
  };
  const cur = (): FluxEntitlementHooks => (mode.on ? real : stubFluxHooks);
  const opt = <K extends "setReversalTarget" | "grantReversalState" | "ensureAccount" | "reconcileFences" | "includedCreditMicrocents">(k: K): FluxEntitlementHooks[K] => {
    const f = cur()[k] as ((...a: unknown[]) => unknown) | undefined;
    return (f ? (...a: unknown[]) => f(...a) : undefined) as FluxEntitlementHooks[K];
  };
  const hooks: FluxEntitlementHooks & { readonly mode: Mode } = {
    mode,
    get stub() { return cur().stub; },
    get capabilities() { return mode.on && mode.ready !== true ? {} : cur().capabilities; },
    grantMonthlyCredits: (...a) => cur().grantMonthlyCredits(...a),
    revokeCredits: (...a) => cur().revokeCredits(...a),
    changePlan: (...a) => cur().changePlan(...a),
    stopForBilling: (...a) => cur().stopForBilling(...a),
    usedIncludedCreditMicrocents: (...a) => cur().usedIncludedCreditMicrocents(...a),
    setAutoRecharge: (...a) => cur().setAutoRecharge(...a),
    get setReversalTarget() { return opt("setReversalTarget"); },
    get grantReversalState() { return opt("grantReversalState"); },
    get ensureAccount() { return opt("ensureAccount"); },
    get reconcileFences() { return opt("reconcileFences"); },
    get includedCreditMicrocents() { return opt("includedCreditMicrocents"); },
    get topupBalance() { return mode.on ? real.topupBalance : undefined; },
    get raiseCapForTopup() { return mode.on ? real.raiseCapForTopup : undefined; },
  };
  return hooks;
}

/** The worker's one hooks object (grants go out through global fetch). */
export const envFluxHooks = createEnvFluxHooks();

/** Called once per invocation with the invocation's env; selects stub or real for the object passed. */
export function selectFluxMode(env: Pick<Env, "CLOUD_FLUX_ROUTES_ENABLED" | "FLUX_CLOUD_SERVICE_TOKEN" | "FLUX_CLOUD_GRANTS_TOKEN">,
  hooks: { readonly mode?: Mode } = envFluxHooks): void {
  if (!hooks.mode) return;
  hooks.mode.on = fluxRoutesEnabled(env);
  hooks.mode.ready = hooks.mode.on && fluxCredentialsReady(env);
}
