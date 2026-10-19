"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { allowedRedirect, cp, cpRaw, CPError, type Disclosure } from "@/lib/cp";
import { isPlanId } from "@/lib/plans";
import { retryWhileBusy } from "@/lib/retry";
import { requireToken } from "@/lib/session";

const field = (f: FormData, k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string) : "");
const int = (f: FormData, k: string) => Number.parseInt(field(f, k), 10);

/** Prices the plan and the top-up amount at the customer's address (Stripe Tax, on the control plane), before any box is ticked. */
export async function quoteTax(input: { plan: string; country: string; postalCode: string; topupAmountUsd: number }): Promise<Disclosure | null> {
  if (!isPlanId(input.plan) || !/^[A-Za-z]{2}$/.test(input.country)) return null;
  const token = await requireToken(`/checkout?plan=${input.plan}`);
  const body = { plan: input.plan, country: input.country,
    ...(input.postalCode.trim() ? { postalCode: input.postalCode.trim().slice(0, 20) } : {}),
    ...(Number.isInteger(input.topupAmountUsd) && input.topupAmountUsd >= 5 && input.topupAmountUsd <= 500 ? { topupAmountUsd: input.topupAmountUsd } : {}) };
  // One retry, then the page says to try again in a moment. There is no checkout without a quote.
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await cp<Disclosure>("/v1/legal/quote", { token, body }); } catch { /* retried once */ }
  }
  return null;
}

/** What the portal saw of the customer's own request, and where it came from. The control plane also records what it observed itself. */
async function clientClaims() {
  const h = await headers();
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = h.get("x-real-ip")?.trim();
  const ip = fwd || real || undefined;
  const userAgent = h.get("user-agent")?.slice(0, 400);
  return { ...(ip ? { ip, ipSource: fwd ? "x-forwarded-for" as const : "x-real-ip" as const } : { ipSource: "unavailable" as const }),
    ...(userAgent ? { userAgent } : {}) };
}

/** The clickwrap's submit. The control plane checks both boxes again, writes the consent record, and only then creates the Stripe session. */
export async function payNow(formData: FormData) {
  const plan = field(formData, "plan");
  if (!isPlanId(plan)) redirect("/plans?error=plan");
  const back = (error: string) => redirect(`/checkout?plan=${plan}&error=${error}`);
  const token = await requireToken(`/checkout?plan=${plan}`);
  const fpTid = (await cookies()).get("_fprom_tid")?.value;

  // A payable home first (one pending reservation per signed-in, stepped-up customer; 202 means no capacity right now).
  const reserved = await cpRaw("/v1/billing/reserve", { token, body: {} }).catch(() => null);
  if (!reserved) back("checkout");
  if (reserved!.status === 202) redirect("/plans?error=capacity");
  if (reserved!.status === 403) redirect(`/security?next=${encodeURIComponent(`/checkout?plan=${plan}`)}`);
  if (reserved!.status === 404) redirect("/plans?error=closed");
  if (reserved!.status === 409) redirect("/plans?error=home");
  if (!reserved!.ok) back("checkout");

  const topupOn = formData.get("topupEnabled") === "on";
  const consent = {
    termsAccepted: formData.get("termsAccepted") === "on",
    recurringAuthorized: formData.get("recurringAuthorized") === "on",
    earlyStart: formData.get("earlyStart") === "on",
    billingCountry: field(formData, "billingCountry"),
    ...(field(formData, "postalCode").trim() ? { postalCode: field(formData, "postalCode").trim().slice(0, 20) } : {}),
    ...(field(formData, "taxId").trim() ? { taxId: field(formData, "taxId").trim() } : {}),
    renewalText: field(formData, "renewalText"),
    screenVersion: field(formData, "screenVersion"),
    documentVersions: { cloudTerms: field(formData, "docCloudTerms"), termsOfService: field(formData, "docTermsOfService"), privacyPolicy: field(formData, "docPrivacyPolicy") },
    ...(field(formData, "quoteId") ? { quoteId: field(formData, "quoteId") } : {}),
    topup: { enabled: topupOn, amountUsd: int(formData, "topupAmount"), thresholdUsd: int(formData, "topupThreshold"), capUsd: int(formData, "topupCap") },
    client: await clientClaims(),
  };
  if (!Number.isFinite(consent.topup.amountUsd) || !Number.isFinite(consent.topup.thresholdUsd) || !Number.isFinite(consent.topup.capUsd)) back("topup");

  let url: string | null = null;
  try {
    const res = await retryWhileBusy(() => cp<{ url?: string }>("/v1/billing/checkout", { token, body: { plan, consent, ...(fpTid ? { fp_tid: fpTid } : {}) } }));
    url = allowedRedirect(res.url);
  } catch (e) {
    if (e instanceof CPError) {
      if (e.code === "step_up_required") redirect(`/security?next=${encodeURIComponent(`/checkout?plan=${plan}`)}`);
      if (e.code === "consent_required") back("consent");
      if (e.code === "disclosure_stale") back("stale");
      if (e.code === "tax_unavailable") back("tax");
      if (e.code === "topup_invalid" || e.code === "topup_not_available") back("topup");
      if (e.code === "early_start_not_available") back("early");
      if (e.code === "checkout_in_progress") back("busy");
      if (e.code === "home_busy") back("plan_busy");
      if (e.code === "checkout_completed" || e.code === "already_subscribed") redirect("/cloud?notice=paid");
      if (e.status === 404) redirect("/plans?error=closed");
    }
    back("checkout");
  }
  if (!url) back("checkout");
  redirect(url!);
}
