"use client";
import { useEffect, useRef, useState } from "react";
import type { Disclosure } from "@/lib/cp";

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  /** Prices the plan (and the top-up amount) at this address with Stripe Tax, on the control plane. */
  quote: (input: { plan: string; country: string; postalCode: string; topupAmountUsd: number }) => Promise<Disclosure | null>;
  disclosure: Disclosure;
  countries: { code: string; name: string }[];
  links: { cloudTerms: string; termsOfService: string; privacy: string };
};
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Field order follows plans/cloud-legal/CHECKOUT.md: renewal block first (before any card field), then billing country, postal code and tax
 *  ID, the renewal block again beside the boxes WITH THE TOTAL INCLUDING TAX (priced by Stripe Tax for this address before anything is
 *  ticked), the two required boxes, the arbitration line, the EU start-now box, the optional top-up box with its total including tax. */
/** Shown when the tax quote failed twice. There is no checkout without a quote, so pay stays disabled. */
export const TAX_FAILED = "We couldn't calculate tax just now. Please try again in a moment.";

function TraderBlock({ t }: { t: { name: string; address: string; email: string; phone: string | null } }) {
  // Plain text, signed-in pages only: the phone comes from the control plane's LEGAL_PHONE secret and is left out when unset.
  return (
    <p className="fine" data-testid="trader">Seller: {t.name}, {t.address}.<br />Support: {t.email} (we reply within 2 working days){t.phone ? <><br />Phone (legal and contract notices only, no support by phone): {t.phone}</> : null}</p>
  );
}

export function Clickwrap({ action, quote, disclosure: base, countries, links }: Props) {
  const [country, setCountry] = useState("US");
  const [postal, setPostal] = useState("");
  const [terms, setTerms] = useState(false);
  const [recurring, setRecurring] = useState(false);
  const [early, setEarly] = useState(false);
  const [topup, setTopup] = useState(false);
  const [amount, setAmount] = useState(base.topupDefaults.amountUsd);
  const [threshold, setThreshold] = useState(base.topupDefaults.thresholdUsd);
  const [cap, setCap] = useState(base.topupDefaults.capUsd);
  const [priced, setPriced] = useState<Disclosure | null>(null);
  const [pricing, setPricing] = useState<"idle" | "busy" | "failed">("busy");
  const seq = useRef(0);
  // Re-price whenever the address or the top-up amount changes. The pay button waits for a price for exactly these inputs.
  useEffect(() => {
    const n = ++seq.current;
    setPricing("busy");
    const t = setTimeout(async () => {
      const d = Number.isFinite(amount) && amount >= 5 && amount <= 500
        ? await quote({ plan: base.plan, country, postalCode: postal.trim(), topupAmountUsd: amount }).catch(() => null) : null;
      if (n !== seq.current) return;
      setPriced(d); setPricing(d ? "idle" : "failed");
    }, 350);
    return () => clearTimeout(t);
  }, [country, postal, amount, base.plan, quote]);
  const d = priced ?? base;
  const tax = priced?.tax ?? null;
  const taxed = tax && tax.source === "stripe_tax" && tax.totalCents !== null && tax.taxCents !== null;
  // Outside the US Link (by Stripe) is the merchant of record (Managed Payments): Link prices the tax, and may present the price in local
  // currency, on its own payment page; our page names the seller and shows no total in a currency the customer will not see.
  const managed = priced !== null && tax?.source === "managed_payments";
  const topupOffered = !managed && (d.topupAvailable ?? true);
  const eu = d.euCountries.includes(country);
  const variant = eu && !early ? d.variants.delayed : d.variants.immediate;
  const topupTotal = taxed && tax.topupTotalCents !== null ? `${usd(tax.topupTotalCents)} including tax` : `$${amount} plus tax where it applies`;
  const fill = (t: string) => t.replaceAll("${total}", topupTotal).replaceAll("${amount}", `$${amount}`).replaceAll("${threshold}", `$${threshold}`).replaceAll("${cap}", `$${cap}`);
  // The statement exists only once Stripe Tax has priced it: until then (or after a failure) there is nothing to agree to and pay stays off.
  const text = taxed || managed ? variant.renewalText : null;
  // The head (price, today's total and currency, exchange rates) is bold; the cancel and refund promises follow.
  const cut = text ? text.indexOf(" Cancel any time") : -1;
  const renewal = (id: string) => (
    <div className="renewal" data-testid={id} role="note">
      {text ? <><strong>{text.slice(0, cut)}</strong>{text.slice(cut)}</> : pricing === "failed" ? TAX_FAILED : "Working out your total including tax…"}
    </div>
  );
  const ready = pricing === "idle" && priced !== null && Boolean(taxed || managed);
  return (
    <form action={action}>
      <input type="hidden" name="plan" value={d.plan} />
      <input type="hidden" name="screenVersion" value={d.screenVersion} />
      <input type="hidden" name="renewalText" value={text ?? ""} />
      <input type="hidden" name="quoteId" value={tax?.quoteId ?? ""} />
      <input type="hidden" name="docCloudTerms" value={d.versions.cloudTerms} />
      <input type="hidden" name="docTermsOfService" value={d.versions.termsOfService} />
      <input type="hidden" name="docPrivacyPolicy" value={d.versions.privacyPolicy} />

      {renewal("renewal-top")}

      <label htmlFor="billingCountry">Billing country</label>
      <select id="billingCountry" name="billingCountry" value={country} onChange={(e) => { setCountry(e.target.value); setEarly(false); }}>
        {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
      <label htmlFor="postalCode">Postal code</label>
      <input id="postalCode" name="postalCode" autoComplete="postal-code" maxLength={20} value={postal} onChange={(e) => setPostal(e.target.value)} />
      <label htmlFor="taxId">Tax ID (business customers, optional)</label>
      <input id="taxId" name="taxId" autoComplete="off" maxLength={40} />
      <p className="fine" data-testid="tax-line">
        {pricing === "busy" ? "Working out the tax for your address…"
          : pricing === "failed" ? TAX_FAILED
          : taxed ? `${base.planName}: ${usd(tax.priceCents)} plus ${usd(tax.taxCents!)} tax = ${usd(tax.totalCents!)} a month. Due today: ${usd(variant.dueTodayCents ?? 0)}.`
            : managed ? (d.sellerLine ?? "") : ""}
      </p>

      {renewal("renewal-box")}

      <label className="consent">
        <input type="checkbox" name="termsAccepted" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
        <span>I have read and agree to the <a href={links.cloudTerms} target="_blank" rel="noreferrer">Murage Cloud terms</a>,
          the <a href={links.termsOfService} target="_blank" rel="noreferrer">Terms of Service</a> and
          the <a href={links.privacy} target="_blank" rel="noreferrer">Privacy Policy</a></span>
      </label>
      <label className="consent">
        <input type="checkbox" name="recurringAuthorized" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
        <span>{d.wording.authorization}</span>
      </label>
      <p className="fine" data-testid="arbitration">{d.wording.arbitration}</p>

      {eu && (
        <div data-testid="eu-block">
          <label className="consent">
            <input type="checkbox" name="earlyStart" checked={early} onChange={(e) => setEarly(e.target.checked)} />
            <span>{d.wording.earlyStart}</span>
          </label>
          <p className="fine">{d.wording.nearEarlyStart}</p>
        </div>
      )}

      {topupOffered && <>
      <label className="consent">
        <input type="checkbox" name="topupEnabled" checked={topup} onChange={(e) => setTopup(e.target.checked)} />
        <span data-testid="topup-text">{fill(d.wording.topupBox)}</span>
      </label>
      <div className="grid3">
        <div><label htmlFor="topupAmount">Top-up amount (USD)</label>
          <input id="topupAmount" name="topupAmount" type="number" min={5} max={500} step={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></div>
        <div><label htmlFor="topupThreshold">When balance falls below (USD)</label>
          <input id="topupThreshold" name="topupThreshold" type="number" min={1} max={500} step={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></div>
        <div><label htmlFor="topupCap">Monthly cap (USD)</label>
          <input id="topupCap" name="topupCap" type="number" min={5} max={2000} step={1} value={cap} onChange={(e) => setCap(Number(e.target.value))} /></div>
      </div>
      {topup && <p className="fine" data-testid="topup-charge">{fill(d.wording.topupCharge)}</p>}
      </>}
      {!topupOffered && <>
        <input type="hidden" name="topupAmount" value={amount} /><input type="hidden" name="topupThreshold" value={threshold} /><input type="hidden" name="topupCap" value={cap} />
        <p className="fine" data-testid="topup-unavailable">Automatic top-up is not available when Link is the merchant of record. You can buy Flux credits from your account page.</p>
      </>}

      {priced?.trader && <TraderBlock t={priced.trader} />}
      <button type="submit" disabled={!(terms && recurring && ready)} data-testid="pay">Continue to payment</button>
      <p className="small">Next: {managed ? "Link (by Stripe) shows your total including tax and takes your payment." : "Stripe takes your card."} We start your server as soon as the payment goes through{eu && !early ? `, on ${d.variants.delayed.startDate}` : ""}.</p>
    </form>
  );
}
