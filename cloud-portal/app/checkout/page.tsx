import { redirect } from "next/navigation";
import { cp, CPError, type Disclosure } from "@/lib/cp";
import { config } from "@/lib/config";
import { countryOptions } from "@/lib/countries";
import { isPlanId } from "@/lib/plans";
import { requireToken } from "@/lib/session";
import { Clickwrap } from "./clickwrap";
import { payNow, quoteTax } from "./actions";

const ERRORS: Record<string, string> = {
  consent: "Both boxes must be ticked before you pay.",
  tax: "We couldn't calculate tax just now. Please try again in a moment.",
  stale: "The page was out of date (the dates, the price including tax, or our terms changed). Please read it again and tick the boxes.",
  busy: "Your checkout is already being set up. Wait a moment and try again.",
  checkout: "We could not start checkout. Try again.",
  plan_busy: "We are finishing another change to your plan. Try again in a moment.",
  topup: "Check the top-up amounts: the cap must be at least the top-up amount.",
  early: "Starting early is only for customers in the EU, EEA and UK.",
};

export default async function Checkout({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  if (!isPlanId(q.plan)) redirect("/plans?error=plan");
  await requireToken(`/checkout?plan=${q.plan}`);
  let disclosure: Disclosure;
  try {
    disclosure = await cp<Disclosure>(`/v1/legal/disclosure?plan=${q.plan}`);
  } catch (e) {
    if (e instanceof CPError) redirect("/plans?error=checkout");
    throw e;
  }
  return (
    <>
      <h1>{disclosure.planName}: confirm and pay</h1>
      {q.error && <p role="alert" className="error">{ERRORS[q.error] ?? ERRORS.checkout}</p>}
      <section className="card">
        <Clickwrap action={payNow} quote={quoteTax} disclosure={disclosure} countries={countryOptions()}
          links={{ cloudTerms: `${config.siteUrl}/cloud-terms`, termsOfService: `${config.siteUrl}/terms-of-service`, privacy: `${config.siteUrl}/privacy-policy` }} />
      </section>
    </>
  );
}
