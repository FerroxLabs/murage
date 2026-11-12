// SPDX-License-Identifier: AGPL-3.0-or-later
// Fleet labels (fleet-registry/TAGS.md) on pool servers, next to the control plane's own murage/* labels (which are never touched here).
// Unclaimed pool server: owner=MurageCloud, purpose=<env>-warm-pool, expires_at=<create day + 90 d>. Claimed: a customer home, so purpose=customer-home
// and NO expires_at (fleet-reap never touches a customer home).
export const FLEET_OWNER = "MurageCloud";
export const FLEET_CUSTOMER_PURPOSE = "customer-home";
export const FLEET_EXPIRY_DAYS = 90;
const DAY_MS = 86_400_000;
const VALUE = /^[A-Za-z0-9._-]{1,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throws when a value would be refused by provider's label rule (and by TAGS.md): `[A-Za-z0-9._-]{1,63}`. */
export function fleetValue(v: string): string {
  if (!VALUE.test(v)) throw new Error(`fleet_label_value:${v.slice(0, 20)}`);
  return v;
}
export const poolPurpose = (env: string) => fleetValue(`${env === "production" ? "prod" : env}-warm-pool`);
export const expiryFrom = (now: number) => new Date(now + FLEET_EXPIRY_DAYS * DAY_MS).toISOString().slice(0, 10);

/** The labels a new pool server carries in addition to its murage/* ones. */
export function poolFleetLabels(env: string, now: number): Record<string, string> {
  return { owner: fleetValue(FLEET_OWNER), purpose: poolPurpose(env), expires_at: expiryFrom(now) };
}

/** A claimed server becomes a customer home: every other label is kept as given, expires_at and the warm-pool purpose are gone. */
export function claimFleetLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) if (k !== "expires_at" && k !== "purpose" && k !== "owner") out[k] = v;
  return { ...out, owner: FLEET_OWNER, purpose: FLEET_CUSTOMER_PURPOSE };
}

/** The claim invariant, checked in one place (create-return, B3 adoption, finishPoolClaim): this home and generation, a home role, the customer purpose, no expires_at. */
export function claimLabelsOk(labels: Record<string, string>, homeId: string, generation: number): boolean {
  return labels["murage/home"] === homeId && labels["murage/generation"] === String(generation) && labels["murage/role"] === "home"
    && labels.purpose === FLEET_CUSTOMER_PURPOSE && labels.expires_at === undefined;
}
