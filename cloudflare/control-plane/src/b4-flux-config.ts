// SPDX-License-Identifier: AGPL-3.0-or-later
// B4 settings: what each plan includes, the default monthly cap, and how long a
// home's Flux key lives. These are CONFIG, not code: set FLUX_B4_CONFIG (a JSON
// string var) to change them without a deploy of new logic. The defaults below
// are the face values Sean set on 2026-10-08/09: Starter $10, Pro $20, Max $40 (the one-person plan),
// plus Team $50 and Business $200 which are pooled org plans (config only, not built).
import { z } from "zod";

declare global {
  interface Env {
    /** https origin of the Flux gateway. Default https://api.fluxrouter.ai */
    FLUX_API_BASE?: string;
    /** https origin of the Flux web app (credit grants). Default https://fluxrouter.ai */
    FLUX_APP_BASE?: string;
    /** Staging only: Vercel's automation bypass for Flux's staging app, sent only to STAGING_FLUX_APP_HOST (flux-grants.ts). Secret; never set on prod. */
    FLUX_STAGING_VERCEL_BYPASS?: string;
    /** Narrow bearer for Flux's cloud-home routes (not the Flux master key). Secret. */
    FLUX_CLOUD_SERVICE_TOKEN?: string;
    /** Flux's Ed25519 link-proof public key, base64url of the 32 raw bytes. */
    FLUX_LINK_PUBLIC_KEY?: string;
    /** Where the owner signs in to Flux to get a link proof. */
    FLUX_AUTHORIZE_URL?: string;
    /** JSON, see fluxConfigSchema. Unset means the defaults. */
    FLUX_B4_CONFIG?: string;
    /** Default-off switch for every B4 Flux route and the Flux cron sweep. Only "1" turns them on (see fluxRoutesEnabled). */
    CLOUD_FLUX_ROUTES_ENABLED?: string;
    /** 8b (SPENDING-RESUME-VIA-POLLER 2.9): default-off. Only "1" lets spending come back on for a stopped home (through the home's own poller). */
    FLUX_RESUME_VIA_POLLER?: string;
    /** Default-off switch for charging auto top-ups. Only "1" charges (see topupChargingEnabled in topup-charge.ts). */
    CLOUD_AUTOTOPUP_ENABLED?: string;
  }
  namespace Cloudflare {
    interface Env {
      FLUX_API_BASE?: string;
      FLUX_APP_BASE?: string;
      FLUX_STAGING_VERCEL_BYPASS?: string;
      FLUX_CLOUD_SERVICE_TOKEN?: string;
      FLUX_LINK_PUBLIC_KEY?: string;
      FLUX_AUTHORIZE_URL?: string;
      FLUX_B4_CONFIG?: string;
      CLOUD_FLUX_ROUTES_ENABLED?: string;
      FLUX_RESUME_VIA_POLLER?: string;
      CLOUD_AUTOTOPUP_ENABLED?: string;
    }
  }
}

/**
 * Astra B4-PORT P1. Wiring step 3 put the Flux owner routes in the Cloud scope (isCloudScopePath: owner = the mapped Cloud
 * account id, never a Better Auth companion id) and behind the central step-up gate (needsStepUp: link start/complete,
 * subkey, cap, stop). They stay OFF until Sean's go: absent or anything but exactly "1" answers 404 on every Flux path,
 * before any auth or D1 read, the machine desired response carries no flux_renewal_due, and the Flux cron does nothing.
 */
/** 8b (2.9): spending back ON for a stopped home is served only when this Worker var is exactly "1". */
export const fluxResumeViaPoller = (env: Pick<Env, "FLUX_RESUME_VIA_POLLER">): boolean => env.FLUX_RESUME_VIA_POLLER === "1";
export const fluxRoutesEnabled = (env: Pick<Env, "CLOUD_FLUX_ROUTES_ENABLED">): boolean => env.CLOUD_FLUX_ROUTES_ENABLED === "1";

/** PRODFLUX (Astra HIGH 2): which Flux credential is missing, or null when BOTH are there. Flux issues nothing new (no key op, no grant, no
 *  activation route) unless the switch is on AND both are set: FLUX_CLOUD_SERVICE_TOKEN (keys, ensure-account; 32+ characters, as
 *  createFluxClient demands) and FLUX_CLOUD_GRANTS_TOKEN (credit grants). Names only, never values. */
export function fluxCredentialsMissing(env: Pick<Env, "FLUX_CLOUD_SERVICE_TOKEN" | "FLUX_CLOUD_GRANTS_TOKEN">): "flux_service_token_absent" | "grants_token_absent" | null {
  const service = env.FLUX_CLOUD_SERVICE_TOKEN?.trim();
  if (!service || service.length < 32) return "flux_service_token_absent";
  if (!env.FLUX_CLOUD_GRANTS_TOKEN?.trim()) return "grants_token_absent";
  return null;
}
export const fluxCredentialsReady = (env: Pick<Env, "FLUX_CLOUD_SERVICE_TOKEN" | "FLUX_CLOUD_GRANTS_TOKEN">): boolean => fluxCredentialsMissing(env) === null;
/** Flux SERVES its customer routes (link, keys, cap raise, renewal) only when switched on AND both credentials are set. Switched on with a
 *  credential missing, every customer Flux route answers exactly as Flux off (404, or the owner's "Flux is unavailable"), the operator
 *  ledger recovery keeps working, and billing keeps journaling (the obligations are held, see flux-live-hooks.ts and b4-flux.ts). */
export const fluxServing = (env: Pick<Env, "CLOUD_FLUX_ROUTES_ENABLED" | "FLUX_CLOUD_SERVICE_TOKEN" | "FLUX_CLOUD_GRANTS_TOKEN">): boolean =>
  fluxRoutesEnabled(env) && fluxCredentialsReady(env);

/** Every Flux path, as a PREFIX: /v1/flux*, /v1/internal/flux*, /v1/homes/:id/flux* and /v1/machines/:id/flux* (no segment boundary after
 *  "flux": /v1/homes/x/fluxfoo is denied too, so no near-miss path slips past the early 404, Astra B4-PORT-2 #1). */
const FLUX_PATH = /^\/v1\/(?:flux|internal\/flux|(?:homes|machines)\/[^/]+\/flux)/;
export const isFluxPath = (path: string): boolean => FLUX_PATH.test(path);

/** The Flux cron may touch D1 only when the routes are on AND BOTH Flux credentials (fluxCredentialsReady) and an explicit https API base
 *  are set. Anything less returns before the first statement: pending grants keep their attempt budgets, nothing is claimed,
 *  no reversal is requested (Astra B4-PORT P2, PRODFLUX HIGH 2). */
export function fluxSweepConfigured(env: Pick<Env, "CLOUD_FLUX_ROUTES_ENABLED" | "FLUX_CLOUD_SERVICE_TOKEN" | "FLUX_CLOUD_GRANTS_TOKEN" | "FLUX_API_BASE">): boolean {
  return fluxServing(env) && fluxApiBaseConfigured(env);
}

/** PRODFLUX (MurageMain): a Stop never depends on a token it does not use. A key Stop (home scope) and a key revocation (one generation) are
 *  sent with FLUX_CLOUD_SERVICE_TOKEN only (createFluxClient, b4-flux.ts), so switched on with THAT token and an explicit https API base set
 *  but FLUX_CLOUD_GRANTS_TOKEN missing, revocations still go out (b4-flux.ts fluxRevokeOnly): a cancelled home's key never keeps spending
 *  because the grants secret is absent. Everything that issues (mint, ensure-account, grants, cap pushes, activation routes) stays held. */
export const fluxRevokeOnlyConfigured = (env: Pick<Env, "CLOUD_FLUX_ROUTES_ENABLED" | "FLUX_CLOUD_SERVICE_TOKEN" | "FLUX_CLOUD_GRANTS_TOKEN" | "FLUX_API_BASE">): boolean =>
  fluxRoutesEnabled(env) && fluxCredentialsMissing(env) === "grants_token_absent" && fluxApiBaseConfigured(env);

/** PRODFLUX r3 (plan 1'): THE one readiness read, so no boundary decides a send or a charge on the switch alone.
 *  - issue: Flux may ISSUE (mint, cap push, ensure-account, grants, a NEW auto top-up claim): switched on, both credentials, explicit https API base.
 *  - revoke: a REVOCATION (owner or billing Stop, key revoke, the revocation sweep) may be SENT: issue, or only the grants token missing.
 *  Neither says whether a Stop is JOURNALED: switched on with real hooks, a Stop is always recorded and goes out once revoke is true. */
export type FluxReadiness = { issue: boolean; revoke: boolean };
export function fluxReadiness(env: Pick<Env, "CLOUD_FLUX_ROUTES_ENABLED" | "FLUX_CLOUD_SERVICE_TOKEN" | "FLUX_CLOUD_GRANTS_TOKEN" | "FLUX_API_BASE">): FluxReadiness {
  const issue = fluxSweepConfigured(env);
  return { issue, revoke: issue || fluxRevokeOnlyConfigured(env) };
}

function fluxApiBaseConfigured(env: Pick<Env, "FLUX_API_BASE">): boolean {
  const base = env.FLUX_API_BASE?.trim();
  if (!base) return false;
  try {
    const url = new URL(base);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === "/";
  } catch {
    return false;
  }
}

const planId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

export const fluxConfigSchema = z.strictObject({
  /** Flux credits (USD, face value) granted each paid billing period. */
  plans: z.record(planId, z.strictObject({
    creditsUsd: z.number().positive().max(10_000),
    /** Org plan whose credits are pooled across homes. Config only: no per-home grant. */
    pooled: z.boolean().optional(),
  })),
  /** The plan a home is treated as until billing says otherwise. */
  defaultPlan: planId,
  /** Default monthly cap = this many times the plan's included credits. */
  defaultCapMultiplier: z.number().min(1).max(20),
  minCapUsd: z.number().min(5).max(5_000), // the router's own floor is $5 (Stage A)
  maxCapUsd: z.number().min(1).max(5_000),
  /** How long a home's Flux key lives before it must be re-issued. */
  subkeyTtlDays: z.number().int().min(1).max(120),
  /** How long a link challenge stays open. */
  linkChallengeMinutes: z.number().int().min(1).max(60),
});
export type FluxConfig = z.infer<typeof fluxConfigSchema>;

export const DEFAULT_FLUX_CONFIG: FluxConfig = {
  plans: {
    starter: { creditsUsd: 10 },
    pro: { creditsUsd: 20 },
    max: { creditsUsd: 40 },
    team: { creditsUsd: 50, pooled: true },
    business: { creditsUsd: 200, pooled: true },
  },
  defaultPlan: "starter",
  defaultCapMultiplier: 3,
  minCapUsd: 5,
  maxCapUsd: 1_000,
  subkeyTtlDays: 35,
  linkChallengeMinutes: 10,
};

/** The effective config. A set-but-invalid FLUX_B4_CONFIG throws: money settings
 *  never silently fall back to defaults. */
export function readFluxConfig(env: Pick<Env, "FLUX_B4_CONFIG">): FluxConfig {
  const raw = env.FLUX_B4_CONFIG?.trim();
  if (!raw) return DEFAULT_FLUX_CONFIG;
  const parsed = fluxConfigSchema.parse(JSON.parse(raw));
  if (parsed.minCapUsd > parsed.maxCapUsd || !(parsed.defaultPlan in parsed.plans)) {
    throw new Error("invalid FLUX_B4_CONFIG");
  }
  return parsed;
}

export const MICROCENTS_PER_USD = 1_000_000;
export const usdToMicrocents = (usd: number) => Math.round(usd * MICROCENTS_PER_USD);
export const microcentsToUsd = (microcents: number) => microcents / MICROCENTS_PER_USD;

/** The cap a home starts with, and the one it returns to if never customised. */
export function defaultCapUsd(config: FluxConfig, plan: string): number {
  const credits = config.plans[plan]?.creditsUsd ?? config.plans[config.defaultPlan].creditsUsd;
  return Math.min(config.maxCapUsd, Math.max(config.minCapUsd, Math.ceil(credits * config.defaultCapMultiplier)));
}
