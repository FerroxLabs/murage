// SPDX-License-Identifier: AGPL-3.0-or-later
// B5 billing and provisioning configuration. Everything that is a price, a price id,
// a server type or an image id lives here or in env, never in the lifecycle code.
import { z } from "zod";
import { STRIPE_API_VERSION } from "./b5-stripe";
import { HTTPError } from "./http";
import { refundKeyConfigError } from "./refund-identity";

declare global {
  interface Env { // Secrets and vars below are optional: billing is off until they are set.
    STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; STRIPE_API_VERSION?: string;
    STRIPE_PRICE_STARTER?: string; STRIPE_PRICE_PRO?: string; STRIPE_PRICE_MAX?: string;
    STRIPE_PORTAL_CONFIGURATION?: string; STRIPE_ALLOW_LIVE?: string; CLOUD_SALES_OPEN?: string; CLOUD_SALES_ALLOWLIST?: string;
    BILLING_RETURN_ORIGIN?: string; FP_COMMISSION_PRICE_IDS?: string; FLUX_TOPUP_PRICE_IDS?: string;
    B5_PROVISIONER_CONFIG?: string; HCLOUD_TOKEN?: string; VULTR_API_KEY?: string;
    STORAGEBOX_API_TOKEN?: string; STORAGEBOX_MAIN_PASSWORD?: string;
  }
  namespace Cloudflare {
    interface Env {
      STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; STRIPE_API_VERSION?: string;
      STRIPE_PRICE_STARTER?: string; STRIPE_PRICE_PRO?: string; STRIPE_PRICE_MAX?: string;
      STRIPE_PORTAL_CONFIGURATION?: string; STRIPE_ALLOW_LIVE?: string; CLOUD_SALES_OPEN?: string; CLOUD_SALES_ALLOWLIST?: string;
      BILLING_RETURN_ORIGIN?: string; FP_COMMISSION_PRICE_IDS?: string; FLUX_TOPUP_PRICE_IDS?: string;
      B5_PROVISIONER_CONFIG?: string; HCLOUD_TOKEN?: string; VULTR_API_KEY?: string;
      STORAGEBOX_API_TOKEN?: string; STORAGEBOX_MAIN_PASSWORD?: string;
    }
  }
}

export const PLANS = ["starter", "pro", "max"] as const;
export type Plan = (typeof PLANS)[number];
/** Display only; Stripe is the source of truth for what is charged. */
export const PLAN_MONTHLY_USD: Record<Plan, number> = { starter: 49, pro: 99, max: 149 };
export const PLAN_RANK: Record<Plan, number> = { starter: 1, pro: 2, max: 3 };

export const DAY_MS = 86_400_000;
export const GRACE_MS = 3 * DAY_MS; // payment failed -> 3 days, then suspend
// Retention (suspended -> delete): CLOUD_B3_CONFIG.retentionMs drives the lifecycle (30 days = 2592000000 in every wrangler env);
// this constant is the same 30 days for the legal wording and dates (Cloud terms, privacy policy).
export const RETENTION_MS = 30 * DAY_MS;

export interface BillingConfig {
  apiVersion: string; secretKey: string; webhookSecret: string; returnOrigin: string;
  portalConfiguration: string | null;
  priceByPlan: Record<Plan, string>;
  planByPrice: Map<string, Plan>;
  /** Price ids whose invoices earn FirstPromoter commission: subscription prices only. */
  commissionPriceIds: ReadonlySet<string>;
}

const priceId = z.string().regex(/^price_[A-Za-z0-9]{6,64}$/);
const list = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export class BillingConfigError extends Error {}

/** Returns null when billing is simply not configured (feature off). Throws on a half or unsafe config. */
export function billingConfig(env: Env): BillingConfig | null {
  if (!env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) return null;
  const secretKey = env.STRIPE_SECRET_KEY ?? ""; const webhookSecret = env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(secretKey) || !/^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(webhookSecret)) {
    throw new BillingConfigError("billing_misconfigured");
  }
  // Test mode only until Sean flips STRIPE_ALLOW_LIVE.
  if (/_live_/.test(secretKey) && env.STRIPE_ALLOW_LIVE !== "1") throw new BillingConfigError("billing_live_not_allowed");
  // The refund-identity HMAC key (refund-identity.ts) is NOT part of billing readiness: it gates new checkouts only (checkoutRefundKeyError).
  // Withdrawals, refunds already owed, their retries and the retention purge must keep working whatever state that key is in (Astra
  // ASTRA-REFUND2 #1): a statutory refund never waits on the voluntary offer's configuration.
  const prices = {
    starter: priceId.safeParse(env.STRIPE_PRICE_STARTER), pro: priceId.safeParse(env.STRIPE_PRICE_PRO),
    max: priceId.safeParse(env.STRIPE_PRICE_MAX),
  };
  if (!prices.starter.success || !prices.pro.success || !prices.max.success) throw new BillingConfigError("billing_prices_missing");
  const priceByPlan: Record<Plan, string> = { starter: prices.starter.data, pro: prices.pro.data, max: prices.max.data };
  if (new Set(Object.values(priceByPlan)).size !== 3) throw new BillingConfigError("billing_prices_duplicate");
  let returnOrigin: string;
  try {
    const u = new URL(env.BILLING_RETURN_ORIGIN ?? "");
    if (u.protocol !== "https:" || u.pathname !== "/" || u.search || u.hash || u.username) throw new Error();
    returnOrigin = u.origin;
  } catch { throw new BillingConfigError("billing_return_origin_invalid"); }
  const allow = list(env.FP_COMMISSION_PRICE_IDS);
  const topups = new Set(list(env.FLUX_TOPUP_PRICE_IDS));
  const commission = new Set(allow.length ? allow : Object.values(priceByPlan));
  for (const id of commission) {
    // The allowlist may only ever name our three subscription prices; a Flux top-up
    // (or anything else) in it is a config error, not a silent commission leak.
    if (!Object.values(priceByPlan).includes(id) || topups.has(id)) throw new BillingConfigError("commission_allowlist_invalid");
  }
  // ONE pinned Stripe API version for both seller paths (b5-stripe.ts STRIPE_API_VERSION). Any other value is a config error, not an override:
  // the code reads Basil-shaped objects.
  if (env.STRIPE_API_VERSION !== undefined && env.STRIPE_API_VERSION !== STRIPE_API_VERSION) throw new BillingConfigError("billing_api_version_unsupported");
  return { apiVersion: STRIPE_API_VERSION, secretKey, webhookSecret, returnOrigin,
    portalConfiguration: env.STRIPE_PORTAL_CONFIGURATION ?? null, priceByPlan,
    planByPrice: new Map(PLANS.map((p) => [priceByPlan[p], p] as const)), commissionPriceIds: commission };
}

// Flux Router's own Terms of Service, accepted in the same single acceptance as ours (no second screen). The URL is Flux's, not the site's
// origin, and the version is the date of the text it linked when this wording shipped; both live only here, in b5-config.ts. A new version bumps
// SCREEN_VERSION (legal-flows.ts), so a page showing the old line is refused 409 disclosure_stale.
export const FLUX_TERMS_URL = "https://fluxrouter.ai/terms-of-service";
export const FLUX_TERMS_VERSION = "October 31, 2026";

/** The marketing site's origin (murage.ai), where the legal pages Stripe's submit text links to live. Not the cloud origin. CHECKOUT_SITE_ORIGIN
 *  overrides it (staging); anything but a plain https origin falls back to the default. */
export const DEFAULT_SITE_ORIGIN = "https://murage.ai";
export function siteOrigin(env: unknown): string {
  try {
    const u = new URL(String((env as Record<string, unknown>).CHECKOUT_SITE_ORIGIN ?? ""));
    if (u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash && !u.username) return u.origin;
  } catch { /* default */ }
  return DEFAULT_SITE_ORIGIN;
}
/** The legal pages the direct submit text links to: three on the site (route folders under apps/web/app/[locale]/(marketing)/(legal)/) and Flux Router's terms (FLUX_TERMS_URL, never the site origin). */
export const submitLinksFor = (env: unknown) => { const o = siteOrigin(env); return { terms: `${o}/cloud-terms`, tos: `${o}/terms-of-service`, privacy: `${o}/privacy-policy`, flux: FLUX_TERMS_URL }; };

/** Why a NEW checkout cannot be sold right now because of the refund-identity key, or null. A malformed key is refused in any mode, and
 *  a live checkout is not sold without one (every 7-day request would otherwise wait for it). Only checkout reads this: everything a
 *  customer is already owed (withdrawal, refunds, retries, purge) runs on billingConfig alone. */
export function checkoutRefundKeyError(env: Env): string | null {
  const bad = refundKeyConfigError(env);
  if (bad) return bad;
  if (/_live_/.test(env.STRIPE_SECRET_KEY ?? "") && !env.REFUND_KEY_SECRET) return "refund_key_missing";
  return null;
}

export const EU_HETZNER_LOCATIONS = ["fsn1", "nbg1", "hel1"] as const;
export const EU_VULTR_REGIONS = ["fra", "ams", "cdg", "sto", "waw", "mad", "mxp"] as const;
/** Vultr reads firewall_group_id "0" as remove-the-firewall, so blank and "0" are never valid ids. */
const vultrId = z.string().trim().min(1).max(64).refine((v) => v !== "0" && !/^0+$/.test(v), "vultr_id_invalid");
const hetznerArch = z.enum(["x86", "arm"]);
const poolRung = z.object({ serverType: z.string().regex(/^[a-z0-9-]{2,32}$/), arch: hetznerArch }).strict();
const poolClass = z.object({
  rungs: z.array(poolRung).min(1).max(6),
  target: z.number().int().min(0).max(1000), red: z.number().int().min(0).max(1000), max: z.number().int().min(0).max(1000),
}).strict().refine((c) => c.red <= c.target && c.target <= c.max, "pool_class_order");
const poolUsage = z.object({ vcpu: z.number().int().min(0), primaryIps: z.number().int().min(0), volumeGb: z.number().int().min(0) }).strict();
/** Warm pool of pre-created, powered-off servers. Absent = pool off. */
export const poolSchema = z.object({
  env: z.enum(["staging", "production"]),
  classes: z.object({ starter: poolClass, pro: poolClass }).strict(),
  monthlyIdleCapEur: z.number().min(0).max(100_000),
  maxCreatesPerTick: z.number().int().min(1).max(100).default(10),
  maxCreatesPerDay: z.number().int().min(1).max(5000).default(150),
  maxConsecutiveCreateFailures: z.number().int().min(1).max(100).default(5),
  limits: poolUsage.extend({ reserveForLive: poolUsage }).strict(),
  overTargetRetireAfterH: z.number().int().min(1).max(24 * 30).default(72),
}).strict();
export type PoolConfig = z.infer<typeof poolSchema>;
/** The signer's name, informational only: the Worker trusts the signature (image-signature.ts), never a label. */
export const VERIFIER_NAME = "hz-live-rescue";
export const provisionerSchema = z.object({
  /** Locations tried in order for build host; a server type is tried in every location before the next rung. */
  hetznerLocations: z.array(z.enum(EU_HETZNER_LOCATIONS)).min(1).default(["fsn1", "nbg1", "hel1"]),
  /** EU only (customer data stays in the EU). Checked against Vultr's live regions list 2026-10-09; UK is not EU. */
  vultrRegions: z.array(z.enum(EU_VULTR_REGIONS)).min(1).default(["fra", "ams", "cdg", "sto", "waw", "mad"]),
  /** Image ids per provider and arch. The ARM image is still being built, so it may be absent: that rung is skipped. */
  images: z.object({
    hetzner: z.object({ x86: z.string().optional(), arm: z.string().optional() }).strict(),
    vultr: z.object({ x86: z.string().optional() }).strict(),
  }).strict(),
  volumeGb: z.record(z.string(), z.number().int().min(10).max(10_000)).default({ starter: 50, pro: 150, max: 150 }),
  ladders: z.record(z.string(), z.array(z.object({
    provider: z.enum(["hetzner", "vultr"]), serverType: z.string().regex(/^[a-z0-9-]{2,32}$/), arch: hetznerArch,
  }).strict())).optional(),
  /** Never-order: any server type matching one of these prefixes is refused even if configured. */
  forbiddenTypePrefixes: z.array(z.string()).default(["cpx"]),
  sshKeyIds: z.array(z.number().int()).default([]),
  firewallIds: z.array(z.number().int()).default([]),
  /** Applied by fence_network: a firewall that allows only the quarantine relay. */
  quarantineFirewallId: z.number().int().optional(),
  quarantineFirewallGroupId: vultrId.optional(),
  /** Vultr ids are strings (UUIDs). Without this block a Vultr rung is skipped: a home is never created unfirewalled. */
  vultr: z.object({
    /** Optional: a home takes no operator login. Production sets none; the image has no sshd. */
    sshKeyIds: z.array(vultrId).default([]),
    firewallGroupId: vultrId,
    quarantineFirewallGroupId: vultrId,
  }).strict().optional(),
  /** Ask the home to archive its data volume when it is suspended. Every snapshot is deleted with the home at day 14. */
  /** build host Storage Box for per-home backups (sub-account per home). Absent = backups off. */
  /** One entry per box (each allows at most 100 sub-accounts). A single object is accepted and treated as a one-box list. */
  storageBox: z.preprocess((v) => (v === undefined || Array.isArray(v) ? v : [v]),
    z.array(z.object({ id: z.number().int().positive(), host: z.string().regex(/^[a-z0-9.-]+$/), mainUser: z.string().regex(/^u\d+$/),
    knownHosts: z.string().min(20).max(4000), baseDir: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).default("murage") }).strict()).min(1).max(20).refine((boxes) => new Set(boxes.map((b) => b.id)).size === boxes.length, "duplicate storage box id").optional()),
  /** STAGING ONLY. Operator source networks allowed to ssh to a new home (the image closes ssh on every other source).
   *  Never set in production: customer homes have no operator ssh. World-open ranges are refused. */
  opsSshFrom: z.array(z.string().regex(/^\d{1,3}(\.\d{1,3}){3}(\/(1[6-9]|2\d|3[0-2]))?$/)).max(4).default([]),
  snapshotAtSuspension: z.boolean().default(true),
  pool: poolSchema.optional(),
  /** Image id -> the signed entry the signer printed (image-signature.ts). NOT validated at parse time, so one bad entry or key can never stop
   *  suspend, fence or delete; verifyImageForUse validates the selected key and entry when a server is about to be created. */
  imageKinds: z.unknown().optional(),
  /** Customer homes are build host only. Off: a ladder rung on Vultr is never used. On: it is walked like any other rung. */
  allowVultrCustomerHomes: z.boolean().default(false),
}).strict();
export type ProvisionerConfig = z.infer<typeof provisionerSchema>;

export type LadderRung = { provider: "hetzner" | "vultr"; serverType: string; arch: "x86" | "arm" };
export const DEFAULT_LADDERS: Record<Plan, LadderRung[]> = {
  starter: [
    { provider: "hetzner", serverType: "cx23", arch: "x86" },
    { provider: "hetzner", serverType: "cax11", arch: "arm" },
  ],
  pro: [
    { provider: "hetzner", serverType: "cax21", arch: "arm" },
    { provider: "hetzner", serverType: "cx33", arch: "x86" },
  ],
  max: [
    { provider: "hetzner", serverType: "cax21", arch: "arm" },
    { provider: "hetzner", serverType: "cx33", arch: "x86" },
  ],
};

/** True only on the staging control plane. Anything else (unset, "0", "true") is production. */
export const isStagingEnv = (env: unknown): boolean => (env as { CLOUD_CP0_STAGING?: string }).CLOUD_CP0_STAGING === "1";
export function provisionerConfig(env: Env): ProvisionerConfig {
  const config = provisionerSchema.parse(JSON.parse(env.B5_PROVISIONER_CONFIG ?? "null"));
  for (const ladder of Object.values(config.ladders ?? {})) {
    for (const rung of ladder) assertAllowedType(config, rung.serverType);
  }
  for (const cls of Object.values(config.pool?.classes ?? {})) for (const rung of cls.rungs) assertAllowedType(config, rung.serverType);
  // Operator root ssh exists on staging homes only. A production config that carries it is refused outright.
  if (config.opsSshFrom.length && !isStagingEnv(env)) throw new Error("ops_ssh_staging_only");
  return config;
}
export function assertAllowedType(config: Pick<ProvisionerConfig, "forbiddenTypePrefixes">, serverType: string) {
  if (config.forbiddenTypePrefixes.some((p) => serverType.toLowerCase().startsWith(p))) throw new Error("server_type_forbidden");
}
export function ladderFor(config: ProvisionerConfig, plan: string): LadderRung[] {
  const ladder = config.ladders?.[plan] ?? DEFAULT_LADDERS[plan as Plan];
  if (!ladder) throw new Error("unknown_plan");
  for (const rung of ladder) assertAllowedType(config, rung.serverType);
  return ladder;
}

/** The sales switch, CLOUD_SALES_OPEN, parsed STRICTLY. Exactly "true" is open to everyone, exactly "invite" is open to invited emails only
 *  (sales_invites, sales-invite.ts), exactly "false" is shut. Anything else is SHUT: unset, empty, "TRUE", " true", "1", "yes", a typo. A
 *  forgotten or mistyped value can therefore never open sales. Shut (and the shut half of every other value) refuses reserve, checkout and
 *  checkout/resume with 503 sales_closed; an uninvited caller in invite mode gets 403 not_invited instead.
 *  It is a SALES-ONLY switch: nothing else reads it. GET /v1/status ({live}) does NOT depend on it: live means the service operates for
 *  existing customers (status.ts cloudOperating), so closing sales never makes the desktop disable Cloud for them. */
export type SalesMode = "open" | "invite" | "shut";
export function salesMode(env: Pick<Env, "CLOUD_SALES_OPEN">): SalesMode {
  switch (env.CLOUD_SALES_OPEN) {
    case "true": return "open";
    case "invite": return "invite";
    default: return "shut";
  }
}
export const salesShut = (env: Pick<Env, "CLOUD_SALES_OPEN">): boolean => salesMode(env) === "shut";
/** The invite list for a dark launch: CLOUD_SALES_ALLOWLIST, a plain var of comma-separated exact email addresses (trimmed, lowercased,
 *  empty entries ignored; no wildcards, no domains). Unset or empty lists nobody. */
export function salesAllowlist(env: Pick<Env, "CLOUD_SALES_ALLOWLIST">): Set<string> {
  return new Set((env.CLOUD_SALES_ALLOWLIST ?? "").split(",").map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0));
}
/** Sales are allowed for this caller when they are open (today's rule), or when sales are shut and `email` is the SIGNED-IN account's
 *  address and it is on CLOUD_SALES_ALLOWLIST. Callers pass only the resolved session's email, never one from a request body. */
export function salesAllowed(env: Pick<Env, "CLOUD_SALES_OPEN" | "CLOUD_SALES_ALLOWLIST">, email?: string | null): boolean {
  if (!salesShut(env)) return true;
  if (typeof email !== "string") return false;
  const e = email.trim().toLowerCase();
  return e.length > 0 && salesAllowlist(env).has(e);
}
/** Refuses 503 sales_closed when sales are shut and the signed-in email is not on CLOUD_SALES_ALLOWLIST. "invite" passes here: the per-caller check is assertInvited (sales-invite.ts). */
export function assertSalesOpen(env: Pick<Env, "CLOUD_SALES_OPEN" | "CLOUD_SALES_ALLOWLIST">, email?: string | null): void {
  if (!salesAllowed(env, email)) throw new HTTPError(503, "sales_closed");
}
