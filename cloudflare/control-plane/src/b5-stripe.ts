// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal Stripe client (form-encoded REST over an injectable fetch) and webhook signature verification.
import { sessionParams, type SellerKind, type SessionInput } from "./seller";
import type { BillingConfig } from "./b5-config";
import type { SessionLineItem } from "./checkout-moments";

export type StripeFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
/** Stripe's documented request timeout: its own client libraries give up on a request after 80 seconds (stripe-node `timeout`, default 80000). */
export const STRIPE_REQUEST_TIMEOUT_MS = 80_000;
export class StripeError extends Error {
  /** replayed: Stripe answered from its idempotency cache (Idempotent-Replayed: true): the original request finished with this answer.
   *  A replayed 4xx proves the key created nothing; a replayed 5xx stays indeterminate (b5-billing.ts indeterminateStripeOutcome). inFlight: Stripe is still processing the original request under that key (409
   *  idempotency_key_in_use); its outcome is not known yet. requestId: Stripe's request id, for the record. type: Stripe's error type
   *  (error.type: idempotency_error, invalid_request_error, api_error, ...), kept so a caller can tell a refusal that PROVES an idempotency
   *  key is spent (idempotency_error) from a validation refusal that saved nothing under the key (Astra JOURNEY-B-4 #1). */
  constructor(public readonly status: number, public readonly code: string,
    public readonly meta: { replayed?: boolean; inFlight?: boolean; requestId?: string | null; type?: string | null } = {}) { super(code); }
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const SIGNATURE_TOLERANCE_S = 300;

/** Stripe-Signature: t=<unix>,v1=<hmac>[,v1=...]. HMAC-SHA256 over `${t}.${rawBody}`. */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowMs: number): Promise<void> {
  if (!header) throw new StripeError(400, "signature_missing");
  let t = ""; const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("="); if (i < 0) continue;
    const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
    if (k === "t") t = v; else if (k === "v1") v1.push(v);
  }
  if (!/^\d{1,12}$/.test(t) || v1.length === 0) throw new StripeError(400, "signature_malformed");
  if (Math.abs(nowMs / 1000 - Number(t)) > SIGNATURE_TOLERANCE_S) throw new StripeError(400, "signature_stale");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`)));
  if (!v1.some((candidate) => equalHex(candidate.toLowerCase(), expected))) throw new StripeError(400, "signature_invalid");
}
/** Test helper and the only signing code: produces a valid header for a body. */
export async function signStripePayload(rawBody: string, secret: string, tSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t=${tSeconds},v1=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${tSeconds}.${rawBody}`)))}`;
}

/** THE Stripe API version, for every request on both seller paths (Ferrox direct and Link / Managed Payments) and for the webhook endpoint.
 *  Managed Payments needs 2025-03-31.basil or later (https://docs.stripe.com/payments/managed-payments/update-checkout). Basil's invoice
 *  changes are read through the normalizers below: invoice.payment_intent / invoice.charge are gone (invoice.payments, InvoicePayment:
 *  https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices), invoice.subscription moved to
 *  invoice.parent.subscription_details.subscription and line.price to line.pricing.price_details.price
 *  (https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects,
 *  https://docs.stripe.com/changelog/basil/2025-03-31/invoice-pricing-configurations), invoice.tax to invoice.total_taxes
 *  (https://docs.stripe.com/changelog/basil/2025-03-31/invoice-tax-configurations), the subscription's current period to its items
 *  (https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end), GET /v1/invoices/upcoming to
 *  POST /v1/invoices/create_preview (https://docs.stripe.com/changelog/basil/2025-03-31/invoice-preview-api-deprecations), and the checkout
 *  session reports the customer's Adaptive Pricing payment in presentment_details
 *  (https://docs.stripe.com/changelog/basil/2025-03-31/add_presentment_details). The normalizers also read the pre-Basil field names, so a
 *  stored older event is still understood, but every request is pinned to this version. */
export const STRIPE_API_VERSION = "2025-03-31.basil";

type Obj = Record<string, unknown>;
/** Subscription states that still bill (or may): a customer with one is never re-addressed by a checkout. */
const LIVE_SUBSCRIPTION = new Set(["active", "trialing", "past_due", "unpaid", "paused", "incomplete"]);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? (v && typeof v === "object" ? str((v as Obj).id) : null);
const rec = (v: unknown): Obj => (v && typeof v === "object" ? v as Obj : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(rec) : []);
const sumAmounts = (v: unknown) => arr(v).reduce((n, t) => n + (num(t.amount) ?? 0), 0);

/** source: "subscription" = a subscription item line (a renewal or a subscription proration); "invoice_item" = an invoice item (Basil
 *  parent.invoice_item_details, or the older type "invoiceitem"), which is never a renewal. */
export interface InvoiceLineView { price: string | null; proration: boolean; subscription: string | null; item: string | null;
  source: "subscription" | "invoice_item" | null; period: { start: number | null; end: number | null }; amount: number | null;
  /** Astra JOURNEY-BCORE-3 #5-#8: the line as recorded for a post-promise charge (never an amount computation): its id, words, currency, its OWN
   *  tax amounts (Basil taxes[], older tax_amounts[]: amount, inclusive, taxable amount, rate), its discounts (discount_amounts[], Basil
   *  pretax_credit_amounts[]) and the recurring usage type when the line itself carries it (Basil lines usually carry the price id only). */
  id?: string | null; description?: string | null; currency?: string | null;
  taxes?: { amount: number; inclusive: boolean | null; taxableAmount: number | null; rate: string | null }[];
  discounts?: { amount: number; discount: string | null }[];
  usageType?: string | null }
export interface InvoiceView { id: string; status: string | null; amount_paid: number; amount_due: number | null; auto_advance: boolean | null;
  subscription: string | null; billing_reason: string | null; payment_intent: string | null; tax: number; created: number; lines: { data: InvoiceLineView[]; has_more: boolean };
  subscriptionMetadata: Obj;
  /** Stripe's own collection time (status_transitions.paid_at, Unix seconds); null when not paid or not given. */
  paid_at?: number | null;
  /** The invoice's currency and total (recorded with a post-promise charge, never computed from). */
  currency?: string | null; total?: number | null }
/** One invoice line, Basil (pricing.price_details.price, parent.subscription_item_details) or older (price.id, proration, subscription). */
export function invoiceLineView(raw: unknown): InvoiceLineView {
  const l = rec(raw);
  const pricing = rec(l.pricing); const parent = rec(l.parent);
  // Basil: parent.subscription_item_details OR parent.invoice_item_details, each with its own proration flag and subscription.
  const item = rec(parent.subscription_item_details); const invItem = rec(parent.invoice_item_details);
  const price = str(rec(pricing.price_details).price) ?? idOf(l.price);
  const period = rec(l.period);
  const isInvItem = str(parent.type) === "invoice_item_details" || Object.keys(invItem).length > 0 || str(l.type) === "invoiceitem";
  const isSubItem = !isInvItem && (str(parent.type) === "subscription_item_details" || Object.keys(item).length > 0 || str(l.type) === "subscription");
  return { price, proration: item.proration === true || invItem.proration === true || l.proration === true,
    subscription: str(item.subscription) ?? str(invItem.subscription) ?? idOf(l.subscription),
    item: str(item.subscription_item) ?? idOf(l.subscription_item), source: isInvItem ? "invoice_item" : isSubItem ? "subscription" : null,
    period: { start: num(period.start), end: num(period.end) }, amount: num(l.amount),
    id: str(l.id), description: str(l.description), currency: str(l.currency),
    taxes: [...arr(l.taxes).map((t) => ({ amount: num(t.amount) ?? 0, inclusive: str(t.tax_behavior) === null ? null : str(t.tax_behavior) === "inclusive",
      taxableAmount: num(t.taxable_amount), rate: idOf(rec(t.tax_rate_details).tax_rate) ?? str(t.type) })),
    ...arr(l.tax_amounts).map((t) => ({ amount: num(t.amount) ?? 0, inclusive: typeof t.inclusive === "boolean" ? t.inclusive : null, taxableAmount: num(t.taxable_amount), rate: idOf(t.tax_rate) }))],
    discounts: [...arr(l.discount_amounts).map((x) => ({ amount: num(x.amount) ?? 0, discount: idOf(x.discount) })),
      ...arr(l.pretax_credit_amounts).filter((x) => str(x.type) === "discount").map((x) => ({ amount: num(x.amount) ?? 0, discount: idOf(x.discount) }))],
    usageType: str(rec(rec(l.price).recurring).usage_type) ?? str(rec(rec(pricing.price_details).recurring).usage_type) };
}
/** The payment intent that paid an invoice: Basil's invoice.payments (a paid InvoicePayment of type payment_intent), or the old field. */
export function invoicePaymentIntent(raw: unknown): string | null {
  const inv = rec(raw);
  const payments = arr(rec(inv.payments).data).map((p) => ({ status: str(p.status), payment: rec(p.payment) }))
    .filter((p) => (str(p.payment.type) ?? "payment_intent") === "payment_intent" && p.payment.payment_intent);
  const paid = payments.find((p) => p.status === "paid") ?? payments.find((p) => p.status !== "canceled");
  return (paid ? idOf(paid.payment.payment_intent) : null) ?? idOf(inv.payment_intent);
}
/** An invoice in one shape whatever the API version that produced it (see STRIPE_API_VERSION). */
export function invoiceView(raw: unknown): InvoiceView {
  const inv = rec(raw);
  const subDetails = rec(rec(inv.parent).subscription_details);
  const taxes = Array.isArray(inv.total_taxes) ? sumAmounts(inv.total_taxes) : num(inv.tax) ?? sumAmounts(inv.total_tax_amounts);
  return { id: str(inv.id) ?? "", status: str(inv.status), amount_paid: num(inv.amount_paid) ?? 0, amount_due: num(inv.amount_due),
    auto_advance: typeof inv.auto_advance === "boolean" ? inv.auto_advance : null, subscription: str(subDetails.subscription) ?? idOf(inv.subscription),
    billing_reason: str(inv.billing_reason), payment_intent: invoicePaymentIntent(inv), tax: taxes, created: num(inv.created) ?? 0,
    lines: { data: arr(rec(inv.lines).data).map(invoiceLineView), has_more: rec(inv.lines).has_more === true }, subscriptionMetadata: rec(subDetails.metadata ?? rec(inv.subscription_details).metadata),
    paid_at: num(rec(inv.status_transitions).paid_at), currency: str(inv.currency), total: num(inv.total) };
}
/** The subscription's current period: Basil keeps it on the subscription items, older versions on the subscription. */
export function subscriptionPeriod(raw: unknown): { start: number | null; end: number | null } {
  const s = rec(raw);
  const item = arr(rec(s.items).data)[0] ?? {};
  return { start: num(item.current_period_start) ?? num(s.current_period_start), end: num(item.current_period_end) ?? num(s.current_period_end) };
}
function subscriptionView(raw: Obj) {
  const p = subscriptionPeriod(raw);
  return { id: str(raw.id) ?? "", status: str(raw.status), cancel_at_period_end: typeof raw.cancel_at_period_end === "boolean" ? raw.cancel_at_period_end : null,
    trial_end: num(raw.trial_end), current_period_start: p.start, current_period_end: p.end,
    cancel_at: num(raw.cancel_at), pause_collection: str(rec(raw.pause_collection).behavior), billing_cycle_anchor: num(raw.billing_cycle_anchor),
    customer: idOf(raw.customer), schedule: idOf(raw.schedule) };
}
/** What the customer actually paid at checkout: Adaptive Pricing's presentment amount and currency when Stripe presented another currency,
 *  else the session's own amount (then the session currency IS the currency charged). The integration amounts stay for refund accounting. */
export function checkoutCharged(session: unknown): { amount: number | null; currency: string; presented: boolean } {
  const s = rec(session); const pd = rec(s.presentment_details);
  const amount = num(pd.presentment_amount); const currency = str(pd.presentment_currency);
  const integration = (str(s.currency) ?? "usd").toLowerCase();
  if (amount !== null && currency && currency.toLowerCase() !== integration) return { amount, currency: currency.toLowerCase(), presented: true };
  return { amount: num(s.amount_total), currency: integration, presented: false };
}

type Form = Record<string, string | number | boolean | undefined | null>;
function encode(form: Form): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== null) params.append(k, String(v));
  return params.toString();
}
/** The body of a checkout customer created for ONE checkout attempt (POST /v1/customers; b5-billing.ts switchCheckoutCustomer): the
 *  declared location as the new customer's WHOLE address (country and postal code, nothing else: no street, city or state of an earlier
 *  attempt can sit beside it), the account's email and the previous customer's name, and metadata naming the home, the consent and the
 *  attempt (its idempotency key), so an orphan left by a lost answer can be found at Stripe by `metadata[checkout_attempt]`. Encoded once,
 *  journaled as is and sent as is (postCustomerCreate), so a replay is the identical request under the identical key. */
export function customerCreateBody(i: { email: string | null; name: string | null; homeId: string; fpTid: string | null; consentId: string; attempt: string;
  country: string; postalCode: string | null }): string {
  return encode({ email: i.email, name: i.name, "metadata[home_id]": i.homeId, "metadata[fp_tid]": i.fpTid, "metadata[consent_id]": i.consentId,
    "metadata[checkout_attempt]": i.attempt, "address[country]": i.country, "address[postal_code]": i.postalCode });
}

/** Astra TAXCOUNTRY-7 P2-d: the body of a home's FIRST customer (the first checkout, or a purchase bootstrap), encoded once, journaled before
 *  the call (b5-billing.ts journalFirstCreate) and sent as is (postCustomerCreate), so the sweep's replay under the same key is the identical
 *  request. The same fields createCustomer always sent, plus `metadata[customer_create]` (the idempotency key) so an orphan left by a lost
 *  answer can be found at Stripe. */
export function firstCustomerBody(i: { email?: string | null; homeId: string; fpTid?: string | null; country?: string | null; postalCode?: string | null;
  createKey: string }): string {
  return encode({ email: i.email ?? undefined, "metadata[home_id]": i.homeId, "metadata[fp_tid]": i.fpTid ?? undefined, "metadata[customer_create]": i.createKey,
    "address[country]": i.country ?? undefined, "address[postal_code]": i.postalCode ?? undefined });
}
/** Astra TAXCOUNTRY-7 P2-c: the body of a VERIFIED customer's own move of its billing location (b5-billing.ts moveHolderLocation): the
 *  declared location as the customer's whole address (the other address fields unset, so no street of the old country stays beside it). */
export function customerMoveBody(i: { country: string; postalCode: string | null; moveKey: string }): string {
  return encode({ "address[country]": i.country, "address[postal_code]": i.postalCode ?? "", "address[line1]": "", "address[line2]": "", "address[city]": "",
    "address[state]": "", "metadata[location_move]": i.moveKey });
}

export interface StripeClient {
  /** `country` / `postalCode` are the DECLARED billing location (the consent), set as the customer's address so Stripe's first tax estimate
   *  on the Checkout page is the declared country's, not one guessed from the session locale (see prepareCheckoutCustomer in b5-billing.ts). */
  createCustomer(input: { email?: string; homeId: string; fpTid?: string; country?: string; postalCode?: string | null }, idempotencyKey: string): Promise<{ id: string }>;
  /** POST /v1/customers with `body` EXACTLY as journaled (customerCreateBody), under `idempotencyKey`: Stripe executes a key at most once and
   *  answers every later request under it (same parameters) with the saved result, so a replay returns the SAME customer. `replayed`: the
   *  answer came from Stripe's idempotency cache. */
  postCustomerCreate(body: string, idempotencyKey: string): Promise<{ id: string; replayed: boolean; requestId: string | null }>;
  /** POST /v1/customers/{id} with `body` exactly as journaled (customerMoveBody), under `idempotencyKey`. */
  postCustomerUpdate(id: string, body: string, idempotencyKey: string): Promise<{ id: string; replayed: boolean; requestId: string | null }>;
  /** The customer's stored billing location, whether a subscription that still bills is on it (GET /v1/customers/{id} with
   *  expand[]=subscriptions: Stripe lists the customer's subscriptions that are not canceled), and what of the customer's own money or
   *  instrument it holds: `balance` (the customer credit balance, minor units; null when Stripe sent none), the default payment method
   *  (invoice_settings.default_payment_method) and the default source (default_source). `deleted`: Stripe answered with a deleted customer. */
  customerTaxState(id: string): Promise<{ country: string | null; postalCode: string | null; liveSubscription: boolean; balance: number | null;
    defaultPaymentMethod: string | null; defaultSource: string | null; deleted: boolean; email: string | null; name: string | null }>;
  /** Whether an invoice of this customer is still draft or open (a draft follows the customer's address; GET /v1/invoices status=draft|open). */
  customerHasPendingInvoice(id: string): Promise<boolean>;
  /** Whether ANY credit note was ever issued to this customer (GET /v1/credit_notes?customer=&limit=1). */
  customerHasCreditNotes(id: string): Promise<boolean>;
  /** Whether ANY saved instrument is attached to this customer, default or not (Astra TAXCOUNTRY-6 P2-b: a SetupIntent attaches a card
   *  without making it a default): GET /v1/payment_methods?customer= (every type) and GET /v1/customers/{id}/sources (legacy cards, bank
   *  accounts), limit 1 each. A listing without a `data` array throws (fail closed: an unreadable answer never proves "nothing here"). */
  customerHasInstruments(id: string): Promise<boolean>;
  createCheckoutSession(input: SessionInput & { seller?: SellerKind },
    idempotencyKey: string): Promise<{ id: string; url: string; /** made by an earlier request under this key (Idempotent-Replayed) */ replayed?: boolean }>;
  /** Checkout sessions of one customer (newest first), to find open ones to expire and completed ones still waiting for their webhook. */
  listCheckoutSessions(customerId: string): Promise<{ data: { id: string; status: string | null; subscription: string | null;
    expires_at?: number | null; metadata?: Record<string, string> | null }[] }>;
  /** EVERY checkout session of one customer: all pages (has_more / starting_after), never the first page alone (Astra TRUSTCODE-2 P2-2).
   *  A listing that cannot be completed throws (StripeError), so a caller deciding "every session is terminal" fails closed. */
  listAllCheckoutSessions(customerId: string): Promise<{ id: string; status: string | null; subscription?: string | null; url?: string | null; expires_at?: number | null; metadata?: Record<string, string> | null }[]>;
  expireCheckoutSession(id: string): Promise<{ id: string; status: string | null }>;
  /** One checkout session as Stripe holds it now (Astra JOURNEY-A-5 #4: a durable session id recovers the customer it was made for). */
  getCheckoutSession(id: string): Promise<{ id: string; status: string | null; customer: string | null; metadata?: Record<string, string> | null }>;
  /** The invoice of one checkout session, read from Stripe itself (the session with its invoice expanded): the id whether Stripe answers
   *  with the id or the whole object; null when the session has no invoice (yet). */
  checkoutSessionInvoice(id: string): Promise<string | null>;
  /** The REAL line items of one checkout session, read from Stripe (GET /v1/checkout/sessions/{id}/line_items), normalized: what the
   *  customer is subscribed to, never the metadata's plan label. More than one page (has_more) is returned as read; the caller refuses
   *  anything but exactly one item. */
  checkoutSessionLineItems(id: string): Promise<SessionLineItem[]>;
  /** Paid invoices of a subscription (to settle an unknown payment state from Stripe, not from a missing webhook), normalized (invoiceView). */
  listPaidInvoices(subscriptionId: string): Promise<{ data: InvoiceView[] }>;
  /** Refunds already made on a payment, to settle an ambiguous refund attempt by its op id before trying again. */
  listRefunds(paymentIntent: string): Promise<{ data: { id: string; amount: number; status: string | null; payment_intent?: string | null; metadata?: Record<string, string> | null;
    created?: number | null }[] }>;
  /** Move the first charge (and every renewal anchor) to the service start date. */
  setTrialEnd(subscriptionId: string, trialEndSeconds: number): Promise<{ id: string }>;
  /** Stripe Tax: the tax for the plan price (and the top-up amount) at this address, before anything is charged. */
  createTaxCalculation(input: { country: string; postalCode?: string; lines: { reference: string; amountCents: number }[] }):
    Promise<{ id: string | null; amount_total: number; tax_amount_exclusive: number;
      line_items?: { data?: { reference: string | null; amount: number; amount_tax: number }[] };
      tax_breakdown?: { amount: number; taxability_reason?: string | null }[] }>;
  createPortalSession(input: { customerId: string; returnUrl: string; configuration?: string }): Promise<{ url: string }>;
  /** The live invoice, read with its payments expanded and normalized (invoiceView): payment_intent comes from invoice.payments. */
  getInvoice(id: string): Promise<InvoiceView>;
  /** Journey A4: a customer's invoices as the account page lists them, newest first, one page (24). Drafts are never returned. */
  listCustomerInvoices(customerId: string): Promise<CustomerInvoice[]>;
  /** Journey A4: one invoice as the account page shows it, with its hosted link and PDF; null if Stripe has no such invoice. */
  getCustomerInvoice(id: string): Promise<CustomerInvoice | null>;
  /** The invoice a payment intent paid (Basil: the InvoicePayment object; a payment with no invoice, e.g. a one-off charge, gives null). */
  invoiceOfPayment(paymentIntent: string): Promise<string | null>;
  /** Turns automatic collection on or off for an invoice. A draft with auto_advance=false stays a draft until it is finalized by hand
   *  (https://docs.stripe.com/invoicing/integration/automatic-advancement-collection). */
  setInvoiceAutoAdvance(id: string, autoAdvance: boolean, idempotencyKey: string): Promise<{ id: string; status?: string | null; auto_advance?: boolean | null }>;
  /** Finalizes a draft invoice (its total is fixed from here on). */
  finalizeInvoice(id: string, idempotencyKey: string): Promise<{ id: string; status?: string | null; amount_due?: number | null }>;
  /** Charges a finalized (open) invoice now. A card refusal is a 402. */
  /** Astra TAXCOUNTRY-8 (coordinator b): the charge names the payment method the customer AUTHORIZED (and its mandate, where that method
   *  needs one), never whatever default Stripe would pick; it is a merchant-initiated charge (off_session). */
  payInvoice(id: string, idempotencyKey: string, authorized: { paymentMethod: string; mandate?: string | null }): Promise<{ id: string; status?: string | null }>;
  /** Voids a finalized, unpaid invoice. */
  voidInvoice(id: string, idempotencyKey: string): Promise<{ id: string; status?: string | null }>;
  /** Deletes a DRAFT one-off invoice. Stripe does not delete a subscription's draft invoices, so callers treat a refusal as expected. */
  deleteInvoice(id: string): Promise<{ id: string; deleted?: boolean; requestId: string | null }>;
  /** Cancel at the end of the paid period (true) or take the cancellation back (false). */
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean, idempotencyKey?: string): Promise<{ id: string; current_period_end?: number | null }>;
  /** Cloud checkout WP8: cancel the subscription at an exact instant (Unix seconds), or take that back (null: `cancel_at=` empty clears it).
   *  Absolute value, so repeating it is harmless. */
  setCancelAt(subscriptionId: string, atSeconds: number | null, idempotencyKey?: string): Promise<{ id: string; cancel_at?: number | null }>;
  /** Cloud checkout WP8: Stripe customers a typed identifier points at: an invoice number (invoice search) or the email on a receipt (customer list). */
  customersForIdentifier(identifier: string): Promise<string[]>;
  /** What the subscription will charge next (its recurring total including tax), before it is charged (POST /v1/invoices/create_preview). */
  getUpcomingInvoice(subscriptionId: string): Promise<{ amount_due: number; total?: number | null }>;
  /** `invoice` is gone from the Charge in Basil; it is null there and callers resolve it with invoiceOfPayment. */
  getCharge(id: string): Promise<{ id: string; customer: string | null; invoice: string | null; payment_intent: string | null }>;
  /** `amountCents` omitted = refund the whole payment. */
  createRefund(input: { paymentIntent: string; amountCents?: number; reason?: string; opId?: string; submission?: number }, idempotencyKey: string): Promise<RefundView>;
  getRefund(id: string): Promise<RefundView & { status: string | null; amount: number }>;
  /** Direct path (Ferrox is the seller): a refund is a credit note, so Stripe Tax reverses the tax with it. `amountCents` is the gross
   *  (tax included) USD amount, refunded in full to the payment. Idempotent by the key; the note carries the op id in its metadata. */
  createCreditNote(input: { invoiceId: string; amountCents: number; opId: string; submission: number }, idempotencyKey: string): Promise<CreditNoteView>;
  getCreditNote(id: string): Promise<CreditNoteView>;
  /** Credit notes of an invoice, to settle an ambiguous attempt by the op id before making another. Every page is read (has_more /
   *  starting_after) until the note carrying `opts.opId` is found or the listing is complete; a listing that cannot be completed throws
   *  (StripeError credit_notes_incomplete), so an incomplete listing never reads as "no note exists". With `opts.accept`, only a note carrying
   *  the op id that `accept` also passes ends the listing early (a copied op id on a foreign note never hides the real one; Astra WP3-3 #1). */
  listCreditNotes(invoiceId: string, opts?: { opId?: string; accept?: (n: CreditNoteView) => boolean }): Promise<{ data: CreditNoteView[] }>;
  /** Returns Stripe's subscription object; only status "canceled" (or a 404) means it is cancelled. */
  cancelSubscription(id: string, opts?: { prorate: boolean; invoiceNow: boolean }, idempotencyKey?: string): Promise<{ id: string; status?: string | null }>;
  /** current_period_start/end are read from the subscription item in Basil (normalized here; the top-level fields are gone). */
  getSubscription(id: string): Promise<{ id: string; status: string | null; cancel_at_period_end?: boolean | null; current_period_start?: number | null;
    current_period_end?: number | null; trial_end?: number | null; cancel_at?: number | null; pause_collection?: string | null; billing_cycle_anchor?: number | null;
    customer?: string | null;
    /** The subscription schedule attached to it, if any (we never create one; the Dashboard or another tool can). */
    schedule?: string | null }>;
  /** Cloud checkout WP8 r1: pause payment collection (`keep_as_draft`: renewal invoices are created as drafts and nothing is charged) or resume
   *  it (null). Collection control only: it never ends the subscription (https://docs.stripe.com/billing/subscriptions/pause-payment). */
  setPauseCollection(subscriptionId: string, behavior: "keep_as_draft" | null, idempotencyKey: string): Promise<{ id: string; pause_collection?: unknown }>;
  /** Cloud checkout WP8 r1: EVERY invoice of a subscription with this status (all pages, normalized). Throws if the listing cannot be completed,
   *  so an incomplete listing never reads as "no such invoice". */
  listSubscriptionInvoices(subscriptionId: string, status: "paid" | "draft" | "open"): Promise<InvoiceView[]>;
  /** The customer as Stripe has it now: only the billing country is read (the address-change check, which must not trust a stale event). */
  getCustomer(id: string): Promise<{ id: string; address: { country: string | null; postalCode?: string | null } | null }>;
  /** The object a webhook event is about, retrieved fresh and rendered in the pinned version (STRIPE_API_VERSION): reconciles an event
   *  Stripe delivered in another API version, whose stored payload can never be re-rendered (https://docs.stripe.com/webhooks#api-versioning). */
  retrieveEventObject(kind: EventObjectKind, id: string): Promise<Record<string, unknown>>;
  /** Plan change: what moving the subscription's item to `priceId` with immediate proration would charge now (tax included), computed AT
   *  `prorationDate` (Unix seconds). The same timestamp is passed to the update so Stripe charges exactly this
   *  (https://docs.stripe.com/api/invoices/create_preview, subscription_details.proration_date). */
  previewPriceChange(i: { subscriptionId: string; itemId: string; priceId: string; prorationDate: number }): Promise<{ amount_due: number; currency?: string | null }>;
  /** Plan change: the item moves to `priceId`, the proration (at `prorationDate`) is invoiced and charged at once, and the change applies
   *  only if that payment succeeds (pending_if_incomplete; https://docs.stripe.com/billing/subscriptions/pending-updates). */
  changeSubscriptionPrice(i: { subscriptionId: string; itemId: string; priceId: string; prorationDate: number }, idempotencyKey: string):
    Promise<{ id: string; latest_invoice?: string | { id?: string } | null; pending_update?: unknown }>;
  /** EVERY line of an invoice (all pages). Throws if the list cannot be read completely: the caller stays retryable. */
  listInvoiceLines(invoiceId: string): Promise<InvoiceLineView[]>;
  /** A Price as Stripe has it now (amount, currency, interval, active). */
  getPrice(id: string): Promise<{ id: string; active?: boolean; unit_amount?: number | null; currency?: string; recurring?: { interval?: string; interval_count?: number; usage_type?: string } | null }>;
  /** A Customer Portal configuration (`id`), or the account's default one (null). */
  getPortalConfiguration(id: string | null): Promise<{ id?: string; features?: { subscription_update?: { enabled?: boolean } } }>;
  /** Who paid a payment (refund-identity.ts): the payment method's card fingerprint, wallet, the emails and billing name/address Stripe
   *  holds for it, plus the Stripe customer's own. A payment or customer Stripe no longer has (404, e.g. erased) contributes nothing;
   *  any other failure throws (the caller retries). */
  paymentIdentity(paymentIntent: string | null, customerId: string | null): Promise<PaymentIdentity>;
}
/** The raw identity fields of one payment. Never stored: refund-identity.ts keeps only keyed hashes of them. */
export interface PaymentIdentity {
  /** card: a card number; wallet: Apple Pay / Google Pay etc. (the fingerprint is the device token's); link: a Link payment method (no
   *  fingerprint exists); other: another payment method type; unreadable: Stripe has no payment to read. */
  source: "card" | "wallet" | "link" | "other" | "unreadable";
  fingerprint: string | null; wallet: string | null; emails: string[]; name: string | null;
  /** How many of `emails` came from the payment itself (billing details, Link, receipt), not from the Stripe customer. */
  paymentEmails: number;
  address: { line1: string | null; line2: string | null; postal_code: string | null; country: string | null } | null;
}
export function paymentIdentityOf(pi: unknown, customer: unknown): PaymentIdentity {
  const p = rec(pi); const charge = rec(p.latest_charge); const pm = rec(p.payment_method); const cus = rec(customer);
  const pmd = rec(charge.payment_method_details); const cardD = rec(pmd.card); const cardM = rec(pm.card);
  const type = str(pmd.type) ?? str(pm.type);
  const fingerprint = str(cardD.fingerprint) ?? str(cardM.fingerprint);
  const wallet = str(rec(cardD.wallet).type) ?? str(rec(cardM.wallet).type);
  const bc = rec(charge.billing_details); const bm = rec(pm.billing_details);
  const own = [str(bc.email), str(bm.email), str(rec(pm.link).email), str(charge.receipt_email), str(p.receipt_email)].filter((e): e is string => e !== null);
  const emails = [...own, str(cus.email)].filter((e): e is string => e !== null);
  const addrOf = (a: unknown) => { const r = rec(a); return str(r.line1) || str(r.postal_code)
    ? { line1: str(r.line1), line2: str(r.line2), postal_code: str(r.postal_code), country: str(r.country) } : null; };
  // The most complete address wins (country and street first), not merely the first one present: a charge that carries only a postal
  // code must not hide a full address on the payment method (Astra P2-6). Ties keep the order charge, payment method, customer.
  const score = (a: ReturnType<typeof addrOf>) => !a ? -1 : (a.country ? 4 : 0) + (a.line1 ? 2 : 0) + (a.postal_code ? 1 : 0);
  const address = [addrOf(bc.address), addrOf(bm.address), addrOf(cus.address)].reduce((best, a) => score(a) > score(best) ? a : best, null as ReturnType<typeof addrOf>);
  const source: PaymentIdentity["source"] = !pi ? "unreadable" : type === "link" ? "link"
    : type === "card" ? (wallet && wallet !== "link" ? "wallet" : wallet === "link" ? "link" : "card") : "other";
  return { source, fingerprint, wallet, emails: [...new Set(emails)], paymentEmails: new Set(own).size, name: str(bc.name) ?? str(bm.name) ?? str(cus.name),
    address };
}
/** A Stripe refund as the ledger reads it: its state and, once Stripe has them, the presentment amount and currency. */
export interface RefundView { id: string; status?: string | null; amount?: number | null; currency?: string | null; metadata?: Record<string, string> | null;
  payment_intent?: string | null; presentment_details?: { presentment_amount?: number | null; presentment_currency?: string | null } | null;
  /** Stripe's creation time of the refund (unix seconds): the submission date recorded on recovery, never the time we found it. */
  created?: number | null }
/** A credit note, normalized: `refund` is the id of the refund it created (Basil: refunds[0].refund; older: refund), null until Stripe shows it. */
export interface CreditNoteView { id: string; status: string | null; invoice: string | null; amount: number; refund: string | null; metadata: Record<string, string>;
  /** Every refund the note created (refund is the first), and Stripe's creation time of the note (unix seconds, null when not shown). */
  refunds?: string[]; created?: number | null;
  /** The sum of the note's refunds' amount_refunded (Basil refunds[]), null when Stripe does not show it (the note's amount stands in). */
  refundTotal?: number | null }
export function creditNoteView(raw: unknown): CreditNoteView {
  const n = rec(raw);
  const first = rec(arr(n.refunds)[0]);
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(n.metadata))) if (typeof v === "string") meta[k] = v;
  const refunds = arr(n.refunds).map((r) => idOf(rec(r).refund)).filter((r): r is string => r !== null);
  const refund = idOf(first.refund) ?? idOf(n.refund);
  if (refund !== null && !refunds.includes(refund)) refunds.unshift(refund);
  const refunded = arr(n.refunds).map((r) => num(rec(r).amount_refunded));
  const refundTotal = refunded.length && refunded.every((a) => a !== null) ? refunded.reduce<number>((t, a) => t + (a ?? 0), 0) : null;
  return { id: str(n.id) ?? "", status: str(n.status), invoice: idOf(n.invoice), amount: num(n.amount) ?? num(n.total) ?? 0, refund, metadata: meta, refunds,
    created: num(n.created), refundTotal };
}
export type EventObjectKind = "checkout_session" | "invoice" | "subscription" | "charge" | "dispute" | "refund" | "customer";
const EVENT_OBJECT_PATHS: Record<EventObjectKind, (id: string) => string> = {
  checkout_session: (id) => `/v1/checkout/sessions/${encodeURIComponent(id)}`,
  // The invoice as the handlers read it (invoiceView): its payments expanded, like getInvoice.
  invoice: (id) => `/v1/invoices/${encodeURIComponent(id)}?expand[]=payments`,
  subscription: (id) => `/v1/subscriptions/${encodeURIComponent(id)}`,
  charge: (id) => `/v1/charges/${encodeURIComponent(id)}`,
  dispute: (id) => `/v1/disputes/${encodeURIComponent(id)}`,
  refund: (id) => `/v1/refunds/${encodeURIComponent(id)}`,
  customer: (id) => `/v1/customers/${encodeURIComponent(id)}`,
};

/** An invoice as the account page needs it (journey A4). `created` is Unix seconds; amounts are Stripe's `total` (tax included) in minor units. */
export interface CustomerInvoice { id: string; number: string | null; created: number; totalCents: number; currency: string; status: string; customer: string | null;
  hostedInvoiceUrl: string | null; invoicePdf: string | null }
function customerInvoice(raw: unknown): CustomerInvoice {
  const i = rec(raw);
  return { id: str(i.id) ?? "", number: str(i.number), created: num(i.created) ?? 0, totalCents: num(i.total) ?? 0, currency: str(i.currency) ?? "usd",
    status: str(i.status) ?? "unknown", customer: idOf(i.customer), hostedInvoiceUrl: str(i.hosted_invoice_url), invoicePdf: str(i.invoice_pdf) };
}

/** `opts.signal`: an extra abort for every request of this client (a sweep's hard deadline, b5-billing.ts sweepTaxDispatches), on top of the
 *  80-second request timeout: whichever comes first aborts the request (a fetch rejection: an outcome the caller treats as unknown). */
export function stripeClient(config: Pick<BillingConfig, "secretKey" | "apiVersion">, fetcher: StripeFetch = fetch, opts: { signal?: AbortSignal } = {}): StripeClient {
  async function call<T>(method: "GET" | "POST" | "DELETE", path: string, form?: Form, idempotencyKey?: string): Promise<T> {
    return (await callMeta<T>(method, path, form, idempotencyKey)).body;
  }
  /** The answer and whether Stripe gave it from its idempotency cache (Idempotent-Replayed: the object was made by an EARLIER request). */
  async function callMeta<T>(method: "GET" | "POST" | "DELETE", path: string, form?: Form | string, idempotencyKey?: string): Promise<{ body: T; replayed: boolean; requestId: string | null }> {
    const headers: Record<string, string> = { authorization: `Bearer ${config.secretKey}`, "stripe-version": STRIPE_API_VERSION };
    if (form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    // Astra JOURNEY-BCORE-1 #4: one request is never waited on longer than Stripe's documented client request timeout (80 s, the default of
    // Stripe's own libraries): an attempt whose answer did not come back by then is OUTSTANDING (b5-billing.ts STRIPE_ATTEMPT_MAX_AGE_MS).
    const response = await fetcher(`https://api.stripe.com${path}`, { method, headers, body: form === undefined ? undefined : typeof form === "string" ? form : encode(form), signal: opts.signal ? AbortSignal.any([AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS), opts.signal]) : AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      // Never surface Stripe's message text: it can echo request fields.
      const body = await response.json().catch(() => null) as { error?: { code?: string; type?: string } } | null;
      const code = body?.error?.code;
      throw new StripeError(response.status, `stripe_${code ?? response.status}`, { replayed: response.headers.get("idempotent-replayed") === "true",
        inFlight: response.status === 409 && code === "idempotency_key_in_use", requestId: response.headers.get("request-id"),
        type: typeof body?.error?.type === "string" ? body.error.type : null });
    }
    // Stripe's Request-Id is kept on SUCCESS too (C2 review): Stripe ignores idempotency keys on DELETE, so a DELETE (and any write) is
    // traced to our request only through its success answer's Request-Id.
    return { body: await response.json() as T, replayed: response.headers.get("idempotent-replayed") === "true", requestId: response.headers.get("request-id") };
  }
  return {
    createCustomer: (i, key) => call("POST", "/v1/customers", {
      email: i.email, "metadata[home_id]": i.homeId, "metadata[fp_tid]": i.fpTid, "address[country]": i.country, "address[postal_code]": i.postalCode ?? undefined }, key),
    postCustomerCreate: async (body, key) => {
      const r = await callMeta<{ id: string }>("POST", "/v1/customers", body, key);
      return { id: r.body.id, replayed: r.replayed, requestId: r.requestId };
    },
    postCustomerUpdate: async (id, body, key) => {
      const r = await callMeta<{ id: string }>("POST", `/v1/customers/${encodeURIComponent(id)}`, body, key);
      return { id: r.body.id, replayed: r.replayed, requestId: r.requestId };
    },
    customerTaxState: async (id) => {
      const c = await call<Obj>("GET", `/v1/customers/${encodeURIComponent(id)}?expand[]=subscriptions`);
      const a = c.address && typeof c.address === "object" ? c.address as Obj : null;
      const subs = c.subscriptions && typeof c.subscriptions === "object" ? (c.subscriptions as { data?: unknown[] }).data ?? [] : [];
      const settings = c.invoice_settings && typeof c.invoice_settings === "object" ? c.invoice_settings as Obj : {};
      return { country: a ? str(a.country) : null, postalCode: a ? str(a.postal_code) : null,
        liveSubscription: subs.some((x) => LIVE_SUBSCRIPTION.has(str((x as Obj)?.status) ?? "")),
        balance: typeof c.balance === "number" && Number.isFinite(c.balance) ? c.balance : null,
        defaultPaymentMethod: idOf(settings.default_payment_method), defaultSource: idOf(c.default_source), deleted: c.deleted === true,
        email: str(c.email), name: str(c.name) };
    },
    customerHasPendingInvoice: async (id) => {
      for (const status of ["draft", "open"]) {
        const r = await call<{ data?: unknown[] }>("GET", `/v1/invoices?customer=${encodeURIComponent(id)}&status=${status}&limit=1`);
        if ((r.data ?? []).some((x) => str((x as Obj)?.status) === status)) return true;
      }
      return false;
    },
    customerHasCreditNotes: async (id) => {
      const r = await call<{ data?: unknown[] }>("GET", `/v1/credit_notes?customer=${encodeURIComponent(id)}&limit=1`);
      return Array.isArray(r.data) && r.data.length > 0;
    },
    customerHasInstruments: async (id) => {
      for (const path of [`/v1/payment_methods?customer=${encodeURIComponent(id)}&limit=1`, `/v1/customers/${encodeURIComponent(id)}/sources?limit=1`]) {
        const r = await call<{ data?: unknown }>("GET", path);
        if (!Array.isArray(r.data)) throw new StripeError(502, "instrument_listing_unreadable");
        if (r.data.length > 0) return true;
      }
      return false;
    },
    // The seller's own path builds the session (seller.ts): our Checkout plus Stripe Tax, or Managed Payments with Link as merchant of record.
    createCheckoutSession: async (i, key) => {
      const r = await callMeta<{ id: string; url: string }>("POST", "/v1/checkout/sessions", sessionParams(i.seller ?? "ferrox", i), key);
      return { ...r.body, replayed: r.replayed };
    },
    listCheckoutSessions: (customerId) => call("GET", `/v1/checkout/sessions?customer=${encodeURIComponent(customerId)}&limit=20`),
    listAllCheckoutSessions: async (customerId) => {
      type Listed = { id: string; status: string | null; subscription?: string | null; url?: string | null; expires_at?: number | null; metadata?: Record<string, string> | null };
      const all: Listed[] = [];
      let after: string | null = null;
      for (let page = 0; page < 50; page++) {
        const r: { data?: Listed[]; has_more?: boolean } = await call("GET",
          `/v1/checkout/sessions?customer=${encodeURIComponent(customerId)}&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
        const data = r.data ?? [];
        all.push(...data);
        if (r.has_more !== true) return all;
        if (!data.length) break;
        after = data[data.length - 1].id;
      }
      throw new StripeError(502, "stripe_listing_incomplete");
    },
    checkoutSessionLineItems: async (id) => {
      const r = await call<{ data?: unknown[]; has_more?: boolean }>("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}/line_items?limit=10`);
      const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
      const items = (Array.isArray(r.data) ? r.data : []).map((x): SessionLineItem => {
        const o = x && typeof x === "object" ? x as Obj : {};
        const price = o.price && typeof o.price === "object" ? o.price as Obj : {};
        const rec = price.recurring && typeof price.recurring === "object" ? price.recurring as Obj : {};
        return { priceId: typeof price.id === "string" ? price.id : null, currency: typeof price.currency === "string" ? price.currency : null,
          interval: typeof rec.interval === "string" ? rec.interval : null, intervalCount: num(rec.interval_count), quantity: num(o.quantity),
          unitAmount: num(price.unit_amount) };
      });
      // A listing with more pages is never "exactly one item": a placeholder keeps the count honest.
      return r.has_more === true ? [...items, { priceId: null, currency: null, interval: null, intervalCount: null, quantity: null, unitAmount: null }] : items;
    },
    checkoutSessionInvoice: async (id) => idOf((await call<Obj>("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}?expand[]=invoice`)).invoice),
    expireCheckoutSession: (id) => call("POST", `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {}, `expire:${id}`),
    getCheckoutSession: async (id) => {
      const r = await call<Obj>("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`);
      const md = r.metadata && typeof r.metadata === "object" ? r.metadata as Record<string, string> : null;
      return { id: str(r.id) ?? id, status: str(r.status), customer: idOf(r.customer), metadata: md };
    },
    listPaidInvoices: async (subscriptionId) => {
      const r = await call<{ data?: unknown[] }>("GET", `/v1/invoices?subscription=${encodeURIComponent(subscriptionId)}&status=paid&limit=10&expand[]=data.payments`);
      return { data: (r.data ?? []).map(invoiceView) };
    },
    // Every page (Astra WP3-2 #3): 100 is Stripe's PAGE limit, not a cap on refunds of one payment (repeated partial refunds are allowed), so an
    // older refund can sit behind 100 newer ones. A listing that cannot be completed throws: nothing is imported or reissued on a partial view.
    listRefunds: async (paymentIntent) => {
      type Listed = Awaited<ReturnType<StripeClient["listRefunds"]>>["data"][number];
      const out: Listed[] = [];
      let after: string | null = null;
      for (let page = 0; page < 50; page++) {
        const r: { data?: unknown[]; has_more?: boolean } = await call("GET",
          `/v1/refunds?payment_intent=${encodeURIComponent(paymentIntent)}&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
        if (!Array.isArray(r.data)) break;
        out.push(...r.data as Listed[]);
        if (r.has_more !== true) return { data: out };
        after = r.data.length ? str(rec(r.data[r.data.length - 1]).id) : null;
        if (!after) break;
      }
      throw new StripeError(502, "refunds_incomplete", {});
    },
    setTrialEnd: (id, trialEnd) => call("POST", `/v1/subscriptions/${encodeURIComponent(id)}`, { trial_end: trialEnd, proration_behavior: "none" },
      `trialend:${id}:${trialEnd}`),
    createTaxCalculation: (i) => {
      const form: Form = { currency: "usd", "customer_details[address][country]": i.country, "customer_details[address][postal_code]": i.postalCode,
        "customer_details[address_source]": "billing", "expand[]": "line_items" };
      i.lines.forEach((l, n) => { form[`line_items[${n}][amount]`] = l.amountCents; form[`line_items[${n}][reference]`] = l.reference;
        form[`line_items[${n}][tax_behavior]`] = "exclusive"; });
      return call("POST", "/v1/tax/calculations", form);
    },
    createPortalSession: (i) => call("POST", "/v1/billing_portal/sessions", {
      customer: i.customerId, return_url: i.returnUrl, configuration: i.configuration }),
    getInvoice: async (id) => invoiceView(await call("GET", `/v1/invoices/${encodeURIComponent(id)}?expand[]=payments`)),
    listCustomerInvoices: async (customerId) => {
      const r = await call<{ data?: unknown[] }>("GET", `/v1/invoices?customer=${encodeURIComponent(customerId)}&limit=24`);
      return (r.data ?? []).map(customerInvoice).filter((i) => i.id && i.status !== "draft");
    },
    getCustomerInvoice: async (id) => {
      try { return customerInvoice(await call("GET", `/v1/invoices/${encodeURIComponent(id)}`)); }
      catch (e) { if (e instanceof StripeError && e.status === 404) return null; throw e; }
    },
    invoiceOfPayment: async (pi) => {
      const r = await call<{ data?: { invoice?: unknown; status?: string | null }[] }>("GET",
        `/v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${encodeURIComponent(pi)}&limit=10`);
      return idOf((r.data ?? []).find((p) => p.status !== "canceled")?.invoice ?? r.data?.[0]?.invoice);
    },
    setInvoiceAutoAdvance: (id, autoAdvance, key) => call("POST", `/v1/invoices/${encodeURIComponent(id)}`, { auto_advance: autoAdvance }, key),
    finalizeInvoice: (id, key) => call("POST", `/v1/invoices/${encodeURIComponent(id)}/finalize`, { auto_advance: false }, key),
    payInvoice: (id, key, authorized) => call("POST", `/v1/invoices/${encodeURIComponent(id)}/pay`, { payment_method: authorized.paymentMethod,
      ...(authorized.mandate ? { mandate: authorized.mandate } : {}), off_session: "true" }, key),
    voidInvoice: (id, key) => call("POST", `/v1/invoices/${encodeURIComponent(id)}/void`, {}, key),
    deleteInvoice: async (id) => {
      const r = await callMeta<{ id: string; deleted?: boolean }>("DELETE", `/v1/invoices/${encodeURIComponent(id)}`);
      return { ...r.body, requestId: r.requestId };
    },
    getCharge: async (id) => {
      const c = await call<Obj>("GET", `/v1/charges/${encodeURIComponent(id)}`);
      return { id: str(c.id) ?? id, customer: idOf(c.customer), invoice: idOf(c.invoice), payment_intent: idOf(c.payment_intent) };
    },
    createRefund: (i, key) => call("POST", "/v1/refunds", { payment_intent: i.paymentIntent, amount: i.amountCents, "metadata[reason]": i.reason,
      "metadata[op_id]": i.opId, "metadata[submission]": i.submission }, key),
    // Credit note (Stripe Tax reversal): the gross amount is credited and refunded to the payment in one call. The amount parameters follow
    // https://docs.stripe.com/api/credit_notes/create; the shape is to be confirmed in the sandbox qualification (plan §0).
    createCreditNote: async (i, key) => creditNoteView(await call("POST", "/v1/credit_notes", { invoice: i.invoiceId, amount: i.amountCents, refund_amount: i.amountCents,
      reason: "order_change", "metadata[op_id]": i.opId, "metadata[submission]": i.submission }, key)),
    getCreditNote: async (id) => creditNoteView(await call("GET", `/v1/credit_notes/${encodeURIComponent(id)}`)),
    listCreditNotes: async (invoiceId, opts) => {
      const out: CreditNoteView[] = [];
      let after: string | null = null;
      for (let page = 0; page < 50; page++) {
        const r: { data?: unknown[]; has_more?: boolean } = await call("GET",
          `/v1/credit_notes?invoice=${encodeURIComponent(invoiceId)}&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
        if (!Array.isArray(r.data)) break;
        const notes = r.data.map(creditNoteView);
        out.push(...notes);
        if (opts?.opId && notes.some((n) => n.metadata.op_id === opts.opId && (!opts.accept || opts.accept(n)))) return { data: out }; // ownership found
        if (r.has_more !== true) return { data: out }; // absence established: every page read
        after = notes.length ? notes[notes.length - 1].id || null : null;
        if (!after) break;
      }
      throw new StripeError(502, "credit_notes_incomplete", {});
    },
    setCancelAtPeriodEnd: (id, cancel, key) => call("POST", `/v1/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: cancel }, key),
    // A cancel_at is always a period end here; no proration is created for it.
    setCancelAt: (id, at, key) => call("POST", `/v1/subscriptions/${encodeURIComponent(id)}`, at === null ? { cancel_at: "" } : { cancel_at: at, proration_behavior: "none" }, key),
    setPauseCollection: (id, behavior, key) => call("POST", `/v1/subscriptions/${encodeURIComponent(id)}`,
      behavior === null ? { pause_collection: "" } : { "pause_collection[behavior]": behavior }, key),
    listSubscriptionInvoices: async (subscriptionId, status) => {
      const out: InvoiceView[] = [];
      let after: string | null = null;
      for (let page = 0; page < 50; page++) {
        const r: { data?: unknown[]; has_more?: boolean } = await call("GET", `/v1/invoices?subscription=${encodeURIComponent(subscriptionId)}&status=${status}&limit=100&expand[]=data.payments${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
        if (!Array.isArray(r.data)) break;
        const page_ = r.data.map(invoiceView);
        out.push(...page_);
        if (r.has_more !== true) return out;
        after = page_.length ? page_[page_.length - 1].id || null : null;
        if (!after) break;
      }
      throw new StripeError(502, "invoices_incomplete", {});
    },
    customersForIdentifier: async (identifier) => {
      const id = identifier.trim().slice(0, 200);
      const ids = new Set<string>();
      if (id.includes("@")) {
        const r = await call<{ data?: { id?: unknown }[] }>("GET", `/v1/customers?email=${encodeURIComponent(id.toLowerCase())}&limit=10`);
        for (const c of r.data ?? []) if (typeof c.id === "string") ids.add(c.id);
      } else if (/^[A-Za-z0-9-]{3,64}$/.test(id)) {
        const r = await call<{ data?: { customer?: unknown }[] }>("GET", `/v1/invoices/search?query=${encodeURIComponent(`number:"${id}"`)}&limit=5`);
        for (const i of r.data ?? []) { const c = idOf(i.customer); if (c) ids.add(c); }
      }
      return [...ids];
    },
    getUpcomingInvoice: (id) => call("POST", "/v1/invoices/create_preview", { subscription: id }),
    // opts (the checkout guard, plan §1.1): `prorate=false, invoice_now=false`, so cancelling a rejected order bills and credits nothing.
    cancelSubscription: (id, opts, key) => call("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`,
      opts ? { prorate: opts.prorate, invoice_now: opts.invoiceNow } : undefined, key),
    getSubscription: async (id) => subscriptionView(await call<Obj>("GET", `/v1/subscriptions/${encodeURIComponent(id)}`)),
    getRefund: (id) => call("GET", `/v1/refunds/${encodeURIComponent(id)}`),
    getCustomer: async (id) => {
      const c = await call<Obj>("GET", `/v1/customers/${encodeURIComponent(id)}`);
      const a = c.address && typeof c.address === "object" ? c.address as Obj : null;
      return { id: str(c.id) ?? id, address: a ? { country: str(a.country), postalCode: str(a.postal_code) } : null };
    },
    retrieveEventObject: (kind, id) => call("GET", EVENT_OBJECT_PATHS[kind](id)),
    paymentIdentity: async (paymentIntent, customerId) => {
      // 404 only: an object Stripe does not have (or has erased) adds nothing; every other failure is retried by the caller.
      const gone = async <T>(f: () => Promise<T>): Promise<T | null> => {
        try { return await f(); } catch (e) { if (e instanceof StripeError && e.status === 404) return null; throw e; }
      };
      const pi = paymentIntent ? await gone(() => call<Obj>("GET",
        `/v1/payment_intents/${encodeURIComponent(paymentIntent)}?expand[]=latest_charge&expand[]=payment_method`)) : null;
      const cus = customerId ? await gone(() => call<Obj>("GET", `/v1/customers/${encodeURIComponent(customerId)}`)) : null;
      return paymentIdentityOf(pi, cus);
    },
    previewPriceChange: (i) => call("POST", "/v1/invoices/create_preview", { subscription: i.subscriptionId,
      "subscription_details[items][0][id]": i.itemId, "subscription_details[items][0][price]": i.priceId,
      "subscription_details[proration_behavior]": "always_invoice", "subscription_details[proration_date]": i.prorationDate }),
    changeSubscriptionPrice: (i, key) => call("POST", `/v1/subscriptions/${encodeURIComponent(i.subscriptionId)}`, {
      "items[0][id]": i.itemId, "items[0][price]": i.priceId, proration_behavior: "always_invoice", proration_date: i.prorationDate,
      payment_behavior: "pending_if_incomplete" }, key),
    listInvoiceLines: async (invoiceId) => {
      const out: InvoiceLineView[] = [];
      let after: string | null = null;
      for (let page = 0; page < 50; page++) {
        const r: { data?: unknown[]; has_more?: boolean } = await call("GET", `/v1/invoices/${encodeURIComponent(invoiceId)}/lines?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
        const data = r.data ?? [];
        out.push(...data.map(invoiceLineView));
        if (r.has_more !== true) return out;
        after = str(rec(data[data.length - 1]).id);
        if (!after) break;
      }
      throw new StripeError(502, "invoice_lines_incomplete", {});
    },
    getPrice: (id) => call("GET", `/v1/prices/${encodeURIComponent(id)}`),
    getPortalConfiguration: async (id) => id ? call("GET", `/v1/billing_portal/configurations/${encodeURIComponent(id)}`)
      : ((await call<{ data?: Record<string, unknown>[] }>("GET", "/v1/billing_portal/configurations?is_default=true&limit=1")).data ?? [])[0] ?? {},
  };
}
