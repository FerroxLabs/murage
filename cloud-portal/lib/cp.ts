import "server-only";
import { config } from "./config";

export class CPError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export async function cpRaw(path: string, opts: { token?: string | null; body?: unknown; method?: string } = {}): Promise<Response> {
  const headers = new Headers();
  // Node's fetch marks every request `sec-fetch-mode: cors`, and Better Auth then treats it as a browser request and
  // demands an allowed Origin (403 otherwise). The portal is a first-party site: say so. The control plane's
  // ALLOWED_ORIGINS must list this origin.
  headers.set("origin", config.portalOrigin);
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const res = await fetch(`${config.cpUrl}${path}`, {
    method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: "no-store",
  });
  return res;
}

export async function cp<T = unknown>(path: string, opts: { token?: string | null; body?: unknown; method?: string } = {}): Promise<T> {
  const res = await cpRaw(path, opts);
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) throw new CPError(res.status, (data as { error?: string } | null)?.error ?? "request_failed");
  return (data ?? {}) as T;
}

export interface TwoFactorStatus { enrolled: boolean; verified: boolean; verifiedUntil: number | null; factors: { id: string; label: string }[] }
export const twoFactorStatus = (token: string) => cp<TwoFactorStatus>("/v1/account/2fa", { token });

export interface Home { id: string; name: string; status: string; publicOrigin: string | null }

/** Only follow Stripe-hosted pages the control plane hands back. */
export function allowedRedirect(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && config.redirectHosts.includes(u.hostname.toLowerCase()) ? u.toString() : null;
  } catch { return null; }
}

export interface Trader { name: string; address: string; email: string; phone: string | null }
export interface DisclosureVariant { startDate: string; firstChargeDate: string; nextChargeDate: string; renewalText: string | null; dueTodayCents: number | null }
export interface Disclosure {
  screenVersion: string; plan: string; planName: string; priceUsd: number; euCountries: string[];
  versions: { cloudTerms: string; termsOfService: string; privacyPolicy: string };
  variants: Record<"immediate" | "delayed", DisclosureVariant>;
  wording: { terms: string; reaccept: string; authorization: string; arbitration: string; earlyStart: string; nearEarlyStart: string; topupBox: string; topupCharge: string };
  topupDefaults: { amountUsd: number; thresholdUsd: number; capUsd: number; capPeriod: string; capResets: string };
  /** Who sells: "ferrox" (US, our Checkout plus Stripe Tax) or "link" (outside the US, Link is the merchant of record). */
  seller?: "ferrox" | "link"; sellerLine?: string | null; topupAvailable?: boolean;
  /** Signed-in quote only: the trader identity block (legal-notice phone from the LEGAL_PHONE Worker secret, absent when unset). */
  trader?: Trader;
  /** The Stripe Tax quote this disclosure was priced with (null: not priced yet; the renewal text is null until then). */
  tax: { quoteId: string; source: string; country: string; postalCode: string | null; priceCents: number; taxCents: number | null; totalCents: number | null;
    topupAmountCents: number; topupTaxCents: number | null; topupTotalCents: number | null; expiresAt: number } | null;
}
export interface CloudSummary {
  homeId: string;
  trader?: Trader;
  withdrawal?: { available: boolean; endsAt: number | null; withdrawnAt: number | null; status: string | null };
  subscription: { plan: string; planName: string; priceUsd: number | null; status: string; cancelAtPeriodEnd: boolean; activeUntil: number | null;
    serviceStartsAt: number | null; firstChargeAt: number | null; waitingForStart: boolean; refundWindowEndsAt: number | null } | null;
  /** available: false for a Link (Managed Payments) contract: no automatic top-up, and no controls to switch it on. */
  topup: { available?: boolean; enabled: boolean; amountUsd: number; thresholdUsd: number; capUsd: number; capPeriod: string; capResets: string; applied: boolean; applyError: string | null };
  exportRequest: { id: string; status: string; requestedAt: number; deliveredAt: number | null; pausesDeletionUntil: number | null; pausesDeletion?: boolean } | null;
  terms?: { reacceptRequired: boolean };
}
export interface TermsStatus {
  current: { cloudTerms: string; termsOfService: string; privacyPolicy: string };
  accepted: { cloudTerms: string; termsOfService: string; privacyPolicy: string; acceptedAt: number } | null;
  reacceptRequired: boolean; changed: { title: string; versionId: string }[]; noticeSentAt: number | null; effectiveAt: number | null; planEndsAt?: number | null;
  wording: { reaccept: string; arbitration: string; nonAcceptance?: string };
}
