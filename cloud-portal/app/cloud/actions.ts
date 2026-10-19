"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { allowedRedirect, cp, CPError } from "@/lib/cp";
import { retryWhileBusy } from "@/lib/retry";
import { requireToken } from "@/lib/session";

export async function manageBilling() {
  const token = await requireToken("/cloud");
  let url: string | null = null;
  try {
    url = allowedRedirect((await cp<{ url?: string }>("/v1/billing/portal", { token, body: {} })).url);
  } catch (e) {
    if (e instanceof CPError && e.status === 404) redirect("/cloud?error=closed");
    redirect("/cloud?error=billing");
  }
  if (!url) redirect("/cloud?error=billing");
  redirect(url);
}

/** One click, no support contact: the control plane tells Stripe to end the plan at the end of the paid period, and emails the confirmation
 *  once Stripe has confirmed it. "Cancelled" is shown only when the control plane says Stripe read back the cancellation; while it is still
 *  being done the action asks again a few times (each ask settles a failed request and sends a fresh one), then says it is processing. */
export async function cancelPlan() {
  const token = await requireToken("/cloud");
  let done = false;
  try {
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
      const res = await retryWhileBusy(() => cp<{ canceled?: boolean; processing?: boolean }>("/v1/account/cancel-plan", { token, body: {} }));
      done = res.canceled === true;
    }
  } catch (e) {
    if (e instanceof CPError && e.code === "already_canceled") redirect("/cloud?notice=cancelled");
    if (e instanceof CPError && e.code === "home_busy") redirect("/cloud?error=busy");
    redirect("/cloud?error=cancel");
  }
  redirect(done ? "/cloud?notice=cancelled" : "/cloud?notice=cancel_processing");
}

/** What the portal saw of the customer's request and where it came from (claims; the control plane records what it observed too). */
async function clientInfo() {
  const h = await headers();
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = h.get("x-real-ip")?.trim();
  const ip = fwd || real || undefined;
  const userAgent = h.get("user-agent")?.slice(0, 400);
  return { ...(ip ? { ip, ipSource: fwd ? "x-forwarded-for" : "x-real-ip" } : { ipSource: "unavailable" }), ...(userAgent ? { userAgent } : {}) };
}

/** Fresh acceptance of changed documents (after the 30-day notice). Binds to the versions the page showed. */
export async function acceptTerms(formData: FormData) {
  const token = await requireToken("/cloud");
  if (formData.get("termsAccepted") !== "on") redirect("/cloud?error=terms");
  const v = (k: string) => String(formData.get(k) ?? "");
  try {
    await cp("/v1/account/terms/accept", { token, body: { termsAccepted: true, client: await clientInfo(),
      documentVersions: { cloudTerms: v("docCloudTerms"), termsOfService: v("docTermsOfService"), privacyPolicy: v("docPrivacyPolicy") } } });
  } catch {
    redirect("/cloud?error=terms");
  }
  redirect("/cloud?notice=terms");
}

/** "Request my data": records the request. While it is open the day-14 deletion waits. */
export async function requestExport() {
  const token = await requireToken("/cloud");
  let state = "";
  try {
    state = (await cp<{ state?: string }>("/v1/account/export-request", { token, body: { client: await clientInfo() } })).state ?? "";
  } catch (e) {
    if (e instanceof CPError && e.code === "home_deleting") redirect("/cloud?error=export_deleting");
    redirect("/cloud?error=export");
  }
  redirect(state === "recorded_without_pause" ? "/cloud?notice=export_repeat" : "/cloud?notice=export");
}

/** Turn the auto top-up off, or change the amount, trigger or cap. */
export async function saveTopup(formData: FormData) {
  const token = await requireToken("/cloud");
  const n = (k: string) => Number.parseInt(String(formData.get(k) ?? ""), 10);
  const body = { enabled: formData.get("enabled") === "on", amountUsd: n("amountUsd"), thresholdUsd: n("thresholdUsd"), capUsd: n("capUsd"),
    client: await clientInfo() };
  try {
    await retryWhileBusy(() => cp("/v1/account/topup", { token, body }));
  } catch (e) {
    if (e instanceof CPError && e.code === "topup_invalid") redirect("/cloud?error=topup");
    if (e instanceof CPError && e.code === "home_busy") redirect("/cloud?error=busy");
    redirect("/cloud?error=billing");
  }
  redirect("/cloud?notice=topup");
}

/** Confirms the withdrawal in one step. The control plane records it, emails the acknowledgement and starts the refund. */
export async function confirmWithdrawal(formData: FormData) {
  const token = await requireToken("/cloud/withdraw");
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  try {
    const client = await clientInfo();
    await retryWhileBusy(() => cp("/v1/account/withdraw", { token, body: { confirm: true, ...(name ? { name } : {}), client } }));
  } catch (e) {
    if (e instanceof CPError && e.code === "home_busy") redirect("/cloud?error=busy");
    redirect("/cloud?error=withdraw");
  }
  redirect("/cloud?notice=withdrawn");
}
