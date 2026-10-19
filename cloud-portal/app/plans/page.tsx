import { PLANS } from "@/lib/plans";
import { getToken } from "@/lib/session";
import { checkout } from "./actions";

const ERRORS: Record<string, string> = {
  closed: "Checkout is not open yet. Please check back soon.",
  checkout: "We could not start checkout. Try again.",
  plan: "Pick one of the plans below.",
  capacity: "We are full right now. You are on the waiting list and we will email you when a place opens.",
  home: "You already have a cloud computer. Manage it from My Cloud.",
};

export default async function Plans({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const signedIn = Boolean(await getToken());
  return (
    <>
      <h1>Pick a plan</h1>
      <p>Your own computer in the cloud, ready from your phone. Billed monthly. Cancel any time.</p>
      {q.error && <p role="alert" className="error">{ERRORS[q.error] ?? ERRORS.checkout}</p>}
      <div className="plans">
        {PLANS.map((plan) => (
          <article key={plan.id} className="card plan" data-plan={plan.id}>
            <h2>{plan.name}</h2>
            <p className="price"><strong>${plan.priceUsd}</strong> a month</p>
            <ul>
              {plan.specs.map((s) => <li key={s}>{s}</li>)}
              <li>${plan.fluxCreditUsd} of Flux credits every month</li>
            </ul>
            <form action={checkout}>
              <input type="hidden" name="plan" value={plan.id} />
              <button type="submit" aria-label={`Check out ${plan.name}`}>{signedIn ? "Check out" : "Sign in to check out"}</button>
            </form>
          </article>
        ))}
      </div>
      <p className="small">You add a second step (a passkey or security key) before you pay. Refunds follow our terms. Customers in the EU get 14 days.</p>
    </>
  );
}
