import Link from "next/link";
import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import { cp, CPError, type CloudSummary, type Home, type TermsStatus } from "@/lib/cp";
import { requireToken } from "@/lib/session";
import { acceptTerms, cancelPlan, manageBilling, requestExport, saveTopup } from "./actions";

const STATUS: Record<string, string> = {
  running: "Running", ready: "Running", stopped: "Stopped", stopping: "Stopping",
  creating: "Setting up", provisioning: "Setting up", pending: "Setting up", suspended: "Paused", deleting: "Being removed",
};
const label = (s: string) => STATUS[s.toLowerCase()] ?? "Checking";
const ERRORS: Record<string, string> = {
  closed: "Billing is not open yet. Please check back soon.",
  billing: "We could not open billing. Try again.",
  busy: "We are finishing another change to your plan. Try again in a moment.",
  cancel: "We could not cancel your plan just now. Try again.",
  export: "We could not record your data request. Try again.",
  topup: "Check the top-up amounts: the cap must be at least the top-up amount.",
  withdraw: "We could not record your withdrawal. Try again, or email support@murage.ai.",
  terms: "Tick the box to accept the updated terms, then press the button. If the page was out of date, read it again.",
  export_deleting: "Your Cloud is already being deleted, so there is no data left to export.",
};
const NOTICES: Record<string, string> = {
  cancelled: "Your plan is cancelled. It will not renew. We sent you an email to confirm.",
  cancel_processing: "We are still confirming your cancellation with our payment processor. Your plan is not cancelled until we email you to confirm it. Check back here in a few minutes, or press Cancel plan again.",
  export: "We recorded your data request. While it is open we do not delete your data. We email you when the export is sent.",
  topup: "Your top-up settings are saved.",
  withdrawn: "We received your withdrawal and emailed you an acknowledgement with the date and time. Your plan is cancelled.",
  terms: "Thank you. You accepted the updated terms.",
  export_repeat: "We recorded your data request. Your data is already due for deletion and your first request paused it once. A second request does not pause it again, but we still send you what we hold before deletion.",
  paid: "Your payment is being processed. Your plan shows here as soon as it is confirmed.",
};
const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "the end of the period you paid for");

export default async function MyCloud({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const token = await requireToken("/cloud");
  let homes: Home[];
  try {
    homes = (await cp<{ homes: Home[] }>("/v1/homes", { token })).homes;
  } catch (e) {
    if (e instanceof CPError && e.status === 401) redirect("/sign-in?next=/cloud");
    throw e;
  }
  let summary: CloudSummary | null = null;
  if (homes.length > 0) summary = await cp<CloudSummary>("/v1/account/cloud", { token }).catch(() => null);
  const sub = summary?.subscription ?? null;
  // Changed documents: asked again at the next sign-in (this page is where a signed-in customer lands).
  const terms = summary?.terms?.reacceptRequired ? await cp<TermsStatus>("/v1/account/terms", { token }).catch(() => null) : null;
  return (
    <>
      <h1>My Cloud</h1>
      {q.notice && NOTICES[q.notice] && <p role="status" className="ok" data-testid="notice">{NOTICES[q.notice]}</p>}
      {q.error && <p role="alert" className="error">{ERRORS[q.error] ?? ERRORS.billing}</p>}
      {terms?.reacceptRequired && (
        <section className="card" data-testid="reaccept">
          <h2>Our terms have changed</h2>
          <p className="small">We changed {terms.changed.map((c) => c.title).join(", ")}.{terms.effectiveAt ? ` We emailed you a copy. The new versions apply to your plan once you accept them, and not before ${day(terms.effectiveAt)}.` : " The new versions apply to your plan once you accept them."}</p>
          <p className="small" data-testid="reaccept-consequence">{terms.planEndsAt
            ? `You have not accepted them yet, so your plan ends on ${day(terms.planEndsAt)} and does not renew. Accept them before then and your plan carries on.`
            : terms.wording.nonAcceptance}</p>
          <form action={acceptTerms}>
            <input type="hidden" name="docCloudTerms" value={terms.current.cloudTerms} />
            <input type="hidden" name="docTermsOfService" value={terms.current.termsOfService} />
            <input type="hidden" name="docPrivacyPolicy" value={terms.current.privacyPolicy} />
            <label className="consent">
              <input type="checkbox" name="termsAccepted" />
              <span>I have read and agree to the updated <a href={`${config.siteUrl}/cloud-terms`} target="_blank" rel="noreferrer">Murage Cloud terms</a>,
                the <a href={`${config.siteUrl}/terms-of-service`} target="_blank" rel="noreferrer">Terms of Service</a> and
                the <a href={`${config.siteUrl}/privacy-policy`} target="_blank" rel="noreferrer">Privacy Policy</a></span>
            </label>
            <p className="fine">{terms.wording.arbitration}</p>
            <button type="submit" data-testid="reaccept-submit">Accept the updated terms</button>
          </form>
        </section>
      )}
      {homes.length === 0 ? (
        <section className="card" data-testid="no-home">
          <p>You do not have a Cloud yet.</p>
          <p><Link href="/plans">Pick a plan</Link></p>
        </section>
      ) : homes.map((home) => (
        <section key={home.id} className="card" data-testid="home">
          <h2>{home.name}</h2>
          <p>Status: <strong data-testid="home-status">{label(home.status)}</strong></p>
          {home.publicOrigin && label(home.status) === "Running"
            ? <p><a className="button" href={home.publicOrigin}>Open your home</a></p>
            : <p>You can open it once it is running.</p>}
        </section>
      ))}
      {summary && sub && (
        <section className="card" data-testid="plan">
          <h2>Your plan</h2>
          <p><strong data-testid="plan-name">{sub.planName}</strong>{sub.priceUsd ? `, $${sub.priceUsd} a month plus tax where it applies` : ""}</p>
          {sub.waitingForStart && <p data-testid="start-date">Your service starts on {day(sub.serviceStartsAt)}. You are not charged until then.</p>}
          {sub.cancelAtPeriodEnd
            ? <p data-testid="cancel-state">Cancelled. Your plan ends on {day(sub.activeUntil)} and will not renew.</p>
            : (
              <form action={cancelPlan}>
                <p className="small">Cancel any time, with one click. It ends your plan at the end of the period you paid for, and we confirm by email.</p>
                <button type="submit" data-testid="cancel-plan">Cancel plan</button>
              </form>
            )}
          <p className="small"><Link href="/cloud/confirmation" data-testid="confirmation-link">View your order confirmation</Link> (the contract copy we emailed you).</p>
          {sub.refundWindowEndsAt && <p className="small">Ask within 7 days of your first payment (until {day(sub.refundWindowEndsAt)}) and we refund your first month.</p>}
        </section>
      )}
      {summary?.withdrawal?.available && (
        <section className="card" data-testid="withdraw-card">
          <h2>Your right to withdraw</h2>
          <p className="small">If you are a consumer in the EU, EEA or UK you can withdraw from this contract until {day(summary.withdrawal.endsAt)}, without giving a reason.</p>
          <Link className="button" href="/cloud/withdraw" data-testid="withdraw-link">Withdraw from contract here</Link>
        </section>
      )}
      {summary && (
        <section className="card" data-testid="topup">
          <h2>Automatic top-up</h2>
          {summary.topup.available === false
            ? <p className="small" data-testid="topup-unavailable">Automatic top-up is not available for plans paid through Link (by Stripe). You can buy Flux credits yourself at any time.</p>
            : (
          <form action={saveTopup}>
            <label className="consent"><input type="checkbox" name="enabled" defaultChecked={summary.topup.enabled} />
              <span>Top up my Flux credits automatically</span></label>
            <div className="grid3">
              <div><label htmlFor="amountUsd">Top-up amount (USD)</label><input id="amountUsd" name="amountUsd" type="number" min={5} max={500} defaultValue={summary.topup.amountUsd} /></div>
              <div><label htmlFor="thresholdUsd">When balance falls below (USD)</label><input id="thresholdUsd" name="thresholdUsd" type="number" min={1} max={500} defaultValue={summary.topup.thresholdUsd} /></div>
              <div><label htmlFor="capUsd">Monthly cap (USD)</label><input id="capUsd" name="capUsd" type="number" min={5} max={2000} defaultValue={summary.topup.capUsd} /></div>
            </div>
            <p className="fine">The cap covers automatic top-up charges only, not your plan or credits you buy yourself. It resets at {summary.topup.capResets}.</p>
            {!summary.topup.applied && <p className="fine" data-testid="topup-pending">{summary.topup.enabled
              ? "Your settings are saved. Automatic top-up is not active yet: it starts once Flux confirms it, and never charges more than you set here."
              : "Your settings are saved. We are applying the change in Flux now; we are alerted if it does not go through."}</p>}
            <button type="submit">Save top-up settings</button>
          </form>
            )}
        </section>
      )}
      {summary && (
        <section className="card" data-testid="export">
          <h2>Your data</h2>
          {summary.exportRequest?.status === "open"
            ? (summary.exportRequest.pausesDeletion === false
              ? <p data-testid="export-open">Data request open since {day(summary.exportRequest.requestedAt)}. A second request does not pause it again, but we still send you what we hold before deletion.</p>
              : <p data-testid="export-open">Data request open since {day(summary.exportRequest.requestedAt)}. We do not delete your data while it is open. We send the export within 7 days.</p>)
            : (
              <form action={requestExport}>
                <p className="small">Ask for a copy of your data. We send it within 7 days, and we do not delete anything while your request is open.</p>
                <button type="submit" data-testid="request-export">Request my data</button>
              </form>
            )}
        </section>
      )}
      <form action={manageBilling}>
        <button type="submit">Manage billing</button>
      </form>
      <p className="small">Billing opens on Stripe: change your card and see your invoices there.</p>
    </>
  );
}
