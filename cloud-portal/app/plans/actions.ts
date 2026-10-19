"use server";
import { redirect } from "next/navigation";
import { twoFactorStatus } from "@/lib/cp";
import { isPlanId } from "@/lib/plans";
import { requireToken } from "@/lib/session";

/** Pick a plan. A confirmed second step comes first; then lane 1's checkout does the rest. */
export async function checkout(formData: FormData) {
  const plan = formData.get("plan");
  if (!isPlanId(plan)) redirect("/plans?error=plan");
  const token = await requireToken("/plans");
  const status = await twoFactorStatus(token).catch(() => null);
  if (!status) redirect("/sign-in?next=/plans");
  if (!status.enrolled || !status.verified) redirect(`/security?next=${encodeURIComponent("/plans")}`);

  // The clickwrap step: wording, both boxes and the consent record come next (app/checkout). It reserves the home and starts Stripe.
  redirect(`/checkout?plan=${plan}`);
}
