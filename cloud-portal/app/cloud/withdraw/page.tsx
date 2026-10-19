import Link from "next/link";
import { redirect } from "next/navigation";
import { cp, type CloudSummary } from "@/lib/cp";
import { requireToken } from "@/lib/session";
import { confirmWithdrawal } from "../actions";

/** Directive 2023/2673 withdrawal function, step two: the statement and one confirm button. Signed-in customers only: the session already identifies the contract. */
export default async function Withdraw() {
  const token = await requireToken("/cloud/withdraw");
  const summary = await cp<CloudSummary>("/v1/account/cloud", { token }).catch(() => null);
  if (!summary?.withdrawal?.available) redirect("/cloud");
  return (
    <>
      <h1>Withdraw from your contract</h1>
      <section className="card">
        <p>You are withdrawing from your Murage Cloud contract. Your plan is cancelled and we refund what the terms say you get back, within 14 days, to the way you paid.</p>
        <form action={confirmWithdrawal}>
          <label htmlFor="name">Your name (optional)</label>
          <input id="name" name="name" autoComplete="name" maxLength={120} />
          <button type="submit" data-testid="confirm-withdraw">Confirm withdrawal here</button>
        </form>
        {summary.trader && <p className="fine" data-testid="trader">You withdraw from your contract with {summary.trader.name}, {summary.trader.address}.<br />Support: {summary.trader.email} (we reply within 2 working days){summary.trader.phone ? <><br />Phone (legal and contract notices only, no support by phone): {summary.trader.phone}</> : null}</p>}
        <p className="small"><Link href="/cloud">Not now, back to My Cloud</Link></p>
      </section>
    </>
  );
}
