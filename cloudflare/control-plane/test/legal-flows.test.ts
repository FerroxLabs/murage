// SPDX-License-Identifier: AGPL-3.0-or-later
// The legal flows (CHECKOUT.md): consent gating and log, delayed start, durable confirmation, cancel, renewal reminder,
// first-month refund, auto top-up, and the export request that pauses deletion. Real workerd + D1, Stripe is a fixture.
import { aoeEnd, LEGACY_SESSION_CUTOFF_S } from "../src/checkout-moments";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider, type ProviderAdapter } from "../src/b3-provider";
import type { Home } from "../src/b3-control";
import { signStripePayload, type StripeFetch } from "../src/b5-stripe";
import { sweepMonitoring } from "../src/ops-monitor";
import { endingSql, sweepBilling, type BillingDependencies, type BillingNotifier, type FluxEntitlementHooks } from "../src/b5-billing";
import { LEGAL_DOCS } from "../src/legal-docs.generated";
import { addMonthUtc, recordAcceptanceAtCompletion, buildDisclosure, buildTermsReminderEmail, isEuRegion, isoDate, retentionDaysText, MODEL_WITHDRAWAL_FORM, NO_EXPORT_HOLD_SQL, pinCurrentPayment, SCREEN_VERSION, TERMS_NONACCEPTANCE_WORDING, WORDING, type TaxQuoteRow } from "../src/legal-flows";
import { defaultNotifier, FluxHookRetry, stubFluxHooks, stubGrantMonthlyCredits } from "../src/b5-billing";
import { EXPORT_REPEAT_WORDING } from "../src/legal-routes";
import { acquireHomeLease, HomeBusy, releaseHomeLease } from "../src/billing-lease";
import { advanceRefundOp, getRefundOp, refundOpInsert, reopenLegacyRefusal, reopenRefusedRequest } from "../src/legal-refunds";
import { MANAGED_FORBIDDEN } from "../src/seller";
import { STRIPE_PAGE_VERSION, submitText } from "../src/checkout-strings";
import { renewalSha256 } from "../src/disclosure-token";
import m0071 from "../migrations/0071_replacement_cutovers.sql?raw";
import m0093 from "../migrations/0093_cancellation_feedback.sql?raw";
import { CHECKOUT_MAY_SETTLE_SQL } from "../src/b3-control";
import { MANAGED_PAYMENTS_TAX_COVERAGE } from "../src/managed-payments-coverage";
import { boundSession, consentFor, getQuote, latestConsentId, seedPendingQuotes, useSellerEnv } from "./legal-helpers";
import { paymentIdentityOf, stripeClient } from "../src/b5-stripe";
import { billingConfig, checkoutRefundKeyError } from "../src/b5-config";
import { billingIdentity, captureRefundIdentity, dueEnrichments, enrichOne, finalisePendingObjections, firstPaymentCheck, keyring, normalizeEmail, recordObjection, REFUND_DENIAL_TEXT, refundLimitAccepted, refusalNoticeState, retentionCutoff, retireRedundantKeys } from "../src/refund-identity";
import type { StripeClient } from "../src/b5-stripe";
import m0061 from "../migrations/0061_checkout_moments.sql?raw";
import m0073 from "../migrations/0073_checkout_cancel_journal_grants.sql?raw";
import { applyCustomerForm } from "./stripe-customer-fake";
/** The renewal dropdown, answered (plan §3.2): without it the guard turns the order away. */
const RENEWAL_YES = [{ key: "renewalconsent", type: "dropdown", dropdown: { value: "renewalyes" } }];

const ADMIN = "test-only-b5-admin-no-real-access";
const WHSEC = "whsec_testonlyfixturesecret0123456789";
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const OWNER = "legal-owner";
const REFUND_SECRET = "test-only-refund-identity-hmac-secret-0123456789";
const INSTALL = "12345678-1234-4123-8123-123456789012";
const IMAGE = `sha256:${"a".repeat(64)}`;
const PRICES = { STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" };
const B3 = { reservationMs: 30 * 60_000, graceMs: 3 * DAY, retentionMs: 14 * DAY, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [{ id: "slot-1", projectId: "p1", location: "fsn1", serverType: "cx23", outcome: "available" }] };
const baseEnv = (extra: Partial<Env> = {}): Env => ({ ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: btoa("x".repeat(32)), CLOUD_B3_MODE: "fake",
  CLOUD_B3_CONFIG: JSON.stringify(B3), STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: WHSEC,
  // The tests written before the seller split run on the DIRECT path everywhere (CLOUD_NONUS_SELLER=direct, also the later "$25k non-US"
  // switch); the seller-split tests set "managed_payments" (Link as merchant of record outside the US, the launch default).
  // Direct non-US sales need Ferrox's own tax registration there (Astra round 10, #5): the countries these tests sell to directly.
  BILLING_RETURN_ORIGIN: "https://cloud.murage.test", CLOUD_NONUS_SELLER: "direct", FERROX_TAX_COUNTRIES: "US,DE,FR,GB,NL",
  // The tests' current cloud-terms version is treated as carrying the one-per-person limit (refund-identity.ts REFUND_LIMIT_TERMS_VERSIONS).
  REFUND_KEY_SECRET: REFUND_SECRET, REFUND_LIMIT_TERMS_VERSIONS: LEGAL_DOCS.cloudTerms.versionId, ...PRICES, ...extra } as Env);

interface StripeCall { method: string; path: string; form: URLSearchParams; headers: Headers }
let stripeCalls: StripeCall[];
let notices: { id: string; kind: string; homeId: string; data: Record<string, unknown> }[];
let fluxLog: { hook: string; args: unknown }[];
let usedMicrocents = 0;
let invoicePaymentIntent: string | null = "pi_1";
// Stripe fixtures (never the network): sessions (with list and expire), invoices (with the paid list), refunds (with the list), tax.
let sessionN = 0;
let sessions: { id: string; status: string; subscription: string | null; metadata: Record<string, string> }[];
let paidInvoices: { id: string; amount_paid: number; tax: number; payment_intent: string | null; created: number; lines?: unknown }[];
let refundsMade: { id: string; amount: number; status: string; payment_intent?: string; metadata: Record<string, string> }[];
let refundFails = 0;
let revokeFails = 0;
let refundLost = 0;
let refundStatus = "succeeded";
let sessionListThrows = false;
let cancelStuck = false;
let cancelDown500 = false; // INTEGRATED-1 #6: Stripe answers the subscription cancel with a 500 (a non-parked end failure)
let listCalls = 0;
let onSessionCreate: (() => Promise<unknown>) | null = null;
/** WP6 r3: runs once, inside the next paid-invoice listing (the cutover's pre-batch Stripe read). */
let onInvoiceList: (() => Promise<unknown>) | null = null;
let envOver: Partial<Env> = {};
let subState: Record<string, { status: string; cancel_at_period_end: boolean; trial_end: number | null; cancel_at?: number | null }> = {};
let upcomingTotal = 4900;
let holdRefund: Promise<void> | null = null;
let holdSubPost: Promise<void> | null = null;
let trialRejects = false;
let refundByKey: Record<string, { id: string; status: string }> = {};
let taxFails = false;
let chargeFails = 0;
/** INTEGRATED-12: Stripe's InvoicePayment lookup fails this many times; charges answered as given (by id) instead of the fixture's. */
let invoicePaymentsFails = 0;
let chargeObjs: Record<string, Record<string, unknown>> = {};
// Subscription invoices (draft -> open -> paid), stateful like Stripe's: a hold request is auto_advance=false, a subscription's invoice cannot be deleted.
let invoiceStore: Record<string, { id: string; status: string; amount_due: number; auto_advance: boolean; subscription: string; billing_reason: string; payment_intent?: string }> = {};
// Round 10: Stripe answers in the Basil shape (2025-03-31.basil: no invoice.payment_intent / charge.invoice; invoice.payments, parent, pricing,
// total_taxes), which invoice a payment intent paid (InvoicePayment), each invoice's subscription, and a Stripe Tax "not_collecting" answer.
let basil = false;
let invoiceSubs: Record<string, string> = {};
let piInvoices: Record<string, string> = {};
let taxNotCollecting = false;
let invoiceHoldFails = false;
const subKeysApplied = new Set<string>();
let usedReads = 0;
let usedFailOn: number | null = null;
let payDeclines = false;
// Round 9: a held /pay (a payment in flight), Stripe's cached failure for a cancellation request, and a paused credit read inside a refund request.
let holdPay: Promise<void> | null = null;
let cancelFailNext = 0;
const cachedSubFailures = new Set<string>();
let holdUsed: Promise<void> | null = null;
// Round 11: objects Stripe returns on a plain GET in the pinned version (a reconciliation of an event delivered in another version).
let retrievable: Record<string, unknown> = {};
// int2-2: Stripe credit notes (opt-in, off by default): a note with refund_amount makes one refund; one note per idempotency key; listed by invoice.
let creditNotesOn = false;
let creditNotes: { key: string; note: Record<string, unknown> }[] = [];
// Round 12: one delayed retrieval (a snapshot taken when the GET is made, answered only once the gate opens).
let holdRetrieve: { path: string; reached: () => void; gate: Promise<void> } | null = null;
// Who paid (refund-identity.ts): the PaymentIntent with latest_charge and payment_method expanded, and the Stripe customer. A payment
// intent with no entry is a plain card with no fingerprint and no billing details; one listed in piGone answers 404.
let piIdentity: Record<string, Record<string, unknown>> = {};
let piGone = new Set<string>();
let customerIdentity: Record<string, unknown> = {};
// The customer preset (Astra TAXCOUNTRY-1): GET /v1/customers/{id} failures to answer, a hook run when an update lands, pending invoices.
let customerGetFails = 0;
let onCustomerUpdate: (() => Promise<void>) | null = null;
let pendingInvoices: { customer: string; status: string }[] = [];
// Astra TAXCOUNTRY-3: Stripe's idempotency for customer updates (docs.stripe.com/api/idempotent_requests). The first EXECUTION of a key is
// stored and every later request under it gets the stored answer (Idempotent-Replayed: true) without executing again; a key still executing
// is answered 409 idempotency_key_in_use; a refusal before execution (a 400 validation error) is not stored. customerUpdateMode (one-shot)
// is the next update's fate: "lost_unsent" (the connection fails before Stripe sees it), "lost_applied" (executed, the answer lost),
// "lost_inflight" (Stripe still executing: held in inflightCustomerWrite until landInflight()), "refused" (400).
let customerUpdateMode: null | "lost_unsent" | "lost_applied" | "lost_inflight" | "refused" = null;
let customerKeyResults: Record<string, { status: number; body: unknown } | "inflight"> = {};
let inflightCustomerWrite: { key: string; form: URLSearchParams } | null = null;
const landInflight = () => {
  const w = inflightCustomerWrite!; inflightCustomerWrite = null;
  customerIdentity = applyCustomerForm(customerIdentity, w.form);
  customerKeyResults[w.key] = { status: 200, body: { id: "cus_test1", object: "customer", ...customerIdentity } };
};
// Astra TAXCOUNTRY-5: a checkout moves a rewritable home to a NEW customer (POST /v1/customers with metadata[checkout_attempt]); those are
// kept here by id (cus_new1, ...), with Stripe's idempotency per key (customerKeyResults) and a one-shot fate customerCreateMode.
let newCustomers: Record<string, Record<string, unknown>> = {};
let newCustomerN = 0;
let customerCreateMode: null | "lost_unsent" | "lost_applied" | "lost_inflight" | "refused" = null;
/** Astra TAXCOUNTRY-7 P2-d: the next FIRST customer create (no checkout attempt) executes at Stripe and its answer is lost. */
let firstCustomerLost = false;
/** Round 10 (Astra TAXCOUNTRY-9 P2-c): FIRST creates honour their idempotency key like Stripe (a stored key answers its cached customer with
 *  Idempotent-Replayed: true; `firstCustomerPruned` drops a key, as Stripe does after 24 h). `firstCustomerLostApplied` > 0: the next create
 *  executes and its answer is lost. Off (null) by default: every first create answers cus_test1. */
let firstCustomerKeys: Record<string, string> | null = null;
let firstCustomerLostApplied = 0;
let firstCustomerN = 0;
/** Astra INTEGRATED-8 P2: the next FIRST create answers a 400 refusal: "uncached" = a fresh validation failure (no Idempotent-Replayed, nothing
 *  saved); "cached" = Stripe's saved answer of the original execution (Idempotent-Replayed: true). */
let firstCustomerReplayError: null | "uncached" | "cached" = null;
let customerCreditNotes: { customer: string }[] = [];
let customerInstruments: { customer: string; id: string; kind: "pm" | "source" }[] = [];
let inflightCustomerCreate: { id: string; key: string; form: URLSearchParams } | null = null;
const landCreate = () => {
  const w = inflightCustomerCreate!; inflightCustomerCreate = null;
  newCustomers[w.id] = applyCustomerForm({}, w.form);
  customerKeyResults[w.key] = { status: 200, body: { id: w.id, object: "customer", ...newCustomers[w.id] } };
};
let identityFails = 0;
let customerInvoices: Record<string, unknown>[] = [];
const TAX_RATES: Record<string, number> = { DE: 0.19, FR: 0.2, NL: 0.21, GB: 0.2, US: 0.0825 };
const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const form = new URLSearchParams(String(init?.body ?? ""));
  stripeCalls.push({ method, path: url.pathname, form, headers: new Headers(init?.headers) });
  const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (method === "GET" && retrievable[url.pathname]) {
    const snapshot = retrievable[url.pathname];
    if (holdRetrieve?.path === url.pathname) { const h = holdRetrieve; holdRetrieve = null; h.reached(); await h.gate; }
    return j(snapshot);
  }
  // Journey A4: the customer's invoices as Stripe lists and retrieves them (empty unless a test fills it).
  if (customerInvoices.length && method === "GET" && url.pathname === "/v1/invoices" && url.searchParams.has("customer")) {
    return j({ data: customerInvoices.filter((i) => i.customer === url.searchParams.get("customer")) });
  }
  if (customerInvoices.length && method === "GET" && /^\/v1\/invoices\/in_[^/]+$/.test(url.pathname)) {
    const found = customerInvoices.find((i) => i.id === url.pathname.split("/").pop());
    return found ? j(found) : j({ error: { code: "resource_missing" } }, 404);
  }
  if (url.pathname === "/v1/customers" && form.has("metadata[checkout_attempt]")) {
    const key = new Headers(init?.headers).get("idempotency-key");
    const stored = key ? customerKeyResults[key] : undefined;
    if (stored === "inflight") return j({ error: { code: "idempotency_key_in_use", type: "idempotency_error" } }, 409);
    if (stored) return new Response(JSON.stringify(stored.body), { status: stored.status, headers: { "idempotent-replayed": "true" } });
    const mode = customerCreateMode; customerCreateMode = null;
    if (mode === "lost_unsent") throw new TypeError("fetch failed");
    if (mode === "refused") return j({ error: { code: "parameter_invalid", type: "invalid_request_error" } }, 400);
    const id = `cus_new${++newCustomerN}`;
    if (mode === "lost_inflight") { if (key) customerKeyResults[key] = "inflight"; inflightCustomerCreate = { id, key: key ?? "", form }; throw new TypeError("fetch failed"); }
    newCustomers[id] = applyCustomerForm({}, form);
    const body = { id, object: "customer", ...newCustomers[id] };
    if (key) customerKeyResults[key] = { status: 200, body };
    if (onCustomerUpdate) { const f = onCustomerUpdate; onCustomerUpdate = null; await f(); }
    if (mode === "lost_applied") throw new TypeError("fetch failed");
    return j(body);
  }
  if (url.pathname === "/v1/credit_notes" && method === "GET" && url.searchParams.has("customer")) {
    return j({ data: customerCreditNotes.filter((n) => n.customer === url.searchParams.get("customer")) });
  }
  if (url.pathname === "/v1/payment_methods" && method === "GET" && url.searchParams.has("customer")) {
    return j({ object: "list", data: customerInstruments.filter((p) => p.customer === url.searchParams.get("customer") && p.kind === "pm") });
  }
  const sourcesOf = method === "GET" ? url.pathname.match(/^\/v1\/customers\/([^/]+)\/sources$/) : null;
  if (sourcesOf) return j({ object: "list", data: customerInstruments.filter((p) => p.customer === sourcesOf[1] && p.kind === "source") });
  if (url.pathname === "/v1/customers") {
    // Stripe keeps the address a customer is created with (the required preset reads it back; Astra TAXCOUNTRY-3 P2-b reuse).
    const made = applyCustomerForm({}, form);
    if (made.address) customerIdentity = { ...customerIdentity, address: made.address };
    if (firstCustomerLost) { firstCustomerLost = false; throw new TypeError("fetch failed"); }
    if (firstCustomerReplayError) {
      const cached = firstCustomerReplayError === "cached"; firstCustomerReplayError = null;
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "parameter_invalid_empty", message: "refused" } }),
        { status: 400, headers: { "content-type": "application/json", ...(cached ? { "idempotent-replayed": "true" } : {}) } });
    }
    if (firstCustomerKeys) {
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      if (firstCustomerKeys[key]) return new Response(JSON.stringify({ id: firstCustomerKeys[key] }), { status: 200, headers: { "idempotent-replayed": "true" } });
      const id = `cus_first${++firstCustomerN}`;
      firstCustomerKeys[key] = id;
      if (firstCustomerLostApplied > 0) { firstCustomerLostApplied--; throw new TypeError("fetch failed"); }
      return j({ id });
    }
    return j({ id: "cus_test1" });
  }
  if (url.pathname.startsWith("/v1/payment_intents/") && method === "GET") {
    if (identityFails > 0) { identityFails--; return j({ error: { code: "api_connection_error" } }, 500); }
    const pi = url.pathname.split("/").pop()!;
    if (piGone.has(pi)) return j({ error: { code: "resource_missing" } }, 404);
    return j({ id: pi, object: "payment_intent", ...(piIdentity[pi] ?? { latest_charge: { payment_method_details: { type: "card", card: { fingerprint: null } }, billing_details: {} } }) });
  }
  if (url.pathname.startsWith("/v1/customers/") && method === "GET") {
    if (customerGetFails > 0) { customerGetFails--; return j({ error: { code: "api_error" } }, 500); }
    const cid = url.pathname.split("/").pop()!;
    return j({ id: cid, object: "customer", email: null, balance: 0, invoice_settings: { default_payment_method: null }, default_source: null,
      ...(newCustomers[cid] ?? customerIdentity) });
  }
  // An update PERSISTS (the address set as a whole, metadata): the next GET reads it back.
  if (url.pathname.startsWith("/v1/customers/") && method === "POST") {
    const key = new Headers(init?.headers).get("idempotency-key");
    const stored = key ? customerKeyResults[key] : undefined;
    if (stored === "inflight") return j({ error: { code: "idempotency_key_in_use", type: "idempotency_error" } }, 409);
    if (stored) return new Response(JSON.stringify(stored.body), { status: stored.status, headers: { "idempotent-replayed": "true" } });
    const mode = customerUpdateMode; customerUpdateMode = null;
    if (mode === "lost_unsent") throw new TypeError("fetch failed");
    if (mode === "refused") return j({ error: { code: "parameter_invalid", type: "invalid_request_error" } }, 400);
    if (mode === "lost_inflight") { if (key) customerKeyResults[key] = "inflight"; inflightCustomerWrite = { key: key ?? "", form }; throw new TypeError("fetch failed"); }
    customerIdentity = applyCustomerForm(customerIdentity, form);
    const body = { id: url.pathname.split("/").pop(), object: "customer", ...customerIdentity };
    if (key) customerKeyResults[key] = { status: 200, body };
    if (onCustomerUpdate) { const f = onCustomerUpdate; onCustomerUpdate = null; await f(); }
    if (mode === "lost_applied") throw new TypeError("fetch failed");
    return j(body);
  }
  if (method === "GET" && url.pathname === "/v1/invoices" && url.searchParams.has("customer") && url.searchParams.has("status")) {
    return j({ data: pendingInvoices.filter((i) => i.customer === url.searchParams.get("customer") && i.status === url.searchParams.get("status")) });
  }
  if (url.pathname === "/v1/checkout/sessions" && method === "GET") { if (sessionListThrows) throw new TypeError("fetch failed"); return j({ data: sessions }); }
  // Astra JOURNEY-A-5 #4: one session retrieved by id (its customer recovers a lost customer row).
  const oneSession = method === "GET" ? url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[^/]+)$/) : null;
  if (oneSession) { const s = sessions.find((x) => x.id === oneSession[1]); return s ? j({ ...s, customer: "cus_test1" }) : j({ error: { code: "resource_missing" } }, 404); }
  if (url.pathname === "/v1/checkout/sessions") {
    if (onSessionCreate) { const f = onSessionCreate; onSessionCreate = null; await f(); }
    const id = sessionN++ === 0 ? "cs_test_1" : `cs_test_${sessionN}`;
    sessions.unshift({ id, status: "open", subscription: null, metadata: { home_id: form.get("metadata[home_id]") ?? "",
      ...(form.get("metadata[issuance_id]") ? { issuance_id: form.get("metadata[issuance_id]")! } : {}) } });
    return j({ id, url: `https://checkout.stripe.test/c/${id}` });
  }
  const expire = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/);
  if (expire) { const s = sessions.find((x) => x.id === expire[1]); if (s?.status !== "open") return j({ error: { code: "session_not_open" } }, 400); s.status = "expired"; return j({ id: s.id, status: "expired" }); }
  if (url.pathname.startsWith("/v1/charges/")) {
    if (chargeFails > 0) { chargeFails--; return j({ error: { code: "api_connection_error" } }, 500); }
    const given = chargeObjs[url.pathname.split("/").pop() ?? ""];
    if (given) return j(given);
    return j({ id: url.pathname.split("/").pop(), customer: "cus_test1", ...(basil ? {} : { invoice: "in_1" }), payment_intent: "pi_1" });
  }
  if (url.pathname === "/v1/invoices/create_preview" && method === "POST") return j({ amount_due: upcomingTotal });
  if (url.pathname === "/v1/invoice_payments") {
    if (invoicePaymentsFails > 0) { invoicePaymentsFails--; return j({ error: { code: "api_connection_error" } }, 500); }
    const pi = url.searchParams.get("payment[payment_intent]") ?? "";
    const inv = piInvoices[pi] ?? (pi === "pi_1" ? "in_1" : null);
    return j({ data: inv ? [{ id: `inpay_${inv}`, invoice: inv, status: "paid", payment: { type: "payment_intent", payment_intent: pi } }] : [] });
  }
  if (url.pathname === "/v1/invoices" && method === "GET") { if (onInvoiceList) { const f = onInvoiceList; onInvoiceList = null; await f(); } return j({ data: paidInvoices }); }
  const invM = url.pathname.match(/^\/v1\/invoices\/(in_[^/]+?)(?:\/(finalize|pay|void))?$/);
  if (invM && invoiceStore[invM[1]]) {
    const inv = invoiceStore[invM[1]]; const act = invM[2];
    const out = () => j(basil
      ? { id: inv.id, amount_paid: inv.status === "paid" ? inv.amount_due : 0, status: inv.status, amount_due: inv.amount_due, auto_advance: inv.auto_advance,
        parent: { type: "subscription_details", subscription_details: { subscription: inv.subscription } }, billing_reason: inv.billing_reason,
        payments: { data: inv.status === "paid" ? [{ status: "paid", payment: { type: "payment_intent", payment_intent: inv.payment_intent ?? "pi_1" } }] : [] } }
      : { id: inv.id, payment_intent: inv.payment_intent ?? "pi_1", charge: "ch_1", amount_paid: inv.status === "paid" ? inv.amount_due : 0, status: inv.status,
        amount_due: inv.amount_due, auto_advance: inv.auto_advance, subscription: inv.subscription, billing_reason: inv.billing_reason });
    if (method === "DELETE") return j({ error: { code: "invoice_not_editable" } }, 400); // Stripe deletes one-off drafts only
    if (method === "GET") return out();
    if (act === "finalize") { inv.status = "open"; return out(); }
    if (act === "pay") { if (holdPay) { const h = holdPay; holdPay = null; await h; } if (payDeclines) return j({ error: { code: "card_declined" } }, 402); inv.status = "paid"; return out(); }
    if (act === "void") { inv.status = "void"; return out(); }
    if (form.get("auto_advance")) { if (invoiceHoldFails) return j({ error: { code: "api_connection_error" } }, 500); inv.auto_advance = form.get("auto_advance") === "true"; }
    return out();
  }
  if (url.pathname.startsWith("/v1/invoices/")) {
    const id = url.pathname.split("/").pop()!; const sub = invoiceSubs[id] ?? "sub_test1";
    const pi = Object.entries(piInvoices).find(([, i]) => i === id)?.[0] ?? invoicePaymentIntent;
    return j(basil
      ? { id, amount_paid: 4900, status: "paid", parent: { type: "subscription_details", subscription_details: { subscription: sub } },
        payments: { data: pi ? [{ status: "paid", payment: { type: "payment_intent", payment_intent: pi } }] : [] } }
      : { id, payment_intent: pi, charge: "ch_1", amount_paid: 4900, subscription: sub });
  }
  if (creditNotesOn && url.pathname === "/v1/credit_notes" && method === "POST") {
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    const known = creditNotes.find((n) => n.key === key);
    if (known) return j(known.note);
    const invoiceId = form.get("invoice") ?? ""; const amount = Number(form.get("refund_amount"));
    const pi = Object.entries(piInvoices).find(([, i]) => i === invoiceId)?.[0] ?? invoicePaymentIntent ?? "";
    const r = { id: `re_${refundsMade.length + 1}`, amount, status: refundStatus, payment_intent: pi, metadata: {} as Record<string, string> };
    refundsMade.push(r);
    const note = { id: `cn_${creditNotes.length + 1}`, object: "credit_note", status: "issued", invoice: invoiceId, amount: Number(form.get("amount")), created: Math.floor(Date.now() / 1000),
      metadata: { op_id: form.get("metadata[op_id]") ?? "", submission: form.get("metadata[submission]") ?? "" }, refunds: [{ refund: r.id, amount_refunded: amount }] };
    creditNotes.push({ key, note });
    return j(note);
  }
  if (creditNotesOn && url.pathname === "/v1/credit_notes" && method === "GET") return j({ data: creditNotes.map((n) => n.note).filter((n) => n.invoice === url.searchParams.get("invoice")), has_more: false });
  if (creditNotesOn && url.pathname.startsWith("/v1/credit_notes/") && method === "GET") {
    const n = creditNotes.find((x) => x.note.id === url.pathname.split("/").pop());
    return n ? j(n.note) : j({ error: { code: "resource_missing" } }, 404);
  }
  if (url.pathname === "/v1/refunds" && method === "GET") { listCalls++; return j({ data: refundsMade.filter((r) => (r.payment_intent ?? url.searchParams.get("payment_intent")) === url.searchParams.get("payment_intent")) }); }
  if (url.pathname.startsWith("/v1/refunds/") && method === "GET") return j(refundsMade.find((r) => r.id === url.pathname.split("/").pop()) ?? { error: { code: "resource_missing" } }, 200);
  if (url.pathname === "/v1/refunds") {
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    if (holdRefund) { const h = holdRefund; holdRefund = null; await h; }
    if (refundByKey[key]) return j({ id: refundByKey[key].id, status: refundByKey[key].status }); // Stripe idempotency
    if (refundFails > 0) { refundFails--; return j({ error: { code: "api_connection_error" } }, 500); }
    const r = { id: refundsMade.length === 0 ? "re_1" : `re_${refundsMade.length + 1}`, amount: Number(form.get("amount")), status: refundStatus,
      payment_intent: form.get("payment_intent") ?? "", metadata: { op_id: form.get("metadata[op_id]") ?? "", submission: form.get("metadata[submission]") ?? "" } };
    refundsMade.push(r); refundByKey[key] = r;
    if (refundLost > 0) { refundLost--; return j({ error: { code: "api_connection_error" } }, 500); } // made at Stripe, answer lost
    return j({ id: r.id, status: r.status });
  }
  if (url.pathname.startsWith("/v1/subscriptions/")) {
    const subId = url.pathname.split("/")[3];
    const st = subState[subId] ??= { status: "active", cancel_at_period_end: false, trial_end: null };
    if (method === "DELETE") { if (cancelDown500) return j({ error: { type: "api_error" } }, 500); if (cancelStuck) return j({ error: { code: "subscription_payment_intent_invalid" } }, 400); st.status = "canceled"; return j({ id: subId, ...st }); }
    if (method === "POST") {
      // A held renewal request is the one request in flight; Stripe's idempotency: a key already applied returns its saved answer and changes nothing.
      const subKey = new Headers(init?.headers).get("idempotency-key") ?? "";
      if (form.get("cancel_at_period_end") === "false" && holdSubPost) { const h = holdSubPost; holdSubPost = null; await h; }
      // Stripe caches a failed answer (a 500 included) against its key, and replays it with Idempotent-Replayed: true.
      if (cachedSubFailures.has(subKey)) return new Response(JSON.stringify({ error: { type: "api_error" } }), { status: 500, headers: { "idempotent-replayed": "true" } });
      if (form.get("cancel_at_period_end") === "true" && cancelFailNext > 0) { cancelFailNext--; cachedSubFailures.add(subKey); return j({ error: { type: "api_error" } }, 500); }
      if (subKey && subKeysApplied.has(subKey)) return j({ id: subId, ...st, status: st.status });
      if (subKey) subKeysApplied.add(subKey);
      if (form.get("trial_end")) { if (trialRejects) return j({ error: { code: "invalid_trial_end" } }, 400); st.trial_end = Number(form.get("trial_end")); }
      if (form.get("cancel_at_period_end")) st.cancel_at_period_end = form.get("cancel_at_period_end") === "true";
    }
    return j({ id: subId, ...st, status: cancelStuck ? "active" : st.status });
  }
  if (url.pathname === "/v1/tax/calculations") {
    if (taxFails) return j({ error: { code: "tax_unavailable" } }, 503);
    const rate = TAX_RATES[form.get("customer_details[address][country]") ?? ""] ?? 0;
    const items = [0, 1].filter((n) => form.get(`line_items[${n}][amount]`)).map((n) => {
      const amount = Number(form.get(`line_items[${n}][amount]`)); return { reference: form.get(`line_items[${n}][reference]`), amount, amount_tax: Math.round(amount * rate) };
    });
    const tax = items.reduce((n, i) => n + i.amount_tax, 0);
    return j({ id: "taxcalc_1", amount_total: items.reduce((n, i) => n + i.amount, 0) + tax, tax_amount_exclusive: tax, line_items: { data: items },
      tax_breakdown: taxNotCollecting ? [{ amount: 0, taxability_reason: "not_collecting" }] : [] });
  }
  return j({ error: { code: "unexpected" } }, 500);
};
let notifierFails = false;
const notifier: BillingNotifier = {
  async notify(e, n) {
    if (notifierFails) throw new Error("smtp_down");
    notices.push({ id: n.id, kind: n.kind, homeId: n.homeId, data: n.data });
    // Like the real notifier: the durable record the account page reads the confirmation from.
    // A notice recorded with its action beforehand (withdrawal, confirmed cancellation) is marked sent, as the real notifier does.
    await e.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at,sent_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sent_at=COALESCE(sent_at,excluded.sent_at)")
      .bind(n.id, n.homeId, n.kind, JSON.stringify(n.data), Date.now(), Date.now()).run();
  },
};
const flux: FluxEntitlementHooks = {
  // Astra JOURNEY-A-8 #2: a grant carrying its pending refund target applies it in the same step and answers the receipt.
  async grantMonthlyCredits(_e, input) {
    fluxLog.push({ hook: "grant", args: input });
    const t = input.initialTarget;
    return t ? { status: "granted", target: { grantId: `${input.invoiceId}:${input.kind ?? "period"}`, revision: t.revision, removedMicrocents: t.targetRemovedMicrocents,
      targetRemovedMicrocents: t.targetRemovedMicrocents } } : undefined;
  },
  async changePlan(_e, input) { fluxLog.push({ hook: "plan", args: input }); },
  async revokeCredits(_e, input) { if (revokeFails > 0) { revokeFails--; throw new FluxHookRetry("b4_down"); } fluxLog.push({ hook: "revoke", args: input }); },
  // A qualified router (Astra JOURNEY-A-6 #2/#3): versioned targets are dispatched; the receipt names the revision applied.
  capabilities: { reversalTargets: true },
  async setReversalTarget(_e, input) {
    if (revokeFails > 0) { revokeFails--; throw new FluxHookRetry("b4_down"); }
    fluxLog.push({ hook: "target", args: input });
    return { grantId: input.grantId, revision: input.revision, removedMicrocents: input.targetRemovedMicrocents, targetRemovedMicrocents: input.targetRemovedMicrocents };
  },
  async stopForBilling(_e, homeId, _d, options) { fluxLog.push({ hook: "stop", args: { homeId, ...options } }); },
  async usedIncludedCreditMicrocents(_e, input) { if (holdUsed) { const h = holdUsed; holdUsed = null; await h; } fluxLog.push({ hook: "used", args: input }); if (usedFailOn === ++usedReads) throw new Error("b4_down"); return { usedMicrocents }; },
  async setAutoRecharge(_e, input) { fluxLog.push({ hook: "autorecharge", args: input }); },
};
let signedIn: string | null = null;
const deps = (): BillingDependencies => ({ stripeFetch, notifier, flux, accountUser: async () => (signedIn ? { id: signedIn } : null), stepUp: async () => true });
const provider = (db: D1Database): ProviderAdapter => fakeProvider(db);

async function send(path: string, init: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}, d: BillingDependencies = deps()) {
  await seedPendingQuotes();
  const ctx = createExecutionContext();
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  const response = await createWorker(fetch, fetch, { provider }, {}, d).fetch(new Request(`https://admin.murage.test${path}`, {
    method: init.method ?? "POST", body, headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10", ...init.headers } }), baseEnv(envOver), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const get = (path: string) => send(path, { method: "GET" });
/** Astra INTEGRATED-10: a dispute-credit operator call with Flux ON (the switch, its configuration and qualified hooks); off it is 503. */
async function creditOp(path: string, body: unknown) {
  const saved = envOver;
  envOver = { ...envOver, CLOUD_FLUX_ROUTES_ENABLED: "1", FLUX_CLOUD_SERVICE_TOKEN: "s".repeat(40), FLUX_API_BASE: "https://api.fluxrouter.ai" };
  try {
    return await send(path, { body, headers: { authorization: `Bearer ${ADMIN}` } },
      { ...deps(), flux: { ...flux, stub: false, capabilities: { reversalTargets: true } } as unknown as FluxEntitlementHooks });
  } finally { envOver = saved; }
}
const admin = { authorization: `Bearer ${ADMIN}` };
let evtN = 0;
const stripeEvent = (type: string, object: Record<string, unknown>, created = NOW / 1000) => ({ id: `evt_legal${++evtN}abcd`, type, created, data: { object } });
async function hook(event: unknown) {
  const raw = JSON.stringify(event);
  return send("/v1/billing/webhook", { raw, headers: { "stripe-signature": await signStripePayload(raw, WHSEC, Math.floor(Date.now() / 1000)) } });
}
const reconcile = () => send("/v1/fake-b3/reconcile", { body: {}, headers: admin });
/** The lifecycle reports the home ready (its canary passed): from here the service counts as supplied. */
async function serviceUp() {
  const h = (await env.DB.prepare("SELECT generation FROM cloud_homes WHERE id='home-1'").first<{ generation: number }>())!;
  expect((await send("/v1/fake-b3/homes/home-1/canary", { body: { generation: h.generation, imageDigest: IMAGE, checks: { authenticatedUI: true,
    engineRoundTrip: true, sandboxedBrowser: true, writableState: true, schedulerHeartbeat: true } }, headers: admin })).status).toBe(200);
  // The ready email is handed off when it is queued (Astra JOURNEY-B-2 #6: the refund clock runs from that handoff).
  await env.DB.prepare("UPDATE billing_notices SET sent_at=COALESCE(sent_at,created_at) WHERE kind='server_ready' AND home_id='home-1'").run();
}
const count = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).first<{ n: number }>())!.n;
/** env.DB on which every run of the one-per-person check's LAST query (firstPaymentCheck's "uncaptured earlier first payment") calls
 *  `onCheck(n)` (n = 1, 2, ... per run) right after it answers: a point after the identity check passed, before anything is committed.
 *  Returning "pending" makes that check answer identity_check_unavailable (a fact not readable right now), so a request is recorded and
 *  waits. Since 2026-10-12 the B4 credit read is no longer on this path, so the races it used to stage are staged here. */
const identityRace = (onCheck: (n: number) => Promise<"pending" | void>, base: D1Database = env.DB): D1Database => {
  let n = 0;
  return new Proxy(base, { get(t, k) {
    if (k === "prepare") return (sql: string) => {
      const stmt = t.prepare(sql);
      if (!sql.startsWith("SELECT 1 AS x FROM billing_subscriptions s WHERE s.first_invoice_id IS NOT NULL")) return stmt;
      return { bind: (...a: unknown[]) => { const b = stmt.bind(...a); return { first: async () => {
        const r = await b.first(); return (await onCheck(++n)) === "pending" ? { x: 1 } : r; } }; } } as unknown as D1PreparedStatement;
    };
    const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
  } });
};
const getHome = async () => (await env.DB.prepare("SELECT * FROM cloud_homes WHERE id='home-1'").first<Home>())!;
const invoice = (over: Record<string, unknown> = {}) => ({ object: "invoice", id: "in_1", customer: "cus_test1", subscription: "sub_test1",
  billing_reason: "subscription_create", amount_paid: 4900, payment_intent: "pi_1",
  lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: NOW / 1000, end: NOW / 1000 + 30 * 86400 } }] }, ...over });

async function reserve() {
  expect((await send("/v1/fake-b3/reserve", { body: { homeId: "home-1", installationId: INSTALL, ownerId: OWNER,
    publicOrigin: "https://home-1.murage.test", idempotencyKey: "reserve-key-home-1-0001" }, headers: admin })).status).toBe(201);
}
/** Since r13 the route takes no quote and never delays a start. The tests below that exercise what the webhooks still do for a consent made BEFORE r13
 *  (a Stripe Tax quote bound to it, or the EU delayed start) get that legacy consent by writing it onto the row the route created. WP5 removes the
 *  delayed-start and quote-total paths together with these tests. */
async function checkout(plan = "starter", over: Record<string, unknown> = {}, quote: TaxQuoteRow | null = null) {
  const country = String(over.billingCountry ?? over.declaredCountry ?? "US").toUpperCase();
  const legacyDelayed = over.earlyStart === false || (quote !== null && isEuRegion(country) && over.earlyStart !== true);
  const { earlyStart: _early, ...rest } = over;
  const res = await send("/v1/billing/checkout", { body: { homeId: "home-1", plan, consent: consentFor(plan, Date.now(), legacyDelayed ? rest : over, quote) }, headers: admin });
  if (res.status === 200 && (quote || legacyDelayed)) {
    const id = await latestConsentId("home-1");
    if (quote) {
      const taxed = quote.source === "stripe_tax" && quote.total_cents !== null;
      await env.DB.prepare(`UPDATE checkout_consents SET quote_id=?, tax_source=?, quoted_tax_cents=?, quoted_total_cents=?, quoted_topup_total_cents=?, postal_code=?, tax_line=?,
        disclosure=json_set(disclosure,'$.tax',json(?)) WHERE id=?`)
        .bind(quote.id, quote.source, quote.tax_cents, quote.total_cents, quote.topup_total_cents, quote.postal_code,
          taxed ? JSON.stringify({ shownBeforeConsent: true, taxCents: quote.tax_cents, totalCents: quote.total_cents }) : null,
          JSON.stringify({ quoteId: quote.id, source: quote.source, priceCents: quote.price_cents, taxCents: quote.tax_cents, totalCents: quote.total_cents }), id).run();
    }
    if (legacyDelayed) {
      const start = Date.now() + 15 * 86_400_000;
      await env.DB.prepare("UPDATE checkout_consents SET early_start=0, delayed_start=1, start_at=?, first_charge_at=?, effective_start_at=? WHERE id=?").bind(start, start, start, id).run();
      await env.DB.prepare("UPDATE billing_subscriptions SET service_start_at=?, first_charge_at=? WHERE home_id='home-1'").bind(start, start).run();
    }
  }
  return res;
}
/** The Stripe Tax quote the page asks for before the boxes are shown (operator form, naming the home). */
async function quoteFor(plan: string, country: string, postalCode?: string, topupAmountUsd?: number) {
  const res = await send("/v1/legal/quote", { body: { plan, country, ...(postalCode ? { postalCode } : {}), ...(topupAmountUsd ? { topupAmountUsd } : {}), homeId: "home-1" }, headers: admin });
  expect(res.status).toBe(200);
  const d = await res.json() as { tax: { quoteId: string } };
  return (await getQuote(d.tax.quoteId))!;
}
/** A delayed-start checkout needs the quote shown next to the boxes (Stripe Tax up, the quote priced) and Stripe's upcoming total equal to it. */
async function delayedCheckout(plan = "starter", country = "NL", postal = "1011") {
  taxFails = false;
  const q = await quoteFor(plan, country, postal);
  upcomingTotal = q.total_cents!;
  expect((await checkout(plan, { billingCountry: country }, q)).status).toBe(200);
  return q;
}
async function sessionCompleted(over: Record<string, unknown> = {}, paymentStatus = "paid", created = NOW / 1000) {
  // The session as our checkout issued it for the consent it names (boundSession: hash, price, seller, created, the real line item).
  const res = await hook(stripeEvent("checkout.session.completed", await boundSession({ object: "checkout.session", id: "cs_test_1", mode: "subscription", payment_status: paymentStatus,
    customer: "cus_test1", subscription: "sub_test1", invoice: "in_1", client_reference_id: "home-1", amount_total: 4900, total_details: { amount_tax: 0 },
    // The billing address is the one the customer declared on our page (the guard compares them).
    customer_details: { address: { country: (await env.DB.prepare("SELECT declared_country AS c FROM checkout_consents WHERE home_id='home-1' ORDER BY created_at DESC, rowid DESC LIMIT 1").first<{ c: string }>())?.c ?? "US" } },
    consent: { terms_of_service: "accepted" },
    metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1") } }, over, retrievable), created));
  // WP4 r1-4: the terms are accepted at order completion. WP5 calls recordAcceptanceAtCompletion from this verified handler; until that
  // lands, the helper stands in for it, for an order the handler actually completed.
  const done = await env.DB.prepare("SELECT id,completed_at FROM checkout_consents WHERE home_id='home-1' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1")
    .first<{ id: string; completed_at: number }>();
  if (done) await recordAcceptanceAtCompletion(env, done.id, done.completed_at);
  return res;
}
async function paidUs(over: Record<string, unknown> = {}) {
  await reserve();
  expect((await checkout("starter", over)).status).toBe(200);
  expect((await sessionCompleted()).status).toBe(200);
  expect((await hook(stripeEvent("invoice.paid", invoice()))).status).toBe(200);
  expect((await reconcile()).status).toBe(200);
  await readyAtPayment();
}
/** B3: the refund clock runs from the later of the payment and the server-ready day. These fixtures' servers count as ready when paid
 *  (ready_at = NOW, as the ready email would have said), so their 7 days still run from NOW. */
const readyAtPayment = () => env.DB.prepare("UPDATE cloud_homes SET ready_at=COALESCE(ready_at,?) WHERE id='home-1'").bind(NOW).run();

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stripeCalls = []; notices = []; fluxLog = []; usedMicrocents = 0; invoicePaymentIntent = "pi_1"; notifierFails = false; evtN = 0; signedIn = null;
  sessionN = 0; sessions = []; paidInvoices = []; refundsMade = []; refundFails = 0; refundLost = 0; taxFails = false; holdPay = null; cancelFailNext = 0; cachedSubFailures.clear(); holdUsed = null;
  refundStatus = "succeeded"; sessionListThrows = false; revokeFails = 0; cancelStuck = false; cancelDown500 = false; chargeFails = 0; invoicePaymentsFails = 0; chargeObjs = {}; listCalls = 0; onSessionCreate = null; onInvoiceList = null; envOver = {}; useSellerEnv(() => baseEnv(envOver));
  subState = {}; upcomingTotal = 4900; holdRefund = null; holdSubPost = null; trialRejects = false; refundByKey = {};
  invoiceStore = {}; invoiceHoldFails = false; subKeysApplied.clear(); usedReads = 0; usedFailOn = null; payDeclines = false;
  basil = false; invoiceSubs = {}; piInvoices = {}; taxNotCollecting = false; retrievable = {}; holdRetrieve = null; creditNotesOn = false; creditNotes = [];
  piIdentity = {}; piGone = new Set(); customerIdentity = {}; customerGetFails = 0; firstCustomerLost = false; firstCustomerKeys = null; firstCustomerLostApplied = 0; firstCustomerN = 0; firstCustomerReplayError = null; onCustomerUpdate = null; pendingInvoices = []; customerUpdateMode = null; customerKeyResults = {}; inflightCustomerWrite = null; identityFails = 0;
  newCustomers = {}; newCustomerN = 0; customerCreateMode = null; inflightCustomerCreate = null; customerCreditNotes = []; customerInstruments = []; customerInvoices = [];
  await env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'L','legal@example.test',1,?,?)`).bind(OWNER, NOW, NOW).run();
  await env.DB.prepare(`INSERT INTO installations (id,owner_user_id,client_instance_id,display_name,platform,created_at,updated_at)
    VALUES (?,?,?,'L','linux',?,?)`).bind(INSTALL, OWNER, INSTALL, NOW, NOW).run();
});
afterEach(() => vi.restoreAllMocks());

describe("checkout wording (CHECKOUT.md, verbatim)", () => {
  it("serves the renewal statement, the boxes and the dates from one source", async () => {
    const res = await get("/v1/legal/disclosure?plan=pro");
    expect(res.status).toBe(200);
    const d = await res.json() as ReturnType<typeof buildDisclosure>;
    // Before a Stripe Tax quote there is no statement to agree to (no checkout without a quote); the priced one carries the same wording.
    expect(d.variants.immediate.renewalText).toBeNull();
    expect(buildDisclosure("pro", NOW, { id: "q", user_id: OWNER, plan: "pro", country: "US", postal_code: null, price_cents: 9900, tax_cents: 0, total_cents: 9900,
      topup_amount_cents: 2000, topup_tax_cents: 0, topup_total_cents: 2000, source: "stripe_tax", calculation_id: "c", created_at: NOW, expires_at: NOW + 3_600_000 })
      .variants.immediate.renewalText).toContain("Pro renews monthly at US$99 plus applicable tax, charged on the same day each month until you cancel. Today's total is $99.00 in USD. If you pay in another currency, renewal amounts may change with exchange rates. "
      + "Cancel any time from your account page, with one click and no call or email. Your server runs to the end of the month you paid for. "
      + "Ask within 7 days of the day your server is ready and we refund your first month in full.");
    expect(d.variants.immediate.startDate).toBe(isoDate(NOW));
    expect(d.variants.immediate.nextChargeDate).toBe(isoDate(addMonthUtc(NOW)));
    // r13: there is no delayed variant any more.
    expect(d.wording.terms).toBe("I have read and agree to the Murage Cloud terms, the Terms of Service and the Privacy Policy");
    expect(d.wording.authorization).toBe("I authorize Ferrox Labs, LLC to charge my payment method for this monthly subscription until I cancel.");
    expect(d.wording.arbitration).toBe("Disputes go to individual arbitration, not class actions, unless you are a consumer in the EU, EEA, UK or Switzerland. You can opt out within 30 days of ticking this box: email privacy@murage.ai.");
    expect(d.wording.earlyStart).toBe("Start my service before the 14-day withdrawal period ends. If I withdraw, I understand I may pay proportionately for service actually supplied, subject to the 7-day refund offer.");
    expect(d.wording.nearEarlyStart).toBe("If you buy as a consumer in the EU, EEA or UK and want your server right away, tick the start-now box.");
    expect(d.euCountries).toEqual(expect.arrayContaining(["DE", "FR", "NO", "IS", "LI", "GB"]));
    expect(d.euCountries).not.toContain("CH");
    expect(d.topupDefaults).toMatchObject({ amountUsd: 20, thresholdUsd: 5, capUsd: 100 });
    expect((await get("/v1/legal/disclosure?plan=enterprise")).status).toBe(400);
  });
});

describe("server-side consent gate and log", () => {
  it("refuses an unticked terms box or an unticked authorization before any customer or session exists", async () => {
    await reserve();
    for (const over of [{ termsAccepted: false }, { recurringAuthorized: false }]) {
      const res = await checkout("starter", over);
      expect(res.status).toBe(400); expect(await res.json()).toEqual({ error: "consent_required" });
    }
    expect(stripeCalls).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents")).toBe(0);
  });
  it("ignores a start-now request from outside the EU/EEA/UK (r13), refuses a stale renewal text, a wrong screen and a bad top-up", async () => {
    await reserve();
    // r13: the request is recorded false outside the listed countries, no error (it used to be 400 early_start_not_available)
    expect((await checkout("starter", { earlyStart: true, billingCountry: "US" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT early_start AS e, eu_region AS r FROM checkout_consents WHERE home_id='home-1'").first()).toEqual({ e: 0, r: 0 });
    await env.DB.prepare("DELETE FROM open_checkouts").run(); stripeCalls = [];
    expect(await (await checkout("starter", { renewalText: "Starter renews whenever" })).json()).toEqual({ error: "disclosure_stale" });
    expect(await (await checkout("starter", { screenVersion: "old" })).json()).toEqual({ error: "disclosure_stale" });
    expect(await (await checkout("starter", { topup: { enabled: true, amountUsd: 50, thresholdUsd: 5, capUsd: 20 } })).json()).toEqual({ error: "topup_invalid" });
    expect(stripeCalls).toEqual([]);
  });
  it("logs one record per checkout: versions, boxes, texts, country, tax id, plan and price, UTC time, IP and user agent", async () => {
    await reserve();
    const res = await checkout("pro", { taxId: "DE123456789", billingCountry: "DE", earlyStart: true,
      topup: { enabled: true, amountUsd: 25, thresholdUsd: 8, capUsd: 150 } });
    expect(res.status).toBe(200);
    const row = (await env.DB.prepare("SELECT * FROM checkout_consents").first<Record<string, unknown>>())!;
    expect(row).toMatchObject({ home_id: "home-1", user_id: OWNER, email: "legal@example.test", created_at: NOW, screen_version: SCREEN_VERSION,
      cloud_terms_version: LEGAL_DOCS.cloudTerms.versionId, tos_version: LEGAL_DOCS.termsOfService.versionId, privacy_version: LEGAL_DOCS.privacyPolicy.versionId,
      terms_accepted: 1, recurring_authorized: 1, early_start: 1, eu_region: 1, topup_enabled: 1, topup_amount_cents: 2500, topup_threshold_cents: 800,
      topup_cap_cents: 15000, billing_country: "DE", tax_id: "DE123456789", plan: "pro", price_cents: 9900, delayed_start: 0, start_at: NOW,
      ip: "198.51.100.7", ip_seen: "203.0.113.10", user_agent: "vitest-browser/1" });
    expect(row.renewal_text).toBe(consentFor("pro", NOW, { billingCountry: "DE", earlyStart: true }).renewalText);
    const wording = JSON.parse(row.wording as string) as Record<string, string>;
    // r1-3: the words shown (the disclosure lines in page order, then the top-up switch), never the pre-r13 checkbox wording.
    for (const k of ["terms", "authorization", "arbitration", "earlyStart", "nearEarlyStart"]) expect(wording).not.toHaveProperty(k);
    expect(row.wording as string).not.toContain("proportionately");
    expect(Object.entries(wording).filter(([k]) => !k.startsWith("topup")).map(([, v]) => v).join("\n")).toBe(row.renewal_text);
    expect(row.start_request_text).toBe("Start my server and continue to payment");
    expect(wording.topupBox).toBe("Top up my Flux credits automatically: add $25 whenever my balance falls below $8, up to a monthly cap of $150. I can change the amount or the cap, or turn this off, at any time.");
    expect(wording.topupCharge).toContain("up to $150 per calendar month. The cap resets at 00:00 UTC on the first day of each month. It covers automatic top-up charges only, not my plan or manual purchases.");
    expect(row.stripe_session_id).toBe("cs_test_1");
  });
  it("unticked top-up box stores no authorization; the numbers shown are still logged", async () => {
    await reserve();
    await checkout("starter", { topup: { enabled: false, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } });
    expect(await env.DB.prepare("SELECT topup_enabled AS e, topup_text AS t FROM checkout_consents").first()).toEqual({ e: 0, t: null });
    expect(await count("SELECT COUNT(*) AS n FROM topup_settings")).toBe(0);
  });
});

describe("start date and Stripe session", () => {
  it("US buyer: starts and is charged today, with the renewal statement beside Stripe's pay button", async () => {
    await reserve(); await checkout("starter");
    const cs = stripeCalls.find((c) => c.path === "/v1/checkout/sessions")!;
    expect(cs.form.get("subscription_data[trial_end]")).toBeNull();
    // the links go to the marketing site (murage.ai), never the cloud origin
    // 2026-10-14 (plan §3.2, option 1): the renewal sentence opens the submit message, then the acceptance links
    expect(cs.form.get("custom_text[submit][message]")).toBe(`Renews each month at US$49 + tax until you cancel in your account. ${submitText("en", "full", { terms: "https://murage.ai/cloud-terms", tos: "https://murage.ai/terms-of-service", privacy: "https://murage.ai/privacy-policy" })}`);
    expect(cs.form.get("locale")).toBe("en"); expect(cs.form.get("submit_type")).toBeNull();
    expect(cs.form.get("metadata[consent_id]")).toMatch(/^consent-/);
    expect(cs.form.get("subscription_data[metadata][consent_id]")).toBe(cs.form.get("metadata[consent_id]"));
    expect(stripeCalls.find((c) => c.path === "/v1/customers")!.form.get("address[country]")).toBe("US");
  });
  it("EU buyer (r13): there is no delayed start. The line proves the early-start request; service and first charge begin at the press", async () => {
    await reserve();
    const res = await checkout("starter", { billingCountry: "FR" });
    expect(Object.keys(await res.json() as object).sort()).toEqual(["consentId", "locale", "policyVersion", "sessionId", "url"]);
    const cs = stripeCalls.find((c) => c.path === "/v1/checkout/sessions")!;
    expect(cs.form.get("subscription_data[trial_end]")).toBeNull();
    expect(await env.DB.prepare("SELECT early_start AS e, delayed_start AS d, start_at AS s, first_charge_at AS f, effective_start_at AS es, start_request_at AS r FROM checkout_consents").first())
      .toEqual({ e: 1, d: 0, s: NOW, f: NOW, es: NOW, r: NOW });
    // The server start is written at payment (paid_at), not at the button press.
    expect(await env.DB.prepare("SELECT service_start_at AS s, first_charge_at AS f FROM billing_subscriptions").first()).toEqual({ s: null, f: NOW });
  });
  it("EU buyer who ticks the start-now box starts and pays today, and the request is on record", async () => {
    await reserve();
    await checkout("starter", { billingCountry: "GB", earlyStart: true });
    expect(stripeCalls.find((c) => c.path === "/v1/checkout/sessions")!.form.get("subscription_data[trial_end]")).toBeNull();
    expect(await env.DB.prepare("SELECT early_start AS e, delayed_start AS d FROM checkout_consents").first()).toEqual({ e: 1, d: 0 });
  });
});

describe("durable confirmation before service starts", () => {
  it("is handed off before the payment reaches the lifecycle: a mail failure holds service back and the retry sends it", async () => {
    await reserve(); await checkout("starter");
    notifierFails = true;
    expect((await sessionCompleted()).status).toBe(500);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox")).toBe(0);
    notifierFails = false;
    vi.mocked(Date.now).mockReturnValue(NOW + 5 * 60_000); // past the retry backoff
    await sweepBilling(baseEnv(), deps());
    expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox")).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "active" });
  });
  it("archives the exact text of the documents accepted, and keeps the confirmation on the account page", async () => {
    await paidUs(); signedIn = OWNER;
    const row = await env.DB.prepare("SELECT text,sha256 FROM legal_doc_archive WHERE version_id=?").bind(LEGAL_DOCS.cloudTerms.versionId).first<{ text: string; sha256: string }>();
    expect(row).toEqual({ text: LEGAL_DOCS.cloudTerms.text, sha256: LEGAL_DOCS.cloudTerms.sha256 });
    expect(await count("SELECT COUNT(*) AS n FROM legal_doc_archive")).toBe(3);
    const res = await get("/v1/account/confirmation");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ subject: "Murage Cloud: your order confirmation and contract copy", text: expect.stringContaining(LEGAL_DOCS.termsOfService.text) });
  });
  it("carries full copies, not links: both documents with version ids, the plan, renewal and cancel text, tax", async () => {
    await paidUs();
    const mail = notices.find((n) => n.kind === "confirmation")!.data as { emailSubject: string; emailText: string; emailHtml: string };
    const t = mail.emailText;
    expect(t).toContain(LEGAL_DOCS.cloudTerms.text);
    expect(t).toContain(LEGAL_DOCS.termsOfService.text);
    expect(t).toContain(`version ${LEGAL_DOCS.cloudTerms.versionId}`);
    expect(t).toContain(`version ${LEGAL_DOCS.termsOfService.versionId}`);
    expect(t).toContain("Plan: Starter");
    expect(t).toContain("Price: $49 a month");
    expect(t).toContain(consentFor("starter", NOW).renewalText);
    expect(t).toContain("press the Cancel plan button: https://cloud.murage.test/home/cloud.");
    expect(t).toContain("once a year to remind you");
    expect(t).toContain("Refund: ask within 7 days");
    expect(t).toContain("Charged at checkout: $49.00 (tax $0.00).");
    expect(t).not.toContain("MODEL WITHDRAWAL FORM"); // US buyer
    expect(t).not.toContain("EARLY-START REQUEST");
    expect(t).not.toContain("TOP-UP AUTHORIZATION");
    expect(mail.emailHtml).toContain("Murage Cloud terms");
  });
  it("EU buyer with early start and top-up: withdrawal instructions, the model form, and copies of both requests", async () => {
    await reserve();
    await checkout("starter", { billingCountry: "DE", earlyStart: true, topup: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } });
    expect((await sessionCompleted({ customer_details: { address: { country: "DE" } } })).status).toBe(200);
    const t = (notices.find((n) => n.kind === "confirmation")!.data as { emailText: string }).emailText;
    expect(t).toContain(MODEL_WITHDRAWAL_FORM);
    expect(t).toContain("right to withdraw from this contract within 14 days");
    expect(t).toContain("COPY OF YOUR EARLY-START REQUEST");
    // r1-3: from the snapshot (the EU line shown and our button pressed), never the old checkbox wording
    expect(t).not.toContain(WORDING.earlyStart); expect(t).not.toContain("proportionately");
    expect(t).toContain("EU, EEA and UK: your server starts as soon as you pay, at your request.");
    expect(t).toContain('You pressed: "Start my server and continue to payment"');
    expect(t).toContain("COPY OF YOUR AUTOMATIC TOP-UP AUTHORIZATION");
    expect(t).toContain("add $20 whenever my balance falls below $5, up to a monthly cap of $100");
    expect(t).toContain("Amount: $20.00. Trigger: balance below $5.00. Monthly cap: $100.00.");   // no quote, so no "including tax" figure (r13)
    // The top-up authorization is stored for B4 once the subscription exists.
    expect(await env.DB.prepare("SELECT enabled,amount_cents,threshold_cents,cap_cents,cap_period FROM topup_settings").first())
      .toEqual({ enabled: 1, amount_cents: 2000, threshold_cents: 500, cap_cents: 10000, cap_period: "calendar month" });
  });
  it("no consent named, no service: refused durably against the consent bound to the session (2026-10-14: never thrown back to Stripe)", async () => {
    await reserve(); await checkout("starter");
    // Before 2026-10-14 this threw consent_missing (500, retried forever, orphan subscription left live). The session is bound to this home's
    // consent at creation, so the order is now refused through the tombstone path (Astra NO-DROPDOWN-1 (3)).
    expect((await sessionCompleted({ metadata: { home_id: "home-1", plan: "starter", consent_id: undefined } })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents WHERE rejected_reason='rejected_consent'")).toBe(1);
  });
});

describe("data retention wording follows config.retentionMs", () => {
  it("renders whole days from CLOUD_B3_CONFIG, in every email that states it", () => {
    const withRetention = (ms: number) => baseEnv({ CLOUD_B3_CONFIG: JSON.stringify({ ...B3, retentionMs: ms }) } as Partial<Env>);
    expect(retentionDaysText(withRetention(30 * DAY))).toBe("30 days");
    expect(retentionDaysText(withRetention(14 * DAY))).toBe("14 days");
    // Rounded down, never up: the email must not promise more than the deletion schedule keeps (Astra MAKERKIT2 #4).
    expect(retentionDaysText(withRetention(29.6 * DAY))).toBe("29 days");
    expect(retentionDaysText(withRetention(30 * DAY - 1))).toBe("29 days");
    expect(retentionDaysText(withRetention(DAY + 23 * 3_600_000))).toBe("1 day");
    expect(retentionDaysText(withRetention(DAY))).toBe("1 day");
    // B3 off: nothing is deleted by the schedule; the production default stands in.
    expect(retentionDaysText(baseEnv({ CLOUD_B3_MODE: undefined } as Partial<Env>))).toBe("30 days");
    const end = buildTermsReminderEmail({ portalOrigin: "https://murage.test", periodEnd: NOW, stage: "end", retention: retentionDaysText(withRetention(21 * DAY)) });
    expect(end.text).toContain("we keep your data for 21 days.");
  });
});

describe("online cancel", () => {
  it("records the confirmation email in the same transaction as the confirmed cancellation: a send that never happens is delivered by the sweep, once (Astra MAKERKIT2 #3)", async () => {
    await paidUs(); signedIn = OWNER; stripeCalls = []; notices = [];
    // The send is interrupted (here: the home is busy when it runs; equally a crash right after the commit).
    const interrupted: BillingNotifier = { async notify(e, n, lease) { if (n.kind === "cancel_scheduled") throw new HomeBusy(); return notifier.notify(e, n, lease); } };
    expect(await (await send("/v1/account/cancel-plan", { body: {} }, { ...deps(), notifier: interrupted })).json()).toMatchObject({ canceled: true });
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(0);
    const row = await env.DB.prepare("SELECT payload,sent_at FROM billing_notices WHERE kind='cancel_scheduled'").first<{ payload: string; sent_at: number | null }>();
    expect(row?.sent_at).toBeNull();
    expect((JSON.parse(row!.payload) as { emailText: string }).emailText).toContain("You cancelled your Murage Cloud plan.");
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(1);
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(1);
  });
  it("one call ends the plan at the end of the paid period at Stripe, records it, and emails the confirmation (no support step)", async () => {
    await paidUs(); signedIn = OWNER; stripeCalls = []; notices = [];
    const res = await send("/v1/account/cancel-plan", { body: {} });
    expect(res.status).toBe(200);
    const call = stripeCalls.find((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_test1")!;
    expect(call.method).toBe("POST"); expect(call.form.get("cancel_at_period_end")).toBe("true");
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c FROM billing_subscriptions").first()).toEqual({ c: 1 });
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(1);
    // The retention in the confirmation is the deletion schedule's own config.retentionMs (14 days here), never a literal.
    const cancelText = (notices.find((n) => n.kind === "cancel_scheduled")!.data as { emailText: string }).emailText;
    expect(cancelText).toContain("we keep your data for 14 days."); expect(cancelText).not.toContain("30 days");
    expect((await getHome()).desired_state).toBe("checking"); // still running until the period ends
    // A second press does not call Stripe again.
    stripeCalls = [];
    expect(await (await send("/v1/account/cancel-plan", { body: {} })).json()).toMatchObject({ canceled: true, alreadyScheduled: true });
    expect(stripeCalls).toEqual([]);
    // The webhook that follows does not send a second confirmation.
    await hook(stripeEvent("customer.subscription.updated", { object: "subscription", id: "sub_test1", customer: "cus_test1", status: "active",
      cancel_at_period_end: true, current_period_start: NOW / 1000, current_period_end: NOW / 1000 + 30 * 86400,
      items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }, NOW / 1000 + 5));
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(1);
  });
  it("needs a signed-in customer with a subscription", async () => {
    await paidUs();
    expect((await send("/v1/account/cancel-plan", { body: {} })).status).toBe(401);
    signedIn = "someone-else";
    expect((await send("/v1/account/cancel-plan", { body: {} })).status).toBe(404);
  });
  it("My Cloud summary tells the page what to show", async () => {
    await paidUs(); signedIn = OWNER;
    const s = await (await get("/v1/account/cloud")).json() as { subscription: Record<string, unknown>; topup: Record<string, unknown>; exportRequest: unknown };
    expect(s.subscription).toMatchObject({ plan: "starter", planName: "Starter", priceUsd: 49, status: "active", cancelAtPeriodEnd: false, refundWindowEndsAt: aoeEnd(NOW, 7) }); // WP5: the frozen refund7_until (AoE), never +168 h
    expect(s.topup).toMatchObject({ enabled: false, amountUsd: 20, thresholdUsd: 5, capUsd: 100 });
    expect(s.exportRequest).toBeNull();
  });
});

describe("My Cloud summary after a public (§312k) cancellation (Stripe cancel_at, never cancel_at_period_end)", () => {
  const END = NOW + 30 * 86_400_000;
  type Sum = { subscription: { cancelAtPeriodEnd: boolean; activeUntil: number | null; cancellation?: unknown } };
  const summaryNow = async () => ((await (await get("/v1/account/cloud")).json()) as Sum).subscription;
  const subRow = () => env.DB.prepare("SELECT cancel_at, cancel_at_period_end, cancel_intent_rev, cancel_synced_rev FROM billing_subscriptions WHERE home_id='home-1'").first();
  let reqN = 0;
  /** A matched end_of_paid_month declaration as the public flow leaves it: synced (stripe_cancel_at stamped) or not yet. */
  async function publicCancel(at: number, synced: boolean, status = "open") {
    const id = `cx-sum-${++reqN}`;
    await env.DB.prepare(`INSERT INTO cancellation_requests (id,ref,received_at,fields_json,kind,entered_email,entered_name,confirm_email,language,match_state,
      attribution_basis,home_id,subscription_id,effective_at,hold_until,status,receipt_sha256,stripe_synced,stripe_cancel_at,created_at,updated_at)
      VALUES (?,?,?,'{}','ordinary_earliest','a@example.test','A','a@example.test','en','matched','account_email','home-1','sub_test1',?,?,?,'00',?,?,?,?)`)
      .bind(id, `REF-${id}`, NOW, at, at, status, synced ? 1 : 0, synced ? at : null, NOW, NOW).run();
    return id;
  }
  /** A confirmed cancel_at mutation, computed (by default) for the declarations as they stand now (their revision, migration 0092). */
  const mutation = async (value: number | null, rev?: { rev: string; n: number }) => {
    // The revision as migration 0092 documents it: '|' + sorted 'id:last_op' ('-' for none) joined by '|' + '|', and the count.
    const rows = (await env.DB.prepare("SELECT id,last_op FROM cancellation_requests WHERE subscription_id='sub_test1' AND match_state='matched'")
      .all<{ id: string; last_op: string | null }>()).results;
    const r = rev ?? { rev: `|${rows.map((x) => `${x.id}:${x.last_op ?? "-"}`).sort().join("|")}|`, n: rows.length };
    await env.DB.prepare(`INSERT INTO cancellation_stripe_mutations (id,subscription_id,home_id,kind,value,idempotency_key,state,created_at,resolved_at,decl_rev,decl_n)
      VALUES (?,'sub_test1','home-1','cancel_at',?,?,'confirmed',?,?,?,?)`).bind(`m-${++reqN}`, value, `cxlmut:m-${reqN}`, NOW, NOW, r.rev, r.n).run();
  };
  /** customer.subscription.updated carrying `cancelAt`; Stripe's subscription NOW shows `live` (by default the same: the newest event). */
  const updated = (cancelAt: number | null, live: number | null = cancelAt) => {
    (subState.sub_test1 ??= { status: "active", cancel_at_period_end: false, trial_end: null }).cancel_at = live === null ? null : live / 1000;
    return hook(stripeEvent("customer.subscription.updated", { object: "subscription", id: "sub_test1", customer: "cus_test1", status: "active",
      cancel_at_period_end: false, cancel_at: cancelAt === null ? null : cancelAt / 1000, current_period_start: NOW / 1000, current_period_end: END / 1000,
      items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }, NOW / 1000 + 5));
  };
  const drift = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancellation.stripe_drift'");
  beforeEach(async () => {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_end=? WHERE home_id='home-1'").bind(END).run();
  });

  it("(e) a brand-new subscription renews: cancelAtPeriodEnd false, activeUntil the period end", async () => {
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: false, activeUntil: END }));
  });
  it("(a) public end_of_paid_month cancel, Stripe confirmed, no webhook yet: Cancelled, runs until the period end", async () => {
    await publicCancel(END, true);
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: true, activeUntil: END }));
    expect(await subRow()).toEqual({ cancel_at: null, cancel_at_period_end: 0, cancel_intent_rev: 0, cancel_synced_rev: 0 });
  });
  it("(a') the cancel_at mutation confirmed before the declaration was marked synced also counts; a kept declaration does not", async () => {
    await publicCancel(END, false); await mutation(END / 1000);
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: true, activeUntil: END }));
    await env.DB.prepare("UPDATE cancellation_requests SET status='kept' WHERE home_id='home-1'").run();
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: false, activeUntil: END }));
  });
  it("(b) the webhook stores Stripe's cancel_at (in-app flag and revisions untouched, no second email); a later cancel_at is not this period", async () => {
    expect((await updated(END)).status).toBe(200);
    expect(await subRow()).toEqual({ cancel_at: END, cancel_at_period_end: 0, cancel_intent_rev: 0, cancel_synced_rev: 0 });
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: true, activeUntil: END }));
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(0);
    expect((await updated(END + 30 * 86_400_000)).status).toBe(200);
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: false, activeUntil: END }));
    expect((await updated(null)).status).toBe(200);
    expect(await subRow()).toMatchObject({ cancel_at: null });
    expect(await drift()).toBe(0);
  });
  it("(c) cancel_at null while a confirmed public cancellation is open: the row keeps it, the page stays Cancelled, ops are alerted", async () => {
    await publicCancel(END, true);
    expect((await updated(END)).status).toBe(200);
    expect((await updated(null)).status).toBe(200);
    expect(await subRow()).toMatchObject({ cancel_at: END, cancel_at_period_end: 0 });
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: true, activeUntil: END }));
    expect(await drift()).toBe(1);
  });
  it("(f) Astra CS-1 #1: the original cancellation event delivered late, after Keep my plan and its clear, never brings 'won't renew' back", async () => {
    const id = await publicCancel(END, true);
    expect((await updated(END)).status).toBe(200);
    expect(await subRow()).toMatchObject({ cancel_at: END });
    // Keep my plan: the declaration closes as kept and Stripe's cancel_at is cleared; the clear's event arrives first.
    await env.DB.prepare("UPDATE cancellation_requests SET status='kept', kept_by='customer' WHERE id=?").bind(id).run();
    expect((await updated(null)).status).toBe(200);
    expect(await subRow()).toMatchObject({ cancel_at: null });
    // The original cancellation's event, delivered late (Stripe does not order events): Stripe now shows no cancel_at.
    const before = stripeCalls.length;
    expect((await updated(END, null)).status).toBe(200);
    expect(await subRow()).toMatchObject({ cancel_at: null, cancel_at_period_end: 0 });
    expect(stripeCalls.slice(before).some((c) => c.method === "GET" && c.path === "/v1/subscriptions/sub_test1")).toBe(true);
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: false, activeUntil: END }));
    // The renewal reminder's selection sees a plan that renews again.
    expect(await count(`SELECT COUNT(*) AS n FROM billing_subscriptions b WHERE b.home_id='home-1' AND NOT ${endingSql("b")}`)).toBe(1);
  });
  it("Astra CS-1 #3 probe 1: an older synced later-date declaration never masks the newer earlier end Stripe confirmed for the current revision", async () => {
    const EARLY = END - 10 * DAY;
    await publicCancel(END, true);                  // synced earlier, stamped with the later date
    await publicCancel(EARLY, false);               // newer, earlier end: its pass confirmed the mutation, the stamps not written yet
    await mutation(EARLY / 1000);
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: true, activeUntil: EARLY }));
    // A clear confirmed for the current revision is the newest state: nothing is confirmed as ending.
    await mutation(null);
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: false, activeUntil: END }));
  });
  it("Astra CS-1 #3 probe 2: after Keep (Stripe already cleared by drift) an old positive mutation never confirms a new, unsynced declaration", async () => {
    const a = await publicCancel(END, true);
    await mutation(END / 1000);                     // confirmed for the revision {a}
    // Stripe's cancel_at was cleared outside the flow; Keep my plan then found nothing to send, and its pass stamped the declaration.
    await env.DB.prepare("UPDATE cancellation_requests SET status='kept', kept_by='customer', last_op='op-keep', stripe_synced=1, stripe_cancel_at=NULL WHERE id=?").bind(a).run();
    await publicCancel(END, false);                 // a new declaration, not yet sent to Stripe
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: false, activeUntil: END }));
  });
  it("Astra CS-1 #7: an ended subscription (status canceled, no cancellation fields, period end ahead) is ended, never Active with a next charge", async () => {
    // An immediate Dashboard cancellation: Stripe sends customer.subscription.deleted; both cancellation fields stay empty.
    expect((await hook(stripeEvent("customer.subscription.deleted", { object: "subscription", id: "sub_test1", customer: "cus_test1", status: "canceled",
      cancel_at_period_end: false, cancel_at: null, items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }, NOW / 1000 + 5))).status).toBe(200);
    const row = (await env.DB.prepare("SELECT status, cancel_at, cancel_at_period_end, current_period_end, updated_at FROM billing_subscriptions WHERE home_id='home-1'")
      .first<{ status: string; cancel_at: number | null; cancel_at_period_end: number; current_period_end: number; updated_at: number }>())!;
    expect(row).toMatchObject({ status: "canceled", cancel_at: null, cancel_at_period_end: 0, current_period_end: END });
    const s = await summaryNow() as unknown as Record<string, unknown>;
    expect(s).toMatchObject({ status: "canceled", ended: true, endedAt: row.updated_at, cancelAtPeriodEnd: true, activeUntil: row.updated_at,
      cancellation: { state: null, endsAt: null, id: null, kind: null, keepable: false, keepIds: [] } });
    expect(s.activeUntil).not.toBe(END);
  });
  it("(d) Astra CS-1 #6: an in-app cancel journaled but not yet synced to Stripe is pending, not Cancelled; once synced it is confirmed", async () => {
    await env.DB.prepare("UPDATE billing_subscriptions SET customer_cancel_at=?, cancel_intent_rev=cancel_intent_rev+1 WHERE home_id='home-1'").bind(NOW).run();
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: false, activeUntil: END,
      cancellation: { state: "pending", endsAt: END, id: null, kind: null, keepable: false, keepIds: [] } }));
    await env.DB.prepare("UPDATE billing_subscriptions SET cancel_synced_rev=cancel_intent_rev, cancel_at_period_end=1 WHERE home_id='home-1'").run();
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: true, activeUntil: END,
      cancellation: expect.objectContaining({ state: "confirmed", endsAt: END }) }));
  });
  it("Astra CS-1 #6: a public cancellation Stripe has not confirmed is pending (keepable, cancelAtPeriodEnd false); confirmed once stamped", async () => {
    const id = await publicCancel(END, false);
    await env.DB.prepare("UPDATE cancellation_requests SET account_id=? WHERE id=?").bind(OWNER, id).run();
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: false, activeUntil: END,
      cancellation: { state: "pending", endsAt: END, id, kind: "ordinary_earliest", keepable: true, keepIds: [id] } }));
    await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=1, stripe_cancel_at=? WHERE id=?").bind(END, id).run();
    expect(await summaryNow()).toEqual(expect.objectContaining({ cancelAtPeriodEnd: true, activeUntil: END,
      cancellation: { state: "confirmed", endsAt: END, id, kind: "ordinary_earliest", keepable: true, keepIds: [id] } }));
  });
});

describe("yearly renewal reminder", () => {
  const mails: { to: string; subject: string; text: string }[] = [];
  const withMail = () => baseEnv({ EMAIL: { async send(m: { to: string; subject: string; text: string }) { mails.push(m); } } } as unknown as Partial<Env>);
  it("goes out once, 30 days before each yearly anniversary, only while the plan is renewing", async () => {
    await paidUs(); mails.length = 0;
    const mailDeps: BillingDependencies = { stripeFetch, flux };
    await env.DB.prepare("UPDATE billing_subscriptions SET service_start_at=?,reminder_due_at=NULL").bind(NOW - 340 * DAY).run();
    await sweepBilling(withMail(), mailDeps);
    const reminders = mails.filter((m) => m.subject.includes("yearly reminder"));
    expect(reminders).toHaveLength(1);
    expect(reminders[0].to).toBe("legal@example.test");
    expect(reminders[0].text).toContain("Starter renews monthly at US$49 plus applicable tax, charged on the same day each month until you cancel.");
    expect(reminders[0].text).toContain("press Cancel plan on your account page");
    await sweepBilling(withMail(), mailDeps); // repeated sweeps do not repeat it
    expect(mails.filter((m) => m.subject.includes("yearly reminder"))).toHaveLength(1);
    // Not yet due, and not for a plan that is ending anyway.
    await env.DB.prepare("DELETE FROM billing_notices WHERE kind='renewal_reminder'").run();
    await env.DB.prepare("UPDATE billing_subscriptions SET service_start_at=?,reminder_due_at=NULL").bind(NOW - 300 * DAY).run();
    mails.length = 0; await sweepBilling(withMail(), mailDeps);
    expect(mails.filter((m) => m.subject.includes("yearly reminder"))).toHaveLength(0);
    await env.DB.prepare("UPDATE billing_subscriptions SET service_start_at=?,cancel_at_period_end=1,reminder_due_at=NULL").bind(NOW - 340 * DAY).run();
    await sweepBilling(withMail(), mailDeps);
    expect(mails.filter((m) => m.subject.includes("yearly reminder"))).toHaveLength(0);
  });
  it("Astra CS-1 #5: a cancellation committed between the sweep's selection and its lease sends no reminder, nor does a retry of a failed one", async () => {
    await paidUs(); mails.length = 0;
    const mailDeps: BillingDependencies = { stripeFetch, flux };
    const end = NOW + 20 * DAY;
    await env.DB.prepare("UPDATE billing_subscriptions SET service_start_at=?,reminder_due_at=NULL,current_period_end=? WHERE home_id='home-1'").bind(NOW - 340 * DAY, end).run();
    const cancelPublicly = () => env.DB.prepare(`INSERT INTO cancellation_requests (id,ref,received_at,fields_json,kind,entered_email,entered_name,confirm_email,language,match_state,
      attribution_basis,home_id,subscription_id,effective_at,hold_until,status,receipt_sha256,stripe_synced,stripe_cancel_at,created_at,updated_at)
      VALUES ('cx-race','REF-cx-race',?,'{}','ordinary_earliest','a@example.test','A','a@example.test','en','matched','account_email','home-1','sub_test1',?,?,'open','00',1,?,?,?)`)
      .bind(NOW, end, end, end, NOW, NOW).run();
    // The public cancellation commits right after the sweep selected the due reminders, before it takes the home's lease.
    let raced = false;
    const racing = new Proxy(env.DB, { get(t, k) {
      if (k === "prepare") return (sql: string) => {
        const stmt = t.prepare(sql);
        if (!sql.includes("b.reminder_due_at<=?")) return stmt;
        return { bind: (...a: unknown[]) => { const b = stmt.bind(...a); return { all: async () => {
          const r = await b.all(); if (!raced && r.results.length > 0) { raced = true; await cancelPublicly(); } return r; } }; } } as unknown as D1PreparedStatement;
      };
      const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
    } });
    await sweepBilling({ ...withMail(), DB: racing } as Env, mailDeps);
    expect(raced).toBe(true);
    expect(mails.filter((m) => m.subject.includes("yearly reminder"))).toHaveLength(0);
    // A reminder whose earlier send failed (recorded, unsent) is retried by the sweep: not while the plan is ending, and it is withdrawn.
    await env.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at) VALUES ('renewal_reminder:home-1:1','home-1','renewal_reminder',?,?)")
      .bind(JSON.stringify({ subscriptionId: "sub_test1", emailSubject: "Murage Cloud: your plan renews every month (yearly reminder)", emailText: "renews" }), NOW).run();
    await sweepBilling(withMail(), mailDeps);
    expect(mails.filter((m) => m.subject.includes("yearly reminder"))).toHaveLength(0);
    expect(await env.DB.prepare("SELECT sent_at, canceled_at IS NOT NULL AS c FROM billing_notices WHERE id='renewal_reminder:home-1:1'").first()).toEqual({ sent_at: null, c: 1 });
    // Keep my plan: the plan renews again and the reminder (still due) goes out once.
    await env.DB.prepare("UPDATE cancellation_requests SET status='kept', kept_by='customer' WHERE id='cx-race'").run();
    await sweepBilling(withMail(), mailDeps);
    expect(mails.filter((m) => m.subject.includes("yearly reminder"))).toHaveLength(1);
  });
  it("a public (§312k) cancellation Stripe confirmed gets no renewal reminder; after Keep my plan it goes out again", async () => {
    await paidUs(); mails.length = 0;
    const mailDeps: BillingDependencies = { stripeFetch, flux };
    const end = NOW + 20 * DAY;
    await env.DB.prepare("UPDATE billing_subscriptions SET service_start_at=?,reminder_due_at=NULL,current_period_end=? WHERE home_id='home-1'").bind(NOW - 340 * DAY, end).run();
    await env.DB.prepare(`INSERT INTO cancellation_requests (id,ref,received_at,fields_json,kind,entered_email,entered_name,confirm_email,language,match_state,
      attribution_basis,home_id,subscription_id,effective_at,hold_until,status,receipt_sha256,stripe_synced,stripe_cancel_at,created_at,updated_at)
      VALUES ('cx-rem','REF-cx-rem',?,'{}','ordinary_earliest','a@example.test','A','a@example.test','en','matched','account_email','home-1','sub_test1',?,?,'open','00',1,?,?,?)`)
      .bind(NOW, end, end, end, NOW, NOW).run();
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ c: 0 });
    await sweepBilling(withMail(), mailDeps);
    expect(mails.filter((m) => m.subject.includes("yearly reminder"))).toHaveLength(0);
    // Keep my plan: the declaration is no longer open, so the plan renews and the (still due) reminder goes out on the next sweep.
    await env.DB.prepare("UPDATE cancellation_requests SET status='kept', kept_by='customer' WHERE id='cx-rem'").run();
    await sweepBilling(withMail(), mailDeps);
    expect(mails.filter((m) => m.subject.includes("yearly reminder"))).toHaveLength(1);
  });
});

describe("first-month refund", () => {
  async function paidWithTax() {
    await reserve(); expect((await checkout("starter")).status).toBe(200);
    await sessionCompleted(); await hook(stripeEvent("invoice.paid", invoice({ amount_paid: 5390, total_tax_amounts: [{ amount: 490 }] }))); await reconcile();
    await readyAtPayment();
  }
  const refund = (body: Record<string, unknown>, headers: Record<string, string> = admin) => send("/v1/admin/refund-first-month", { body, headers });
  it("is the full first month's fee, tax included, whatever included credit was used (Sean 2026-10-12: nothing deducted)", async () => {
    await paidWithTax(); usedMicrocents = 80_000_000; // heavy use: $80 of included credit, more than the whole fee
    const dry = await (await refund({ homeId: "home-1", dryRun: true })).json() as { quote: Record<string, unknown> };
    expect(dry.quote).toMatchObject({ eligible: true, reason: null, feeCents: 4900, taxCents: 490, usedCreditCents: 0, refundNetCents: 4900, refundTaxCents: 490, refundCents: 5390 });
    expect(stripeCalls.some((c) => c.method === "POST" && c.path === "/v1/refunds")).toBe(false);
    const res = await refund({ homeId: "home-1" });
    expect(res.status).toBe(200);
    const call = stripeCalls.find((c) => c.method === "POST" && c.path === "/v1/refunds")!;
    expect(call.form.get("amount")).toBe("5390"); expect(call.form.get("payment_intent")).toBe("pi_1");
    expect(call.headers.get("idempotency-key")).toBe(`refundop:firstmonth:${OWNER}:1`); // one key per submission
    // Usage is never read for money: the quote and the decision do not call the B4 usage hook.
    expect(fluxLog.some((f) => f.hook === "used")).toBe(false);
    // The plan ends and its credits are still taken back.
    expect(stripeCalls.some((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_test1")).toBe(true);
    expect(fluxLog.some((f) => f.hook === "stop")).toBe(true);
    expect(await env.DB.prepare("SELECT amount_cents,used_credit_cents,stripe_refund_id FROM first_month_refunds").first()).toEqual({ amount_cents: 5390, used_credit_cents: 0, stripe_refund_id: "re_1" });
    // Never more than was paid: the ledger caps the target at the payment.
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false } });
  });
  it("is given once per customer", async () => {
    await paidWithTax();
    expect((await refund({ homeId: "home-1" })).status).toBe(200);
    const again = await refund({ homeId: "home-1" });
    expect(again.status).toBe(409); expect(await again.json()).toMatchObject({ error: "already_refunded" });
    expect(stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds")).toHaveLength(1);
  });
  it("is closed after 7 days and for abuse closures, never because of credits used", async () => {
    await paidWithTax();
    // WP5 r1-5: the offer ends at the consent's frozen refund7_until (AoE end of day 7), not after exactly 168 hours.
    vi.mocked(Date.now).mockReturnValue(aoeEnd(NOW, 7));
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true, windowEndsAt: aoeEnd(NOW, 7) } });
    vi.mocked(Date.now).mockReturnValue(aoeEnd(NOW, 7) + 1);
    expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "window_expired" });
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
    // Only an explicit, evidenced closure disqualifies (Astra #16); the route needs evidence.
    expect((await send("/v1/admin/abuse-closure", { body: { homeId: "home-1", evidence: "short" }, headers: admin })).status).toBe(400);
    expect((await send("/v1/admin/abuse-closure", { body: { homeId: "home-1", evidence: "Crypto mining on the home, ticket OPS-123, logs attached." }, headers: admin })).status).toBe(200);
    expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "abuse_closure" });
    await env.DB.batch([env.DB.prepare("DELETE FROM abuse_closures"), env.DB.prepare("UPDATE billing_subscriptions SET abuse_closed_at=NULL")]);
    usedMicrocents = 80_000_000; // credits used worth more than the fee: still the full fee
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true, reason: null, refundCents: 5390, usedCreditCents: 0 } });
    expect(stripeCalls.some((c) => c.method === "POST" && c.path === "/v1/refunds")).toBe(false);
  });
  it("is an operator route", async () => {
    await paidWithTax();
    expect((await refund({ homeId: "home-1" }, {})).status).toBe(401);
  });
  it("#9 a usage hook that throws (the pre-B4 stub) never blocks or reduces a refund: there is no credit_usage_unavailable path", async () => {
    await paidWithTax();
    const b4Down: BillingDependencies = { ...deps(), flux: { ...flux, usedIncludedCreditMicrocents: stubFluxHooks.usedIncludedCreditMicrocents } };
    const dry = await (await send("/v1/admin/refund-first-month", { body: { homeId: "home-1", dryRun: true }, headers: admin }, b4Down)).json() as { quote: Record<string, unknown> };
    expect(dry.quote).toMatchObject({ eligible: true, reason: null, refundCents: 5390 });
    const res = await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, b4Down);
    expect(res.status).toBe(200);
    expect(stripeCalls.find((c) => c.method === "POST" && c.path === "/v1/refunds")!.form.get("amount")).toBe("5390");
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='refund.stuck'").first()).toBeNull();
  });

  // Astra NODEDUCT-1: requests the previous version decided with a credit deduction (or refused as all_credit_used) and never paid.
  const posted = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds").map((c) => c.form.get("amount"));
  const ledgerOf = async () => (await env.DB.prepare("SELECT decided_cents FROM refund_invoice_ledger WHERE invoice_id='in_1'").first<{ decided_cents: number }>())!.decided_cents;
  /** Rewrites the failed refund attempt (a 500 from Stripe: an intent was journaled, nothing was made) into the state the previous version left: decided, never submitted. */
  const unsubmitFailedRefund = async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE refund_ops SET submission=0,submitted_at=NULL,last_error=NULL WHERE kind='first_month'"),
      env.DB.prepare("DELETE FROM refund_submission_journal"),
    ]);
    // The failed attempt made nothing at Stripe: it is not part of what the tests count as submitted.
    for (let i = stripeCalls.length - 1; i >= 0; i--) if (stripeCalls[i].method === "POST" && stripeCalls[i].path === "/v1/refunds") stripeCalls.splice(i, 1);
    refundsMade = [];
  };
  /** A request decided (now at the full $53.90) whose cancellation fails before any refund is submitted, then rewritten into the decision the
   *  previous version made: the $49 fee less $10 of credits used = $39 + $3.90 tax = $42.90, reserved in the invoice's ledger. */
  async function legacyDeductedUnpaid() {
    await paidWithTax();
    refundFails = 1_000; // Stripe cannot take the refund: decided, nothing paid
    expect((await refund({ homeId: "home-1" })).status).toBe(202);
    refundFails = 0;
    await unsubmitFailedRefund();
    const op = (await env.DB.prepare("SELECT id,detail,amount_cents,submission,submitted_at,refunded_at FROM refund_ops WHERE kind='first_month'")
      .first<{ id: string; detail: string; amount_cents: number; submission: number; submitted_at: number | null; refunded_at: number | null }>())!;
    expect(op).toMatchObject({ amount_cents: 5390, submission: 0, submitted_at: null, refunded_at: null });
    expect(posted()).toEqual([]);
    await env.DB.batch([
      env.DB.prepare("UPDATE refund_ops SET target_cents=4290,amount_cents=4290,detail=? WHERE id=?").bind(JSON.stringify({ ...JSON.parse(op.detail), usedCreditCents: 1000 }), op.id),
      env.DB.prepare("UPDATE refund_invoice_ledger SET decided_cents=decided_cents-1100 WHERE invoice_id='in_1'"),
    ]);
    expect(await ledgerOf()).toBe(4290);
    return op.id;
  }

  it("NODEDUCT-1 #1 a legacy decided-but-unpaid deduction (cancellation failed, nothing submitted) is upgraded to the full invoice; the reservation is replaced", async () => {
    const id = await legacyDeductedUnpaid();
    vi.mocked(Date.now).mockReturnValue(NOW + DAY);
    await sweepBilling(baseEnv(envOver), deps());
    await sweepBilling(baseEnv(envOver), deps());
    // Fee + tax, once: never the old $42.90, never a second refund.
    expect(posted()).toEqual(["5390"]);
    const row = (await env.DB.prepare("SELECT target_cents,amount_cents,basis,detail,done_at FROM refund_ops WHERE id=?").bind(id)
      .first<{ target_cents: number; amount_cents: number; basis: string; detail: string; done_at: number | null }>())!;
    expect(row).toMatchObject({ target_cents: 5390, amount_cents: 5390, basis: "seven_day_offer" });
    expect(row.done_at).not.toBeNull();
    expect(JSON.parse(row.detail)).toMatchObject({ legacyUpgradedFromCents: 4290 });
    expect(JSON.parse(row.detail).usedCreditCents).toBeUndefined();
    // The ledger reservation was replaced (4290 -> 5390), not added to: never more than was paid.
    expect(await ledgerOf()).toBe(5390);
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE id LIKE 'legacyrest:%'")).toBe(0);
    expect(await env.DB.prepare("SELECT amount_cents,stripe_refund_id FROM first_month_refunds").first()).toEqual({ amount_cents: 5390, stripe_refund_id: "re_1" });
  });

  it("NODEDUCT-1 #1 a legacy deduction Stripe already refunded (the answer was lost) is reconciled first: only the capped remainder is issued", async () => {
    const id = await legacyDeductedUnpaid();
    // The previous version submitted $42.90 and never saw the answer: Stripe holds that refund for this operation.
    refundsMade.push({ id: "re_legacy", amount: 4290, status: "succeeded", payment_intent: "pi_1", metadata: { op_id: id, submission: "1" } });
    vi.mocked(Date.now).mockReturnValue(NOW + DAY);
    await sweepBilling(baseEnv(envOver), deps()); // the parent adopts re_legacy, and the rest is opened
    await sweepBilling(baseEnv(envOver), deps()); // the rest is decided under the ledger rule and paid
    await sweepBilling(baseEnv(envOver), deps()); // and nothing more, ever
    expect(posted()).toEqual(["1100"]);
    expect(await env.DB.prepare("SELECT stripe_refund_id,amount_cents FROM refund_ops WHERE id=?").bind(id).first()).toEqual({ stripe_refund_id: "re_legacy", amount_cents: 4290 });
    const rest = (await env.DB.prepare("SELECT amount_cents,basis,done_at,end_plan FROM refund_ops WHERE id=?").bind(`legacyrest:${id}`)
      .first<{ amount_cents: number; basis: string; done_at: number | null; end_plan: number }>())!;
    expect(rest).toMatchObject({ amount_cents: 1100, basis: "seven_day_offer", end_plan: 0 });
    expect(rest.done_at).not.toBeNull();
    // $42.90 + $11.00 = the full $53.90 paid, and the aggregate never exceeds it.
    expect(await ledgerOf()).toBe(5390);
    expect(await count("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refund_ops WHERE invoice_id='in_1' AND decided_at IS NOT NULL")).toBe(5390);
    // The person's one refund record stays the parent's.
    expect(await env.DB.prepare("SELECT stripe_refund_id FROM first_month_refunds").first()).toEqual({ stripe_refund_id: "re_legacy" });
    expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='refund_declined'")).toBe(0);
  });

  it("NODEDUCT-1 #2 a legacy all_credit_used refusal is reopened by a fresh retry within 7 days and paid the full invoice, once", async () => {
    await paidWithTax();
    refundFails = 1_000; // Stripe cannot take the refund: decided, nothing paid
    expect((await refund({ homeId: "home-1" })).status).toBe(202);
    refundFails = 0;
    await unsubmitFailedRefund();
    const op = (await env.DB.prepare("SELECT id,detail FROM refund_ops WHERE kind='first_month'").first<{ id: string; detail: string }>())!;
    // The refusal the previous version recorded after a usage outage: zero refund, positive saved usage, finished; the slot released.
    await env.DB.batch([
      env.DB.prepare("UPDATE refund_ops SET target_cents=0,amount_cents=0,basis='all_credit_used',detail=?,notified_at=?,done_at=?,last_error=NULL WHERE id=?")
        .bind(JSON.stringify({ ...JSON.parse(op.detail), usedCreditCents: 4900 }), NOW, NOW, op.id),
      env.DB.prepare("UPDATE refund_invoice_ledger SET decided_cents=decided_cents-5390 WHERE invoice_id='in_1'"),
      env.DB.prepare("DELETE FROM refund_identity_claims WHERE op_id=?").bind(op.id),
      env.DB.prepare("DELETE FROM first_month_refunds"),
    ]);
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
    const res = await refund({ homeId: "home-1" });
    expect(res.status).toBe(200);
    expect(posted()).toEqual(["5390"]);
    const row = (await env.DB.prepare("SELECT basis,amount_cents,detail,done_at FROM refund_ops WHERE id=?").bind(op.id)
      .first<{ basis: string; amount_cents: number; detail: string; done_at: number | null }>())!;
    expect(row).toMatchObject({ basis: "seven_day_offer", amount_cents: 5390 });
    expect(row.done_at).not.toBeNull();
    expect(JSON.parse(row.detail).usedCreditCents).toBeUndefined();
    expect(await ledgerOf()).toBe(5390);
    expect(await env.DB.prepare("SELECT amount_cents,stripe_refund_id FROM first_month_refunds").first()).toEqual({ amount_cents: 5390, stripe_refund_id: "re_1" });
    // One refund per person: asking again is refused, nothing more is paid.
    const again = await refund({ homeId: "home-1" });
    expect(again.status).toBe(409);
    expect(posted()).toEqual(["5390"]);
  });

  // Astra NODEDUCT-2.
  /** The already_refunded zero the previous version recorded because of its usage deduction: $53.90 paid, $10 used -> $42.90 target, while
   *  another route had already refunded $45 on the invoice (in its ledger). Finished and notified; no slot, no claims, nothing reserved. */
  async function legacyAlreadyRefunded() {
    await paidWithTax();
    refundFails = 1_000; // Stripe cannot take the refund: decided, nothing paid
    expect((await refund({ homeId: "home-1" })).status).toBe(202);
    refundFails = 0;
    await unsubmitFailedRefund();
    const op = (await env.DB.prepare("SELECT id,detail FROM refund_ops WHERE kind='first_month'").first<{ id: string; detail: string }>())!;
    await env.DB.batch([
      env.DB.prepare("UPDATE refund_ops SET target_cents=4290,amount_cents=0,basis='seven_day_offer',detail=?,notified_at=?,done_at=?,last_error=NULL WHERE id=?")
        .bind(JSON.stringify({ ...JSON.parse(op.detail), usedCreditCents: 1000 }), NOW, NOW, op.id),
      env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,paid_cents,target_cents,amount_cents,end_plan,decided_at,refunded_at,done_at,created_at,updated_at)
        VALUES ('extraordinary:prior','extraordinary','home-1',?,'in_1',5390,4500,4500,0,?,?,?,?,?)`).bind(OWNER, NOW, NOW, NOW, NOW, NOW),
      env.DB.prepare("UPDATE refund_invoice_ledger SET decided_cents=4500 WHERE invoice_id='in_1'"),
      env.DB.prepare("DELETE FROM refund_identity_claims WHERE op_id=?").bind(op.id),
      env.DB.prepare("DELETE FROM first_month_refunds"),
    ]);
    expect(await ledgerOf()).toBe(4500);
    return op.id;
  }
  /** env.DB whose next batch carrying the legacy reopening fails before anything is written (a rolled-back D1 failure), `times` times. */
  const failingReopenDb = (times: number): D1Database => {
    let armed = false;
    return new Proxy(env.DB, { get(t, k) {
      if (k === "withSession") return undefined;
      if (k === "prepare") return (sql: string) => { if (times > 0 && sql.includes("notified_at=NULL,done_at=NULL")) armed = true; return t.prepare(sql); };
      if (k === "batch") return async (stmts: D1PreparedStatement[]) => {
        if (armed) { armed = false; times--; throw new Error("D1_ERROR: simulated network failure"); }
        return t.batch(stmts);
      };
      const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
    } });
  };

  it("NODEDUCT-2 #1 a legacy already_refunded zero caused by the deduction ($45 already refunded) is reopened and pays the $8.90 rest, once", async () => {
    const id = await legacyAlreadyRefunded();
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
    const res = await refund({ homeId: "home-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ refunded: true, amountCents: 890 });
    expect(posted()).toEqual(["890"]);
    const row = (await env.DB.prepare("SELECT basis,target_cents,amount_cents,detail,done_at FROM refund_ops WHERE id=?").bind(id)
      .first<{ basis: string; target_cents: number; amount_cents: number; detail: string; done_at: number | null }>())!;
    expect(row).toMatchObject({ basis: "seven_day_offer", target_cents: 5390, amount_cents: 890 });
    expect(row.done_at).not.toBeNull();
    expect(JSON.parse(row.detail).usedCreditCents).toBeUndefined();
    // $45 + $8.90 = the $53.90 paid: never more.
    expect(await ledgerOf()).toBe(5390);
    expect(await count("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refund_ops WHERE invoice_id='in_1' AND decided_at IS NOT NULL")).toBe(5390);
    expect(await env.DB.prepare("SELECT amount_cents,stripe_refund_id FROM first_month_refunds").first()).toEqual({ amount_cents: 890, stripe_refund_id: "re_1" });
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims WHERE op_id=?", id)).toBeGreaterThan(0);
    // One refund per person: asking again is refused, nothing more is paid.
    expect((await refund({ homeId: "home-1" })).status).toBe(409);
    expect(posted()).toEqual(["890"]);
  });

  it("NODEDUCT-2 #1 a legacy already_refunded zero is never reopened while another payment holds the person's one slot", async () => {
    const id = await legacyAlreadyRefunded();
    await env.DB.prepare("INSERT INTO first_month_refunds (user_id,home_id,invoice_id,amount_cents,used_credit_cents,created_at) VALUES (?,'home-other','in_other',4900,0,?)")
      .bind(OWNER, NOW).run();
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
    const res = await refund({ homeId: "home-1" });
    expect(res.status).toBe(409);
    expect(posted()).toEqual([]);
    expect(await env.DB.prepare("SELECT basis,amount_cents FROM refund_ops WHERE id=?").bind(id).first()).toEqual({ basis: "seven_day_offer", amount_cents: 0 });
  });

  it("NODEDUCT-2 #2 a database failure while reopening is a retryable error (not 409 already_refunded), changes nothing, and the retry succeeds", async () => {
    const id = await legacyAlreadyRefunded();
    const before = await env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(id).first();
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
    envOver = { ...envOver, DB: failingReopenDb(1) };
    const res = await refund({ homeId: "home-1" });
    envOver = {};
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "internal_error" });
    // Rolled back: the old refusal exactly as it was, no slot, no notice cancelled, nothing paid.
    expect(await env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(id).first()).toEqual(before);
    expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(0);
    expect(await ledgerOf()).toBe(4500);
    expect(posted()).toEqual([]);
    // Asked again: reopened and paid the rest, once.
    const again = await refund({ homeId: "home-1" });
    expect(again.status).toBe(200);
    expect(posted()).toEqual(["890"]);
    expect(await ledgerOf()).toBe(5390);
  });

  // Astra NODEDUCT-3.
  /** The request the previous version (c883ffc7c) opened and then decided, run as that version's decide() ran for first_month: opened by
   *  the route (slot reserved, payment pinned) while still owed, then another route refunded $45 on the invoice before the decision; its
   *  quote deducted the measured $10 usage (keepDeduction kept it on the operation): $49 - $10 = $39 + $3.90 tax = $42.90 <= $45, so
   *  owed 0, reason already_refunded, and the batch saved basis = reason, target 0, amount = max(0, min(0, paid) - already) = 0, revoke
   *  false, the ledger version bumped by 0 and the slot released. The current code then finishes it (notice, done). */
  async function oldDecisionAlreadyRefunded(usedCents = 1000) {
    await paidWithTax();
    const id = `firstmonth:${OWNER}`;
    const pinned = (await pinCurrentPayment(env, "home-1"))!;
    const consentId = await latestConsentId("home-1");
    const [ins, insBinds] = refundOpInsert({ id, kind: "first_month", homeId: "home-1", userId: OWNER, invoiceId: pinned.invoiceId, paymentIntent: pinned.paymentIntent,
      subscriptionId: "sub_test1", endPlan: true, detail: { pay: pinned, ...(consentId ? { consentId } : {}) } }, NOW);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO first_month_refunds (user_id,home_id,invoice_id,amount_cents,used_credit_cents,created_at) VALUES (?,'home-1',?,4290,?,?)")
        .bind(OWNER, pinned.invoiceId, usedCents, NOW),
      env.DB.prepare(ins).bind(...(insBinds ?? [])),
      env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,paid_cents,target_cents,amount_cents,end_plan,decided_at,refunded_at,done_at,created_at,updated_at)
        VALUES ('extraordinary:prior','extraordinary','home-1',?,?,5390,4500,4500,0,?,?,?,?,?)`).bind(OWNER, pinned.invoiceId, NOW, NOW, NOW, NOW, NOW),
      env.DB.prepare(`INSERT INTO refund_invoice_ledger (invoice_id,version,decided_cents) VALUES (?,1,4500)
        ON CONFLICT(invoice_id) DO UPDATE SET version=version+1,decided_cents=decided_cents+4500`).bind(pinned.invoiceId),
    ]);
    // keepDeduction: the first measurement is written to the operation at once.
    const op = (await env.DB.prepare("SELECT detail FROM refund_ops WHERE id=?").bind(id).first<{ detail: string }>())!;
    const detail = { ...JSON.parse(op.detail), usedCreditCents: usedCents } as Record<string, unknown>;
    // The old quote (quoteFirstMonthRefund with the saved usage).
    const paid = pinned.paidCents; const tax = pinned.taxCents; const fee = Math.max(0, paid - tax);
    const already = await count("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refund_ops WHERE invoice_id=? AND decided_at IS NOT NULL AND id<>?", pinned.invoiceId, id);
    const used = Math.min(fee, usedCents); const net = Math.max(0, fee - used); const netTax = fee > 0 ? Math.round(tax * net / fee) : 0;
    const owed = Math.max(0, net + netTax - already);
    const reason = net === 0 ? "all_credit_used" : owed === 0 ? "already_refunded" : null;
    expect({ paid, tax, oldTarget: net + netTax, already, owed, reason }).toEqual({ paid: 5390, tax: 490, oldTarget: 4290, already: 4500, owed: 0, reason: "already_refunded" });
    // The old decide(): basis, target, revoke, then batch(target, basis, detail, claimOffer=false).
    const basis = owed > 0 ? "seven_day_offer" : reason ?? "not_eligible"; const target = owed > 0 ? net + netTax : 0;
    detail.revoke = paid > 0 && target > 0;
    const ledger = (await env.DB.prepare("SELECT version,decided_cents FROM refund_invoice_ledger WHERE invoice_id=?").bind(pinned.invoiceId).first<{ version: number; decided_cents: number }>())!;
    const amount = paid > 0 ? Math.max(0, Math.min(target, paid) - ledger.decided_cents) : 0;
    const at = NOW + 3_600_000;
    await env.DB.batch([
      env.DB.prepare(`UPDATE refund_ops SET invoice_id=?,payment_intent=?,paid_cents=?,target_cents=?,amount_cents=?,basis=?,detail=?,decided_at=?,updated_at=?
        WHERE id=? AND decided_at IS NULL`).bind(pinned.invoiceId, pinned.paymentIntent, paid, target, amount, basis, JSON.stringify(detail), at, at, id),
      env.DB.prepare("UPDATE refund_invoice_ledger SET version=version+1,decided_cents=decided_cents+? WHERE invoice_id=? AND version=?").bind(amount, pinned.invoiceId, ledger.version),
      env.DB.prepare("DELETE FROM first_month_refunds WHERE user_id=? AND stripe_refund_id IS NULL").bind(OWNER),
    ]);
    // The current code finishes the decided refusal (notice, done) as the old one did.
    vi.mocked(Date.now).mockReturnValue(at);
    const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
    await advanceRefundOp(baseEnv(), { stripe: st, flux, deps: deps(), now: at }, id).catch(() => undefined);
    const row = (await env.DB.prepare("SELECT basis,target_cents,amount_cents,paid_cents,detail,refunded_at,submitted_at FROM refund_ops WHERE id=?").bind(id)
      .first<{ basis: string; target_cents: number; amount_cents: number; paid_cents: number; detail: string; refunded_at: number | null; submitted_at: number | null }>())!;
    // Exactly the shape Astra read from production: already_refunded, target 0, amount 0, usedCreditCents 1000.
    expect(row).toMatchObject({ basis: "already_refunded", target_cents: 0, amount_cents: 0, paid_cents: 5390, refunded_at: null, submitted_at: null });
    expect(JSON.parse(row.detail).usedCreditCents).toBe(usedCents);
    expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(0);
    expect(await ledgerOf()).toBe(4500);
    return id;
  }

  it("NODEDUCT-3 #1 the old decision's actual already_refunded zero (target 0, usage 1000, $45 refunded) is reopened by a retry and pays $8.90 once", async () => {
    const id = await oldDecisionAlreadyRefunded();
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
    const dry = await (await refund({ homeId: "home-1", dryRun: true })).json() as { quote: Record<string, unknown> };
    expect(dry.quote).toMatchObject({ eligible: true, refundCents: 890 });
    const res = await refund({ homeId: "home-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ refunded: true, amountCents: 890 });
    expect(posted()).toEqual(["890"]);
    const row = (await env.DB.prepare("SELECT basis,target_cents,amount_cents,detail,done_at FROM refund_ops WHERE id=?").bind(id)
      .first<{ basis: string; target_cents: number; amount_cents: number; detail: string; done_at: number | null }>())!;
    expect(row).toMatchObject({ basis: "seven_day_offer", target_cents: 5390, amount_cents: 890 });
    expect(row.done_at).not.toBeNull();
    expect(JSON.parse(row.detail).usedCreditCents).toBeUndefined();
    expect(await ledgerOf()).toBe(5390);
    expect(await count("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refund_ops WHERE invoice_id='in_1' AND decided_at IS NOT NULL")).toBe(5390);
    expect(await env.DB.prepare("SELECT amount_cents,stripe_refund_id FROM first_month_refunds").first()).toEqual({ amount_cents: 890, stripe_refund_id: "re_1" });
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims WHERE op_id=?", id)).toBeGreaterThan(0);
    // One refund per person: asking again is refused, nothing more is paid.
    expect((await refund({ homeId: "home-1" })).status).toBe(409);
    expect(posted()).toEqual(["890"]);
  });

  it("NODEDUCT-3 #1 an already_refunded zero with no saved usage is never reopened (the full invoice was covered, not a deduction)", async () => {
    const id = await oldDecisionAlreadyRefunded();
    await env.DB.prepare("UPDATE refund_ops SET detail=json_remove(detail,'$.usedCreditCents') WHERE id=?").bind(id).run();
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
    const before = await env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(id).first();
    const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
    const lease = (await acquireHomeLease(env, "home-1", "nodeduct3-nousage"))!;
    try {
      const op = (await getRefundOp(env, id))!;
      expect(await reopenLegacyRefusal(env, { stripe: st, flux, deps: deps(), now: NOW + 2 * DAY, lease }, op, 890)).toBe(false);
    } finally { await releaseHomeLease(env, lease); }
    expect(await env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(id).first()).toEqual(before);
    expect(posted()).toEqual([]);
  });

  /** Calls the reopen helper directly (the route's quote never reaches its catch: Astra NODEDUCT-3 B) while the person's slot is already held. */
  async function reopenWithSlot(slotInvoice: string) {
    const id = await oldDecisionAlreadyRefunded();
    await env.DB.prepare("INSERT INTO first_month_refunds (user_id,home_id,invoice_id,amount_cents,used_credit_cents,created_at) VALUES (?,'home-1',?,890,0,?)")
      .bind(OWNER, slotInvoice, NOW).run();
    const before = await env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(id).first();
    const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
    const lease = (await acquireHomeLease(env, "home-1", "nodeduct3-slot"))!;
    let outcome: { value?: boolean; error?: unknown } = {};
    try {
      const op = (await getRefundOp(env, id))!;
      try { outcome = { value: await reopenLegacyRefusal(env, { stripe: st, flux, deps: deps(), now: NOW + 2 * DAY, lease }, op, 890) }; }
      catch (e) { outcome = { error: e }; }
    } finally { await releaseHomeLease(env, lease); }
    // Rolled back either way: the refusal exactly as it was, the slot untouched, nothing paid.
    expect(await env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(id).first()).toEqual(before);
    expect(await env.DB.prepare("SELECT invoice_id,amount_cents FROM first_month_refunds").first()).toEqual({ invoice_id: slotInvoice, amount_cents: 890 });
    expect(posted()).toEqual([]);
    return outcome;
  }

  it("NODEDUCT-3 #2 reopen helper: a slot held by a DIFFERENT invoice is the one-per-person conflict (false)", async () => {
    const r = await reopenWithSlot("in_other");
    expect(r.error).toBeUndefined();
    expect(r.value).toBe(false);
  });

  it("NODEDUCT-3 #2 reopen helper: a slot on the SAME invoice with the refusal unchanged is not a conflict: the error is propagated (retryable)", async () => {
    const r = await reopenWithSlot("in_1");
    expect(r.value).toBeUndefined();
    expect(r.error).toBeInstanceOf(Error);
  });

  it("NODEDUCT-2 the legacy remainder's Stripe answer is lost: settled by its op id, exactly one Stripe refund, the rest paid once", async () => {
    const id = await legacyDeductedUnpaid();
    refundsMade.push({ id: "re_legacy", amount: 4290, status: "succeeded", payment_intent: "pi_1", metadata: { op_id: id, submission: "1" } });
    refundLost = 1; // the remainder's refund is made at Stripe and its answer lost
    for (let h = 0; h < 5; h++) {
      vi.mocked(Date.now).mockReturnValue(NOW + DAY + h * 6 * 3_600_000);
      await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    }
    const rest = `legacyrest:${id}`;
    expect(refundsMade.filter((r) => r.metadata.op_id === rest)).toHaveLength(1);
    expect(refundsMade.filter((r) => r.metadata.op_id === rest)[0].amount).toBe(1100);
    expect(refundsMade.reduce((n, r) => n + r.amount, 0)).toBe(5390);
    const row = (await env.DB.prepare("SELECT amount_cents,stripe_refund_id,done_at FROM refund_ops WHERE id=?").bind(rest)
      .first<{ amount_cents: number; stripe_refund_id: string; done_at: number | null }>())!;
    expect(row.amount_cents).toBe(1100);
    expect(row.stripe_refund_id).toBe(refundsMade.find((r) => r.metadata.op_id === rest)!.id);
    expect(row.done_at).not.toBeNull();
    expect(await ledgerOf()).toBe(5390);
    expect(await env.DB.prepare("SELECT stripe_refund_id FROM first_month_refunds").first()).toEqual({ stripe_refund_id: "re_legacy" });
  });

  it("NODEDUCT-2 a withdrawal that reserves the balance before the legacy remainder is decided: the remainder is zero, nothing paid twice", async () => {
    const id = await legacyDeductedUnpaid();
    refundsMade.push({ id: "re_legacy", amount: 4290, status: "succeeded", payment_intent: "pi_1", metadata: { op_id: id, submission: "1" } });
    const at = NOW + DAY;
    vi.mocked(Date.now).mockReturnValue(at);
    await sweepBilling(baseEnv(envOver), deps()); // the parent adopts re_legacy and opens the rest (not yet decided)
    const rest = `legacyrest:${id}`;
    const opened = (await env.DB.prepare("SELECT decided_at FROM refund_ops WHERE id=?").bind(rest).first<{ decided_at: number | null }>())!;
    expect(opened.decided_at).toBeNull();
    // A withdrawal on the same payment is decided first and reserves the $11.00 still owed.
    const [sql, binds] = refundOpInsert({ id: "withdrawal:race", kind: "withdrawal", homeId: "home-1", userId: OWNER, subscriptionId: "sub_test1", endPlan: true,
      detail: { confirmedAt: at, consentId: await latestConsentId("home-1") } }, at);
    await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
    const w = (await advanceRefundOp(baseEnv(), { stripe: st, flux, deps: deps(), now: at }, "withdrawal:race"))!;
    expect(w.amount_cents).toBe(1100);
    for (let h = 1; h <= 3; h++) {
      vi.mocked(Date.now).mockReturnValue(at + h * 6 * 3_600_000);
      await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    }
    const r = (await env.DB.prepare("SELECT amount_cents,stripe_refund_id,done_at FROM refund_ops WHERE id=?").bind(rest)
      .first<{ amount_cents: number; stripe_refund_id: string | null; done_at: number | null }>())!;
    expect(r).toMatchObject({ amount_cents: 0, stripe_refund_id: null });
    expect(r.done_at).not.toBeNull();
    expect(refundsMade.filter((x) => x.metadata.op_id === rest)).toHaveLength(0);
    expect(refundsMade.reduce((n, x) => n + x.amount, 0)).toBe(5390);
    expect(await ledgerOf()).toBe(5390);
    expect(await count("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refund_ops WHERE invoice_id='in_1' AND decided_at IS NOT NULL")).toBe(5390);
    expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='refund_declined'")).toBe(0);
  });
});

describe("one 7-day refund per person or payment method (refund-identity.ts)", () => {
  const refund = (body: Record<string, unknown>) => send("/v1/admin/refund-first-month", { body, headers: admin });
  const OTHER = "other-account";
  /** A card payment as Stripe returns it (PaymentIntent with latest_charge and payment_method expanded). */
  const cardPayment = (o: { fingerprint?: string | null; email?: string | null; name?: string | null; address?: Record<string, string> | null; wallet?: string }) => ({
    latest_charge: { payment_method_details: { type: "card", card: { fingerprint: o.fingerprint ?? null, ...(o.wallet ? { wallet: { type: o.wallet } } : {}) } },
      billing_details: { email: o.email ?? null, name: o.name ?? null, address: o.address ?? null } },
    payment_method: { type: "card", card: { fingerprint: o.fingerprint ?? null }, billing_details: { email: o.email ?? null, name: o.name ?? null, address: o.address ?? null } } });
  /** A Link payment (Managed Payments checkouts pay through Link): no fingerprint exists, only the Link email and billing details. */
  const linkPayment = (o: { email: string; name?: string; address?: Record<string, string> }) => ({
    latest_charge: { payment_method_details: { type: "link", link: { country: "DE" } }, billing_details: { email: null, name: o.name ?? null, address: o.address ?? null } },
    payment_method: { type: "link", link: { email: o.email }, billing_details: { email: null, name: o.name ?? null, address: o.address ?? null } } });
  /** Another Murage account paid earlier with `identity` (captured through the real code path, as invoice.paid does). */
  async function otherAccountPaid(identity: Record<string, unknown>, paidAt = NOW - 20 * DAY, invoiceId = "in_other") {
    piIdentity.pi_other = identity;
    const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
    expect(await captureRefundIdentity(baseEnv(envOver), st, { homeId: "home-other", userId: OTHER, invoiceId, paidAt, paymentIntent: "pi_other" }, paidAt)).toBe(true);
  }
  const refundsPosted = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");

  it("keeps every script: no name collapses to nothing or to another name; domains in one form; +tags only where the provider says so (Astra P2-5)", () => {
    const bill = (name: string) => billingIdentity({ name, address: { line1: "1 Main St", line2: null, postal_code: "100-0001", country: "JP" } });
    for (const name of ["山田 太郎", "Иван Петров", "محمد علي", "राम शर्मा"]) expect(bill(name)).toMatch(/^[^|]+\|JP\|/);
    expect(bill("John 李")).not.toBe(bill("John 王"));
    expect(bill("José Núñez")).toBe(bill("Jose Nunez")); // accents on Latin letters still fold
    expect(bill("Йосиф")).not.toBe(bill("Иосиф")); // a Cyrillic letter is not an accent
    expect(normalizeEmail("User@Bücher.de")).toBe("user@xn--bcher-kva.de");
    expect(normalizeEmail("user@xn--bcher-kva.de")).toBe("user@xn--bcher-kva.de");
    expect(normalizeEmail("pat+billing@example.com")).toBe("pat+billing@example.com"); // unknown provider: a different mailbox may be meant
    expect(normalizeEmail("pat+billing@icloud.com")).toBe("pat@icloud.com");
    expect(normalizeEmail("p.a.t@outlook.com")).toBe("p.a.t@outlook.com"); // only Gmail ignores dots
  });

  it("normalizes emails and billing identities the way the rule needs", () => {
    expect(normalizeEmail(" Sam.Smith+cloud2@GoogleMail.com ")).toBe("samsmith@gmail.com");
    expect(normalizeEmail("sam.smith+x@outlook.com")).toBe("sam.smith@outlook.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(billingIdentity({ name: "Sam  Smith", address: { line1: "1 Main St.", line2: null, postal_code: "94 105", country: "us" } }))
      .toBe(billingIdentity({ name: "SMITH, Sam", address: { line1: "1 main st", line2: null, postal_code: "94105", country: "US" } }));
    expect(billingIdentity({ name: null, address: { line1: "1 Main St", line2: null, postal_code: "94105", country: "US" } })).toBeNull();
  });

  it("records only keyed hashes at the first payment, append-only", async () => {
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_ownercard", email: "owner@example.test", name: "Ola Owner", address: { line1: "5 Elm Rd", postal_code: "10001", country: "US" } });
    await paidUs();
    const rows = (await env.DB.prepare("SELECT kind,key_hash,user_id,invoice_id FROM refund_identity_keys ORDER BY kind,key_hash").all<{ kind: string; key_hash: string; user_id: string; invoice_id: string }>()).results;
    expect(rows.map((r) => r.kind).sort()).toEqual(["billing", "card", "email", "email"]); // billing email + account email (legal@example.test)
    for (const r of rows) { expect(r.key_hash).toMatch(/^[0-9a-f]{64}$/); expect(r.user_id).toBe(OWNER); expect(r.invoice_id).toBe("in_1"); }
    // The normalization version is recorded with each normalized key (and is part of its hashed input).
    expect((await env.DB.prepare("SELECT kind,norm FROM refund_identity_keys ORDER BY kind").all()).results.map((r) => `${r.kind}:${r.norm}`))
      .toEqual(["billing:2", "card:0", "email:2", "email:2"]);
    const dump = JSON.stringify(await env.DB.prepare("SELECT * FROM refund_identity_keys").all());
    for (const raw of ["fp_ownercard", "owner@example.test", "Ola Owner", "Elm Rd"]) expect(dump).not.toContain(raw);
    expect(await env.DB.prepare("SELECT source,fingerprint FROM refund_identity_captures WHERE invoice_id='in_1'").first()).toEqual({ source: "card", fingerprint: 1 });
    await expect(env.DB.prepare("UPDATE refund_identity_keys SET user_id='x'").run()).rejects.toThrow(/append_only/);
    // A first payment with nothing shared is the customer's first: the offer applies.
    expect((await refund({ homeId: "home-1" })).status).toBe(200);
    expect(refundsPosted()).toHaveLength(1);
  });

  it("the same card on a new account is not eligible, and the customer is told why in plain words", async () => {
    await otherAccountPaid(cardPayment({ fingerprint: "fp_shared", email: "first@example.test", name: "Pat One", address: { line1: "1 A St", postal_code: "11111", country: "US" } }));
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared", email: "second@example.test", name: "Kim Two", address: { line1: "9 Z St", postal_code: "99999", country: "US" } });
    await paidUs();
    const res = await refund({ homeId: "home-1" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_first_payment", message: REFUND_DENIAL_TEXT.not_first_payment });
    expect(refundsPosted()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(0);
    const notice = notices.find((n) => n.kind === "refund_declined")!;
    expect(String(notice.data.emailText)).toContain("was used for an earlier Murage Cloud payment, or for another account that already had this refund");
    expect(REFUND_DENIAL_TEXT.already_refunded).toContain("once per person");
    expect(REFUND_DENIAL_TEXT.already_refunded).not.toContain("once per customer");
    expect(String(notice.data.emailText)).toContain("withdraw from the contract within 14 days");
    // The dry run says the same thing.
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false, reason: "not_first_payment" } });
  });

  it("the same email with a plus-tag (and Gmail dots) on a new account and a new card is not eligible", async () => {
    await otherAccountPaid(cardPayment({ fingerprint: "fp_a", email: "sam.smith@gmail.com" }));
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_b", email: "SamSmith+cloud@googlemail.com" });
    await paidUs();
    expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "not_first_payment" });
    expect(refundsPosted()).toHaveLength(0);
  });

  it("a different card and email but the same billing name and address is not eligible", async () => {
    await otherAccountPaid(cardPayment({ fingerprint: "fp_a", email: "a@example.test", name: "Sam Smith", address: { line1: "1 Main St.", postal_code: "94105", country: "US" } }));
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_b", email: "b@example.test", name: "smith sam", address: { line1: "1 MAIN ST", postal_code: "94 105", country: "us" } });
    await paidUs();
    expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "not_first_payment" });
  });

  it("a key of a payment another account already got the offer for blocks it, whichever paid first", async () => {
    // The other account paid AFTER this one but was refunded first (its keys match ours).
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
    await paidUs();
    await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }), NOW + 60_000, "in_other_later");
    // A request the other account has only opened (its once-per-customer slot, nothing decided yet) is a reservation, not a refund: it
    // blocks nobody.
    await env.DB.prepare("INSERT INTO first_month_refunds (user_id,home_id,invoice_id,amount_cents,used_credit_cents,created_at) VALUES (?,?,?,?,0,?)")
      .bind(OTHER, "home-other", "in_other_later", 4900, NOW).run();
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true } });
    // Once its offer was decided (the keys are claimed with that decision), the shared card is refused here.
    await env.DB.prepare(`INSERT INTO refund_identity_claims (kind,key_hash,invoice_id,user_id,op_id,claimed_at)
      SELECT kind,key_hash,invoice_id,?,?,? FROM refund_identity_keys WHERE invoice_id='in_other_later'`).bind(OTHER, `firstmonth:${OTHER}`, NOW).run();
    expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "not_first_payment" });
  });

  it("two accounts with the same card deciding at once: exactly one gets the offer, the other keeps its plan and is told why", async () => {
    // Both requests pass the check; the other account's decision commits after OUR DECISION passed its identity check and before its
    // batch (Astra P1-1; ASTRA-REFUND3 #6: the boundary where only the atomic claim guard can catch it). The credit use is read once
    // per request and kept (ASTRA-REFUND2 #3); B4 is briefly down at receipt, so the decision is what reads it, and that read (after
    // the decision's identity check, before its batch) is where the other decision lands.
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
    await paidUs();
    await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }), NOW + 60_000, "in_other_later");
    envOver = { DB: identityRace(async (n) => {
      if (n === 1) return "pending"; // at receipt: the request is recorded, the decision checks again
      if (n === 2) {
        // The decision has passed its identity check: no claim was there. Now the other one commits.
        expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE decided_at IS NULL")).toBe(1);
        await env.DB.prepare(`INSERT INTO refund_identity_claims (kind,key_hash,invoice_id,user_id,op_id,claimed_at)
          SELECT kind,key_hash,invoice_id,?,?,? FROM refund_identity_keys WHERE invoice_id='in_other_later'`).bind(OTHER, `firstmonth:${OTHER}`, NOW).run();
      }
    }) };
    const res = await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin });
    envOver = {};
    expect(res.status).toBe(409);
    // The guard rolled the first decision back and the decision made again refused.
    expect(await count("SELECT COUNT(*) AS n FROM cloud_write_guards")).toBe(0);
    expect(await res.json()).toMatchObject({ error: "not_first_payment", message: REFUND_DENIAL_TEXT.not_first_payment });
    expect(refundsPosted()).toHaveLength(0);
    // Refused before anything was cancelled: the plan keeps running and nothing is taken back.
    expect(stripeCalls.some((c) => c.method === "DELETE" && c.path.startsWith("/v1/subscriptions/"))).toBe(false);
    expect(fluxLog.some((f) => f.hook === "stop")).toBe(false);
    expect((await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id='home-1'").first<{ status: string }>())!.status).toBe("active");
    expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims WHERE invoice_id='in_1'")).toBe(0);
    expect(notices.filter((n) => n.kind === "refund_declined").map((n) => n.data.reason)).toEqual(["not_first_payment"]);
    // Asked again: the same answer, nothing new taken or sent.
    expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "not_first_payment" });
    expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(0);
    expect(refundsPosted()).toHaveLength(0);
  });

  it("the winning decision claims every key of its payment, marked refunded once Stripe confirms", async () => {
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine", email: "me@example.test" });
    await paidUs();
    expect((await refund({ homeId: "home-1" })).status).toBe(200);
    const keys = await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_1'");
    expect(keys).toBeGreaterThan(1);
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims WHERE invoice_id='in_1' AND refunded_at IS NOT NULL")).toBe(keys);
  });

  it("an earlier payment whose keys are not recorded yet holds the decision (pending), never a guess", async () => {
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine" });
    await paidUs();
    // Another account paid a minute earlier; its capture at invoice.paid failed and the sweep has not caught up yet.
    await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,plan,status,first_invoice_id,first_paid_at,first_invoice_cents,created_at,updated_at)
      VALUES ('home-early','cus_early','starter','active','in_early',?,4900,?,?)`).bind(NOW - 60_000, NOW, NOW).run();
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false, reason: "identity_check_unavailable" } });
    // Recorded: judged on every key.
    await otherAccountPaid(cardPayment({ fingerprint: "fp_other" }), NOW - 60_000, "in_early");
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true } });
    // A capture still missing days later is a fault, not a reason to hold every later customer.
    await env.DB.prepare("DELETE FROM refund_identity_captures WHERE invoice_id='in_early'").run();
    vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY + 1);
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true } });
  });

  it("a payment refunded in full because it never started a plan (duplicate, region hold, price, capacity) does not count", async () => {
    await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
    await env.DB.prepare("INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,created_at,updated_at) VALUES ('dup-op','duplicate','home-other',?,'in_other',0,?,?)")
      .bind(OTHER, NOW, NOW).run();
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
    await paidUs();
    expect((await refund({ homeId: "home-1" })).status).toBe(200);
  });

  for (const kind of ["mismatch", "country_paused", "rejected_consent"] as const) {
    it(`WP3: a payment refunded in full as '${kind}' (a purchase the checkout turned down) is not a first payment`, async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      // Without the refund the earlier payment with the same card counts: refused.
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false, reason: "not_first_payment" } });
      await env.DB.prepare("INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,created_at,updated_at) VALUES (?,?,'home-other',?,'in_other',0,?,?)")
        .bind(`wp3-${kind}`, kind, OTHER, NOW, NOW).run();
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true } });
      expect((await refund({ homeId: "home-1" })).status).toBe(200);
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
    });
  }

  it("WP3 end to end: the Cloud terms accepted at checkout bind the one-per-person limit only once REFUND_LIMIT_V2_LIVE=1", async () => {
    await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
    await env.DB.prepare(`INSERT INTO refund_identity_claims (kind,key_hash,invoice_id,user_id,op_id,claimed_at)
      SELECT kind,key_hash,invoice_id,?,?,? FROM refund_identity_keys WHERE invoice_id='in_other'`).bind(OTHER, `firstmonth:${OTHER}`, NOW - DAY).run();
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
    await paidUs();
    // The customer accepted the current Cloud terms at checkout, before paying, through the real consent path (no SQL edit): the row
    // carries the generated id, which is the one listed in REFUND_LIMIT_V2_CLOUD_TERMS_IDS.
    expect(await env.DB.prepare("SELECT source,cloud_terms_version AS v FROM terms_acceptances WHERE user_id=?").bind(OWNER).all())
      .toMatchObject({ results: [{ source: "checkout", v: "cloud-terms-964155e36e8b" }] });
    envOver = { REFUND_LIMIT_TERMS_VERSIONS: "" };
    // Launch flag off (the default): the version does not bind; the offer applies.
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true, oncePerPerson: false } });
    envOver = { REFUND_LIMIT_TERMS_VERSIONS: "", REFUND_LIMIT_V2_LIVE: "0" };
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true, oncePerPerson: false } });
    // Flag on: the same customer is bound, and the repeat card is refused, with nothing refunded.
    envOver = { REFUND_LIMIT_TERMS_VERSIONS: "", REFUND_LIMIT_V2_LIVE: "1" };
    // The site page's display label is not a version id: an acceptance row carrying it (written by hand) binds nobody, even flag on.
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='2026-10-11.1' WHERE user_id=?").bind(OWNER).run();
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true, oncePerPerson: false } });
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version=? WHERE user_id=?").bind(LEGAL_DOCS.cloudTerms.versionId, OWNER).run();
    expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false, reason: "not_first_payment", oncePerPerson: true } });
    expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "not_first_payment" });
    expect(refundsPosted()).toHaveLength(0);
    envOver = {};
  });

  describe("Astra LIMITVER-1: a payment is bound by its own checkout's acceptance, whatever the Stripe event timestamps say", () => {
    const LIVE = { REFUND_LIMIT_TERMS_VERSIONS: "", REFUND_LIMIT_V2_LIVE: "1" };
    const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    /** A repeat card (already refunded on another account), then our checkout completed at `completedS` and its invoice.paid at `paidS`
     *  (Stripe event seconds; Stripe does not order them). */
    async function repeatCardPaid(completedS: number, paidS: number) {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      await env.DB.prepare(`INSERT INTO refund_identity_claims (kind,key_hash,invoice_id,user_id,op_id,claimed_at)
        SELECT kind,key_hash,invoice_id,?,?,? FROM refund_identity_keys WHERE invoice_id='in_other'`).bind(OTHER, `firstmonth:${OTHER}`, NOW - DAY).run();
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await reserve();
      expect((await checkout("starter")).status).toBe(200);
      expect((await sessionCompleted({}, "paid", completedS)).status).toBe(200);
      expect((await hook(stripeEvent("invoice.paid", invoice(), paidS))).status).toBe(200);
      expect((await reconcile()).status).toBe(200);
      return (await env.DB.prepare(`SELECT a.accepted_at AS acc, s.first_paid_at AS paid, s.consent_id AS consent FROM terms_acceptances a
        JOIN billing_subscriptions s ON s.consent_id=a.consent_id WHERE a.user_id=? AND a.source='checkout'`).bind(OWNER).first<{ acc: number; paid: number; consent: string }>())!;
    }

    it("invoice.paid stamped 1 s BEFORE the checkout completed: the checkout's acceptance still binds that payment", async () => {
      const r = await repeatCardPaid(NOW / 1000, NOW / 1000 - 1);
      expect(r.acc).toBeGreaterThan(r.paid); // the boundary Astra reproduced: the acceptance is stamped after the payment
      envOver = LIVE;
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false, reason: "not_first_payment", oncePerPerson: true } });
      expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "not_first_payment" });
      expect(refundsPosted()).toHaveLength(0);
      envOver = {};
    });

    it("invoice.paid stamped 1 s AFTER the checkout completed: binds", async () => {
      const r = await repeatCardPaid(NOW / 1000 - 1, NOW / 1000);
      expect(r.acc).toBeLessThan(r.paid);
      envOver = LIVE;
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false, reason: "not_first_payment", oncePerPerson: true } });
      expect(refundsPosted()).toHaveLength(0);
      envOver = {};
    });

    /** Astra LIMITVER-2: the request refused at request time is reopened (an objection-held refusal), stays pending, and a replacement
     *  subscription then takes the home's row (another invoice, another consent). `legacy` strips the consent from the saved operation, as
     *  operations reopened before the fix were saved. The retry must still bind the pinned payment to its own checkout's acceptance. */
    async function reopenedThenReplaced(legacy: boolean) {
      const r = await repeatCardPaid(NOW / 1000, NOW / 1000 - 1);
      expect(r.acc).toBeGreaterThan(r.paid); // outside the timestamp branch: only the payment's own consent binds it
      envOver = LIVE;
      await env.DB.prepare("INSERT INTO refund_refusal_receipts (invoice_id,home_id,user_id,received_at,rested_on) VALUES ('in_1','home-1',?,?,?)")
        .bind(OWNER, NOW, JSON.stringify([OTHER])).run();
      const receipt = (await env.DB.prepare("SELECT * FROM refund_refusal_receipts WHERE invoice_id='in_1'").first())!;
      const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
      const lease = (await acquireHomeLease(env, "home-1", "limitver2-reopen"))!;
      let opId: string | null;
      try { opId = await reopenRefusedRequest(baseEnv(LIVE), { stripe: st, flux: stubFluxHooks, deps: deps(), now: NOW + DAY, lease }, receipt as never); }
      finally { await releaseHomeLease(env, lease); }
      expect(opId).toBe(`firstmonth:${OWNER}`);
      const saved = JSON.parse((await getRefundOp(env, opId!))!.detail!) as { pay: { invoiceId: string }; consentId?: string };
      expect(saved.pay.invoiceId).toBe("in_1");
      expect(saved.consentId).toBe(r.consent); // saved with the pinned payment
      expect((await getRefundOp(env, opId!))!.decided_at).toBeNull(); // still pending
      if (legacy) await env.DB.prepare("UPDATE refund_ops SET detail=? WHERE id=?").bind(JSON.stringify({ pay: saved.pay }), opId).run();
      // The replacement subscription takes the home's row: the fallback lookup by the pinned invoice no longer finds the original consent.
      await env.DB.prepare(`UPDATE billing_subscriptions SET subscription_id='sub_replacement',consent_id=NULL,first_invoice_id='in_replacement',
        first_payment_intent='pi_replacement',first_paid_at=? WHERE home_id='home-1'`).bind(NOW + DAY).run();
      vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
      await advanceRefundOp(baseEnv(LIVE), { stripe: st, flux: stubFluxHooks, deps: deps(), now: NOW + 2 * DAY }, opId!).catch(() => undefined);
      const op = (await getRefundOp(env, opId!))!;
      // not_first_payment comes only from the identity check, which runs only when the limit binds (oncePerPerson).
      expect(op).toMatchObject({ invoice_id: "in_1", basis: "not_first_payment", amount_cents: 0 });
      expect(JSON.parse(op.detail!).consentId).toBe(r.consent); // recovered (legacy) or kept, and saved with the decision
      expect(refundsPosted()).toHaveLength(0);
      envOver = {};
    }

    it("LIMITVER-2 reopen -> pending -> replacement subscription -> retry: refused as not the first payment, the identity check runs", async () => {
      await reopenedThenReplaced(false);
    }, 30_000);

    it("LIMITVER-2 an operation reopened before the fix (no consent saved) recovers it from its subscription's checkout: still refused", async () => {
      await reopenedThenReplaced(true);
    }, 30_000);

    it("a re-acceptance never binds a payment made before it, and binds a payment made after it", async () => {
      const r = await repeatCardPaid(NOW / 1000 - 20, NOW / 1000 - 10);
      // The checkout accepted an older Cloud terms text (no limit), so only a re-acceptance can carry the limit.
      await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld' WHERE user_id=?").bind(OWNER).run();
      await sweep(); await sweep(); // the 30-day notice goes out first; only then can the customer re-accept
      signedIn = OWNER;
      const current = { cloudTerms: LEGAL_DOCS.cloudTerms.versionId, termsOfService: LEGAL_DOCS.termsOfService.versionId, privacyPolicy: LEGAL_DOCS.privacyPolicy.versionId };
      expect((await send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions: current, client: { ip: "198.51.100.8", userAgent: "ua-r" } } })).status).toBe(200);
      const re = (await env.DB.prepare("SELECT accepted_at AS a FROM terms_acceptances WHERE source='reaccept' AND user_id=?").bind(OWNER).first<{ a: number }>())!.a;
      expect(re).toBeGreaterThan(r.paid);
      envOver = LIVE;
      const live = { ...env, ...LIVE } as Env;
      // The earlier payment (its own checkout's consent passed in): the later re-acceptance does not reach back to it.
      expect(await refundLimitAccepted(live, OWNER, r.paid, r.consent)).toBe(false);
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true, oncePerPerson: false } });
      // A later payment (another checkout's consent, or none): the re-acceptance made before it binds it.
      expect(await refundLimitAccepted(live, OWNER, re + 1000, "consent-of-a-later-checkout")).toBe(true);
      expect(await refundLimitAccepted(live, OWNER, re, null)).toBe(true);
      expect(await refundLimitAccepted(live, OWNER, re - 1, null)).toBe(false);
      envOver = {};
    });
  });

  it("the EU/UK 14-day full refund is never limited: a repeat card still withdraws and gets everything back (Astra P1-3)", async () => {
    await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
    await reserve();
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    await sessionCompleted({ customer_details: { address: { country: "DE" } } });
    await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp();
    signedIn = OWNER;
    vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY);
    const res = await send("/v1/account/withdraw", { body: { confirm: true, name: "Ada Buyer", client: { ip: "198.51.100.5", userAgent: "ua-w" } } });
    expect(res.status).toBe(201);
    // An entitlement of its own: no one-per-person check, nothing deducted, the identity tables are never read or claimed.
    expect(await res.json()).toMatchObject({ withdrawn: true, basis: "eu_uk_full_refund", daysSupplied: 3, deductedCents: 0, refundCents: 4900, status: "completed" });
    expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
    expect(notices.find((n) => n.kind === "refunded")!.data.sevenDayOffer).toBeUndefined();
    expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims")).toBe(0);
  });

  it("an EU/UK refund asked by email within 14 days of the start is the full refund: no identity, offer or credit check, no secret needed", async () => {
    await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" }); // a repeat card: the 7-day offer would refuse it
    await reserve();
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    await sessionCompleted({ customer_details: { address: { country: "DE" } } });
    await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp();
    envOver = { REFUND_KEY_SECRET: undefined } as Partial<Env>;
    usedMicrocents = 80_000_000; // all included credit used: the 7-day offer would pay nothing
    vi.mocked(Date.now).mockReturnValue(NOW + 10 * DAY); // past the 7-day offer, inside the 14 days
    const reads = fluxLog.filter((f) => f.hook === "used").length;
    const res = await refund({ homeId: "home-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ refunded: true, amountCents: 4900 });
    expect(fluxLog.filter((f) => f.hook === "used").length).toBe(reads);
    expect(await env.DB.prepare("SELECT id,basis,amount_cents FROM refund_ops").first()).toEqual({ id: "eu14:in_1", basis: "eu_uk_full_refund", amount_cents: 4900 });
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(0);
    expect(notices.find((n) => n.kind === "refunded")!.data.reason).toBe("Our 14-day full refund for EU, EEA and UK customers");
    envOver = {};
  });

  it("after 14 days an EU/UK request falls back to the 7-day offer's rules (and its window has passed)", async () => {
    await reserve();
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    await sessionCompleted({ customer_details: { address: { country: "DE" } } });
    await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp();
    // WP5 r1-5: the EU/UK full refund ends with the consent's frozen deadlines (AoE end of day 14), not after exactly 336 hours.
    vi.mocked(Date.now).mockReturnValue(aoeEnd(NOW, 14) + 1);
    expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "window_expired" });
    expect(refundsPosted()).toHaveLength(0);
  });

  it("a statutory withdrawal never waits on the identity check: with no secret configured it completes in full", async () => {
    envOver = { REFUND_KEY_SECRET: undefined } as Partial<Env>;
    await reserve();
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    await sessionCompleted({ customer_details: { address: { country: "DE" } } });
    await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp();
    signedIn = OWNER;
    vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY);
    const res = await send("/v1/account/withdraw", { body: { confirm: true, name: "Ada Buyer", client: { ip: "198.51.100.5", userAgent: "ua-w" } } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ withdrawn: true, basis: "eu_uk_full_refund", refundCents: 4900, status: "completed" });
    expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
    envOver = {};
  });

  it("records are kept 24 months from the payment, then purged by the sweep and never captured again (Astra P1-4)", async () => {
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine", email: "me@example.test" });
    await paidUs();
    expect((await refund({ homeId: "home-1" })).status).toBe(200); // a claim is made too
    await otherAccountPaid(cardPayment({ fingerprint: "fp_newer" }), NOW + 40 * DAY, "in_newer");
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims")).toBeGreaterThan(0);
    const twoYears = Date.UTC(new Date(NOW).getUTCFullYear() + 2, new Date(NOW).getUTCMonth(), new Date(NOW).getUTCDate(), 0, 0, 0) + (NOW % DAY);
    expect(retentionCutoff(twoYears)).toBe(NOW);
    // One day short of 24 months: everything is still there.
    vi.mocked(Date.now).mockReturnValue(twoYears - DAY); await sweepBilling(baseEnv(), deps());
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_1'")).toBeGreaterThan(0);
    // 24 months and a day after the payment: its keys, capture row and claims are gone; the newer payment's are kept.
    vi.mocked(Date.now).mockReturnValue(twoYears + DAY); await sweepBilling(baseEnv(), deps());
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_1'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_captures WHERE invoice_id='in_1'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_newer'")).toBeGreaterThan(0);
    // The sweep's capture never brings the expired payment back (its subscription row still names it), nor does a direct capture.
    await sweepBilling(baseEnv(), deps()); await sweepBilling(baseEnv(), deps());
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_captures WHERE invoice_id='in_1'")).toBe(0);
    const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
    expect(await captureRefundIdentity(baseEnv(), st, { homeId: "home-1", userId: OWNER, invoiceId: "in_1", paidAt: NOW, paymentIntent: "pi_1" }, twoYears + DAY)).toBe(false);
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_1'")).toBe(0);
  });

  it("the most complete billing address is used, and a name with only a country and postal code is never a key (Astra P2-6)", () => {
    const full = { line1: "5 Elm Rd", line2: null, postal_code: "10001", country: "US" };
    const id = paymentIdentityOf({ latest_charge: { payment_method_details: { type: "card", card: { fingerprint: "fp" } },
      billing_details: { name: "Ola Owner", address: { postal_code: "10001" } } },
      payment_method: { type: "card", card: { fingerprint: "fp" }, billing_details: { address: full } } }, null);
    expect(id.address).toEqual(full);
    expect(billingIdentity(id)).not.toBeNull();
    expect(billingIdentity({ name: "Ola Owner", address: { line1: null, line2: null, postal_code: "10001", country: "US" } })).toBeNull();
  });

  it("two unrelated people with the same name, country and postal code (no street) are not matched", async () => {
    await otherAccountPaid(cardPayment({ fingerprint: "fp_a", email: "a@example.test", name: "Sam Smith", address: { postal_code: "94105", country: "US" } }));
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_b", email: "b@example.test", name: "Sam Smith", address: { postal_code: "94105", country: "US" } });
    await paidUs();
    expect((await refund({ homeId: "home-1" })).status).toBe(200);
  });

  it("a capture with no key is never recorded as complete, and an incomplete one is read again until Stripe shows the payment", async () => {
    const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
    // No card, no email, no billing details, and an account with no email: nothing to compare.
    piGone.add("pi_ghost");
    await expect(captureRefundIdentity(baseEnv(), st, { homeId: "home-ghost", userId: "no-such-user", invoiceId: "in_ghost", paidAt: NOW, paymentIntent: "pi_ghost" }, NOW))
      .rejects.toThrow(/refund_identity_empty/);
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_captures WHERE invoice_id='in_ghost'")).toBe(0);
    expect(await firstPaymentCheck(baseEnv(), null, { homeId: "home-ghost", userId: "no-such-user", invoiceId: "in_ghost", paidAt: NOW, paymentIntent: "pi_ghost" }, NOW))
      .toBe("identity_check_unavailable");
    // Stripe cannot show the payment at invoice.paid: only the account email is recorded, and the capture is marked for another read.
    piGone.add("pi_1");
    await paidUs();
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_1' AND kind='card'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_enrich WHERE invoice_id='in_1'")).toBe(1);
    // Stripe shows it now: the sweep adds the card key and the payment is complete.
    piGone.delete("pi_1"); piIdentity.pi_1 = cardPayment({ fingerprint: "fp_late" });
    vi.mocked(Date.now).mockReturnValue(NOW + 3_600_000); await sweepBilling(baseEnv(), deps());
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_1' AND kind='card'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_enrich")).toBe(0);
  });

  it("Astra MAILRETRY-4 P2: overlapping enrichment runs: a resumed old snapshot never overwrites a newer run's attempt, and never recreates what a complete capture deleted", async () => {
    const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
    const row = () => env.DB.prepare("SELECT attempts,next_attempt_at FROM refund_identity_enrich WHERE invoice_id='in_1'").first<{ attempts: number; next_attempt_at: number }>();
    piGone.add("pi_1");
    await paidUs(); // incomplete: marked for another read
    const first = (await row())!;
    // Run A selects at its time and is cut before it reaches in_1 (it keeps its snapshot).
    const tA = first.next_attempt_at;
    const snapshotA = (await dueEnrichments(baseEnv(), tA)).find((r) => r.invoice_id === "in_1")!;
    expect(snapshotA).toMatchObject({ attempts: first.attempts, next_attempt_at: first.next_attempt_at });
    // Run B, five minutes later, attempts it first (Stripe still cannot show it): attempt counted, next read scheduled from B's time.
    const tB = tA + 5 * 60_000;
    const snapshotB = (await dueEnrichments(baseEnv(), tB)).find((r) => r.invoice_id === "in_1")!;
    expect(await enrichOne(baseEnv(), st, snapshotB, tB)).toBe(true);
    const afterB = (await row())!;
    expect(afterB.attempts).toBe(first.attempts + 1);
    expect(afterB.next_attempt_at).toBeGreaterThan(tB);
    // A resumes its old snapshot: the conditional claim matches nothing; B's attempt and schedule stand.
    expect(await enrichOne(baseEnv(), st, snapshotA, tA)).toBe(false);
    expect(await row()).toEqual(afterB);
    // Stripe shows the payment now: a complete read deletes the enrichment.
    piGone.delete("pi_1"); piIdentity.pi_1 = cardPayment({ fingerprint: "fp_done" });
    await env.DB.prepare("UPDATE refund_identity_enrich SET next_attempt_at=? WHERE invoice_id='in_1'").bind(tB).run();
    const snapshotC = (await dueEnrichments(baseEnv(), tB)).find((r) => r.invoice_id === "in_1")!;
    expect(await enrichOne(baseEnv(), st, snapshotC, tB)).toBe(true);
    expect(await row()).toBeNull();
    // A late INCOMPLETE read (a cut run's capture that read Stripe before the payment showed) lands afterwards: the completion guard in
    // its own statement keeps the deleted enrichment deleted. And the old snapshots claim nothing.
    piGone.add("pi_1");
    expect(await captureRefundIdentity(baseEnv(), st, { homeId: "home-1", userId: snapshotA.user_id, invoiceId: "in_1", paidAt: snapshotA.paid_at,
      paymentIntent: snapshotA.payment_intent }, tB, { enrich: true })).toBe(true);
    expect(await row()).toBeNull();
    expect(await enrichOne(baseEnv(), st, snapshotA, tA)).toBe(false);
    expect(await enrichOne(baseEnv(), st, snapshotB, tB)).toBe(false);
    expect(await row()).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_1' AND kind='card'")).toBe(1);
  });

  describe("HMAC key rotation (Astra P2-7)", () => {
    const NEW_SECRET = "test-only-refund-identity-hmac-secret-ROTATED-987654";
    it("a key replaced under the same version stops the check (pending, ops alerted) instead of forgetting every earlier payment", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      envOver = { REFUND_KEY_SECRET: NEW_SECRET } as Partial<Env>;
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      const res = await refund({ homeId: "home-1" });
      expect(res.status).toBe(202);
      expect(refundsPosted()).toHaveLength(0);
      expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='refund_key.replaced'").first()).toEqual({ kind: "refund_key.replaced" });
      envOver = {};
    });
    it("a rotation that keeps the previous key still recognizes earlier payments", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      envOver = { REFUND_KEY_SECRET: NEW_SECRET, REFUND_KEY_VERSION: "2", REFUND_KEY_SECRET_PREVIOUS: REFUND_SECRET, REFUND_KEY_VERSION_PREVIOUS: "1" } as Partial<Env>;
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "not_first_payment" });
      expect((await env.DB.prepare("SELECT DISTINCT key_version AS v FROM refund_identity_keys WHERE invoice_id='in_1' ORDER BY v").all()).results).toEqual([{ v: 1 }, { v: 2 }]);
      envOver = {};
    });
    it("a rotation that drops the previous key while its records are kept stops the check and alerts ops", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      envOver = { REFUND_KEY_SECRET: NEW_SECRET, REFUND_KEY_VERSION: "2" } as Partial<Env>;
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      expect((await refund({ homeId: "home-1" })).status).toBe(202);
      expect(refundsPosted()).toHaveLength(0);
      expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='refund_key.previous_missing'").first()).toEqual({ kind: "refund_key.previous_missing" });
      envOver = {};
    });
    it("checkout readiness: a malformed key stops new sales in any mode, and live sales do not start without one; billing itself runs (REFUND2 #1)", () => {
      expect(checkoutRefundKeyError(baseEnv({ REFUND_KEY_SECRET: "too-short" } as Partial<Env>))).toBe("refund_key_invalid");
      expect(checkoutRefundKeyError(baseEnv({ REFUND_KEY_VERSION: "two" } as Partial<Env>))).toBe("refund_key_version_invalid");
      expect(checkoutRefundKeyError(baseEnv({ REFUND_KEY_SECRET_PREVIOUS: REFUND_SECRET } as Partial<Env>))).toBe("refund_key_version_invalid");
      const live = { STRIPE_SECRET_KEY: "sk_live_fixturefixturefixture", STRIPE_ALLOW_LIVE: "1" }; // secret-scan: fixture
      expect(checkoutRefundKeyError(baseEnv({ ...live, REFUND_KEY_SECRET: undefined } as Partial<Env>))).toBe("refund_key_missing");
      expect(checkoutRefundKeyError(baseEnv(live as Partial<Env>))).toBeNull();
      // Billing (withdrawals, refunds, the sweep) never depends on the refund-identity key.
      expect(billingConfig(baseEnv({ ...live, REFUND_KEY_SECRET: undefined } as Partial<Env>))).not.toBeNull();
      expect(billingConfig(baseEnv({ REFUND_KEY_SECRET: "too-short" } as Partial<Env>))).not.toBeNull();
    });
  });

  it("a refusal email is recorded before the answer and retried by the sweep; replies go to the support inbox (Astra P2-8)", async () => {
    await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
    await paidUs();
    const mails: { subject: string; replyTo?: string; text: string }[] = [];
    let mailDown = true;
    envOver = { EMAIL: { async send(m: { subject: string; replyTo?: string; text: string }) { if (mailDown) throw new Error("mail_down"); mails.push(m); } } } as unknown as Partial<Env>;
    const real: BillingDependencies = { ...deps(), notifier: undefined };
    const res = await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, real);
    expect(res.status).toBe(409);
    expect(await env.DB.prepare("SELECT kind,sent_at FROM billing_notices WHERE kind='refund_declined'").first()).toEqual({ kind: "refund_declined", sent_at: null });
    mailDown = false;
    vi.mocked(Date.now).mockReturnValue(NOW + DAY); await sweepBilling(baseEnv(envOver), real);
    const sent = mails.find((m) => m.subject === "Murage Cloud: about your refund request")!;
    expect(sent.text).toContain(REFUND_DENIAL_TEXT.not_first_payment);
    expect(sent.replyTo).toBe("support@murage.ai");
    envOver = {};
  });

  it("a refusal whose email cannot even be recorded fails the request (asked again later), it is never answered with no email", async () => {
    await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
    await paidUs();
    notifierFails = true;
    expect((await refund({ homeId: "home-1" })).status).toBeGreaterThanOrEqual(500);
    notifierFails = false;
    expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "not_first_payment" });
    expect(notices.filter((n) => n.kind === "refund_declined")).toHaveLength(1);
  });

  it("Managed Payments / Link: no fingerprint exists, so the Link email and billing identity decide", async () => {
    await otherAccountPaid(linkPayment({ email: "buyer@gmail.com", name: "Lin K", address: { line1: "Hauptstr. 1", postal_code: "10115", country: "DE" } }));
    expect(await env.DB.prepare("SELECT source,fingerprint FROM refund_identity_captures WHERE invoice_id='in_other'").first()).toEqual({ source: "link", fingerprint: 0 });
    piIdentity.pi_1 = linkPayment({ email: "Buyer+2@gmail.com" });
    await paidUs();
    expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "not_first_payment" });
  });

  it("a payment Stripe no longer has (erased) falls back to the customer and account emails", async () => {
    await otherAccountPaid(cardPayment({ fingerprint: "fp_x", email: "legal@example.test" }));
    piGone.add("pi_1"); customerIdentity = { email: "someone-else@example.test" };
    await paidUs();
    expect(await env.DB.prepare("SELECT source,fingerprint FROM refund_identity_captures WHERE invoice_id='in_1'").first()).toEqual({ source: "unreadable", fingerprint: 0 });
    // The Murage account email (legal@example.test) matches the earlier payment's billing email.
    expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ error: "not_first_payment" });
  });

  it("fails closed but never loses the request: Stripe unreachable when the keys are missing records it, the sweep decides it later", async () => {
    identityFails = 1; // the capture at invoice.paid fails (activation is not held up)
    await paidUs();
    expect(await count("SELECT COUNT(*) AS n FROM refund_identity_captures")).toBe(0);
    identityFails = 2; // the request's own capture, and the decision's
    const res = await refund({ homeId: "home-1" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ pending: true, message: REFUND_DENIAL_TEXT.identity_check_unavailable });
    expect(notices.some((n) => n.kind === "refund_declined")).toBe(false); // not a decision: the customer is not told "no"
    expect(refundsPosted()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT kind,created_at,decided_at,canceled_at,last_error FROM refund_ops").first())
      .toEqual({ kind: "first_month", created_at: NOW, decided_at: null, canceled_at: null, last_error: "identity_check_unavailable" });
    // Stripe back: the sweep captures the keys and refunds this first payment; nobody had to retry by hand.
    vi.mocked(Date.now).mockReturnValue(NOW + DAY);
    await sweepBilling(baseEnv(envOver), deps());
    expect(refundsPosted()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT basis,done_at FROM refund_ops").first()).toEqual({ basis: "seven_day_offer", done_at: NOW + DAY });
  });

  it("a request just before the 7-day deadline during an outage is judged as of when it was received (Astra P1-2)", async () => {
    piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine" });
    await paidUs();
    await env.DB.prepare("DELETE FROM refund_identity_captures").run(); await env.DB.prepare("DELETE FROM refund_identity_keys").run();
    vi.mocked(Date.now).mockReturnValue(NOW + 7 * DAY - 60_000);
    identityFails = 2;
    expect((await refund({ homeId: "home-1" })).status).toBe(202);
    // Recovered after the deadline: still refunded, because it was asked for in time.
    vi.mocked(Date.now).mockReturnValue(NOW + 8 * DAY);
    await sweepBilling(baseEnv(envOver), deps());
    expect(refundsPosted()).toHaveLength(1);
    expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
  });

  it("with no secret configured a request waits (ops is alerted), it is never refused or granted unchecked", async () => {
    await paidUs();
    envOver = { REFUND_KEY_SECRET: undefined } as Partial<Env>;
    expect((await refund({ homeId: "home-1" })).status).toBe(202);
    for (let i = 1; i <= 3; i++) { vi.mocked(Date.now).mockReturnValue(NOW + i * 6 * 3_600_000); await sweepBilling(baseEnv(envOver), deps()); }
    expect(refundsPosted()).toHaveLength(0);
    expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='refund.stuck'").first()).toEqual({ kind: "refund.stuck" });
    envOver = {};
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
    await sweepBilling(baseEnv(envOver), deps());
    expect(refundsPosted()).toHaveLength(1);
  });

  describe("Astra ASTRA-REFUND2 (round 2): one test per finding", () => {
    const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    async function euPaid() {
      await reserve();
      expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
      await sessionCompleted({ customer_details: { address: { country: "DE" } } });
      await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp();
    }

    it("r2-1 a live deployment without (or with a malformed) refund key stops new sales only: withdrawal, refunds and purge keep working", async () => {
      await euPaid();
      // An expired identity record from long ago, for the purge to remove.
      await env.DB.prepare(`INSERT INTO refund_identity_keys (kind,key_hash,user_id,home_id,invoice_id,paid_at,created_at,norm,key_version)
        VALUES ('card',?, 'old-user','home-old','in_old',?,?,0,1)`).bind("a".repeat(64), NOW - 800 * DAY, NOW - 800 * DAY).run();
      envOver = { STRIPE_SECRET_KEY: "sk_live_fixturefixturefixture", STRIPE_ALLOW_LIVE: "1", REFUND_KEY_SECRET: undefined } as Partial<Env>; // secret-scan: fixture
      // New sales are refused, in plain terms, and ops is told every sweep.
      const sale = await checkout("starter");
      expect(sale.status).toBe(503); expect(await sale.json()).toMatchObject({ error: "refund_key_missing" });
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY);
      await sweep();
      expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='refund_key.checkout_blocked'").first()).toEqual({ kind: "refund_key.checkout_blocked" });
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_old'")).toBe(0); // the purge still ran
      // The statutory withdrawal is recorded and reimbursed in full.
      signedIn = OWNER;
      const res = await send("/v1/account/withdraw", { body: { confirm: true, name: "Ada Buyer", client: { ip: "198.51.100.5", userAgent: "ua-w" } } });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ withdrawn: true, basis: "eu_uk_full_refund", refundCents: 4900, status: "completed" });
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      // A malformed key in test mode: the same, sales stop and nothing else does.
      envOver = { REFUND_KEY_SECRET: "too-short" } as Partial<Env>;
      expect(await (await checkout("starter")).json()).toMatchObject({ error: "refund_key_invalid" });
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ dryRun: true });
      envOver = {};
    }, 30_000);

    it("r2-2 a payment Stripe could not show at capture is read again before its offer is decided; a later payment with the same card waits, then is refused", async () => {
      const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
      piGone.add("pi_1");
      await paidUs(); // in_1: Stripe answered 404, only the account email is recorded, marked for another read
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_enrich WHERE invoice_id='in_1'")).toBe(1);
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }), NOW + 60_000, "in_other_later");
      // Stripe has recovered, but nothing has read in_1 again yet.
      piGone.delete("pi_1"); piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      const later = { homeId: "home-other", userId: OTHER, invoiceId: "in_other_later", paidAt: NOW + 60_000, paymentIntent: "pi_other" };
      // The later payment cannot be judged "first" while the earlier one's keys are still coming.
      expect(await firstPaymentCheck(baseEnv(), st, later, NOW + 60_000)).toBe("identity_check_unavailable");
      // in_1's own request reads it again BEFORE deciding: its card is recorded and claimed with the decision.
      expect((await refund({ homeId: "home-1" })).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims WHERE invoice_id='in_1' AND kind='card'")).toBe(1);
      // The later payment with the same card is now refused: one 7-day refund, not two.
      expect(await firstPaymentCheck(baseEnv(), st, later, NOW + 60_000)).toBe("not_first_payment");
      expect(refundsPosted()).toHaveLength(1);
    });

    it("r2-2 keys Stripe shows only after the offer was decided join that decision's claim", async () => {
      const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
      // Stripe shows the payment, but without a card fingerprint or billing details yet: read, incomplete, marked for another read. (A
      // payment Stripe could not show at all is never decided on what is recorded: Astra ASTRA-REFUND3 #1, test r3-1.)
      await paidUs();
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_enrich WHERE invoice_id='in_1'")).toBe(1);
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY + 1);
      expect((await refund({ homeId: "home-1" })).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims WHERE invoice_id='in_1' AND kind='card'")).toBe(0);
      piGone.delete("pi_1"); piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await sweep(); // the enrichment adds the card, and it joins in_1's claim
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims WHERE invoice_id='in_1' AND kind='card'")).toBe(1);
      // Even a payment made EARLIER with that card no longer gets the offer.
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }), NOW - DAY, "in_other_earlier");
      expect(await firstPaymentCheck(baseEnv(), st, { homeId: "home-other", userId: OTHER, invoiceId: "in_other_earlier", paidAt: NOW - DAY, paymentIntent: "pi_other" },
        NOW + 3 * DAY + 2)).toBe("not_first_payment");
    });

    it("2026-10-12 a request saved with a credit deduction (before the change) is decided at the full fee: nothing is deducted", async () => {
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine" });
      await paidUs();
      envOver = { DB: identityRace(async () => "pending") }; // the request is recorded and waits
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin })).status).toBe(202);
      envOver = {};
      // The operation as the previous version saved it: a measured $10 deduction kept on it.
      const op = (await env.DB.prepare("SELECT id,detail FROM refund_ops WHERE kind='first_month'").first<{ id: string; detail: string }>())!;
      await env.DB.prepare("UPDATE refund_ops SET detail=? WHERE id=?").bind(JSON.stringify({ ...JSON.parse(op.detail), usedCreditCents: 1000 }), op.id).run();
      usedMicrocents = 80_000_000;
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY);
      await sweepBilling(baseEnv(envOver), deps());
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect((await env.DB.prepare("SELECT basis FROM refund_ops WHERE kind='first_month'").first<{ basis: string }>())!.basis).toBe("seven_day_offer");
      expect(fluxLog.some((f) => f.hook === "used")).toBe(false);
    });

    it("GRANTS-8 #39 a saved positive deduction AND a throwing usage hook: the full fee less invoice-wide prior refunds, zero usage reads", async () => {
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine" });
      await paidUs();
      let reads = 0;
      const b4Down: BillingDependencies = { ...deps(), flux: { ...flux, async usedIncludedCreditMicrocents() { reads++; throw new Error("b4_down"); } } };
      envOver = { DB: identityRace(async () => "pending") }; // the request is recorded and waits
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, b4Down)).status).toBe(202);
      envOver = {};
      // Every saved deduction is positive: the operation's kept usedCreditCents and the claim row's used_credit_cents.
      const op = (await env.DB.prepare("SELECT id,detail FROM refund_ops WHERE kind='first_month'").first<{ id: string; detail: string }>())!;
      await env.DB.batch([
        env.DB.prepare("UPDATE refund_ops SET detail=? WHERE id=?").bind(JSON.stringify({ ...JSON.parse(op.detail), usedCreditCents: 2500 }), op.id),
        env.DB.prepare("UPDATE first_month_refunds SET used_credit_cents=2500"),
        // An earlier refund of $7 against the same invoice (another route), already decided and in the invoice's ledger.
        env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,paid_cents,target_cents,amount_cents,end_plan,decided_at,created_at,updated_at)
          VALUES ('extraordinary:prior','extraordinary','home-1',?,'in_1',4900,700,700,0,?,?,?)`).bind(OWNER, NOW, NOW, NOW),
        env.DB.prepare("INSERT INTO refund_invoice_ledger (invoice_id,version,decided_cents) VALUES ('in_1',1,700) ON CONFLICT(invoice_id) DO UPDATE SET version=version+1,decided_cents=decided_cents+700"),
      ]);
      expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds WHERE used_credit_cents=2500")).toBe(1);
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY);
      await sweepBilling(baseEnv(envOver), b4Down);
      // $49 paid (no tax on this payment), nothing deducted for credits, less the $7 already refunded: $42.
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4200"]);
      expect((await env.DB.prepare("SELECT basis,amount_cents FROM refund_ops WHERE kind='first_month'").first())).toEqual({ basis: "seven_day_offer", amount_cents: 4200 });
      expect(reads).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund.stuck'")).toBe(0);
    });

    it("2026-10-12 the usage hook is never read for a refund, also across retries; the refund is the full fee", async () => {
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine" });
      await paidUs();
      let reads = 0;
      const counting: BillingDependencies = { ...deps(), flux: { ...flux, async usedIncludedCreditMicrocents() { reads++; return { usedMicrocents: 10_000_000 }; } } };
      refundFails = 5; // Stripe down: the refund itself is retried by the sweep
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, counting)).status).toBe(202);
      refundFails = 0;
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      await sweepBilling(baseEnv(envOver), counting);
      expect(reads).toBe(0);
      expect(refundsPosted().filter((c) => c.form.get("amount") === "4900").length).toBeGreaterThan(0);
      expect(refundsPosted().some((c) => c.form.get("amount") !== "4900")).toBe(false);
    });

    it("r2-4 a previous key retires by itself once only payments also hashed under the current key are left, and can then be removed", async () => {
      const NEW_SECRET = "test-only-refund-identity-hmac-secret-ROTATED-987654";
      await otherAccountPaid(cardPayment({ fingerprint: "fp_old" }), NOW - 20 * DAY, "in_old_only"); // hashed under v1 only
      const rotated = { REFUND_KEY_SECRET: NEW_SECRET, REFUND_KEY_VERSION: "2", REFUND_KEY_SECRET_PREVIOUS: REFUND_SECRET, REFUND_KEY_VERSION_PREVIOUS: "1" } as Partial<Env>;
      envOver = rotated;
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine", email: "me@example.test" });
      await paidUs(); // hashed under v1 and v2
      expect((await refund({ homeId: "home-1" })).status).toBe(200); // claims every key of in_1, both versions
      const perVersion = async (v: number) => count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_1' AND key_version=?", v);
      const v2Keys = await perVersion(2);
      expect(await perVersion(1)).toBe(v2Keys);
      // A payment known only under v1 is still kept: v1 cannot retire.
      vi.mocked(Date.now).mockReturnValue(NOW + DAY); await sweep();
      expect(await perVersion(1)).toBe(v2Keys);
      expect(await env.DB.prepare("SELECT retired_at FROM refund_identity_keyring WHERE version=1").first()).toEqual({ retired_at: null });
      // 24 months after the v1-only payment (in_1 is still kept): it is purged, and v1 retires on the same sweep.
      const t = NOW + 721 * DAY;
      expect(retentionCutoff(t)).toBeGreaterThan(NOW - 20 * DAY); expect(retentionCutoff(t)).toBeLessThan(NOW);
      vi.mocked(Date.now).mockReturnValue(t); await sweep();
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE key_version=1")).toBe(0);
      expect(await perVersion(2)).toBe(v2Keys);
      expect(await env.DB.prepare("SELECT retired_at FROM refund_identity_keyring WHERE version=1").first()).toEqual({ retired_at: t });
      expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='refund_key.previous_retired'").first()).toEqual({ kind: "refund_key.previous_retired" });
      // The claim survives under the current key: every v2 key of in_1 is still claimed.
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims WHERE invoice_id='in_1'")).toBe(v2Keys);
      // While the previous key is still configured, nothing is hashed with it any more.
      await otherAccountPaid(cardPayment({ fingerprint: "fp_new" }), t - DAY, "in_new");
      expect((await env.DB.prepare("SELECT DISTINCT key_version AS v FROM refund_identity_keys WHERE invoice_id='in_new'").all()).results).toEqual([{ v: 2 }]);
      // The previous key is removed: the check keeps working (no previous_missing), and in_1's claim still blocks the same card.
      envOver = { REFUND_KEY_SECRET: NEW_SECRET, REFUND_KEY_VERSION: "2" } as Partial<Env>;
      const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
      piIdentity.pi_other = cardPayment({ fingerprint: "fp_mine" });
      expect(await captureRefundIdentity(baseEnv(envOver), st, { homeId: "home-other", userId: OTHER, invoiceId: "in_same_card", paidAt: t, paymentIntent: "pi_other" }, t)).toBe(true);
      expect(await firstPaymentCheck(baseEnv(envOver), st, { homeId: "home-other", userId: OTHER, invoiceId: "in_same_card", paidAt: t, paymentIntent: "pi_other" }, t))
        .toBe("not_first_payment");
      expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='refund_key.previous_missing'").first()).toBeNull();
      envOver = {};
    }, 30_000);

    it("r2-6 the preview shows the EU/UK 14-day full refund the request then pays (day 10: not window_expired)", async () => {
      await euPaid();
      usedMicrocents = 80_000_000; // the 7-day offer would pay nothing even inside its window
      vi.mocked(Date.now).mockReturnValue(NOW + 10 * DAY);
      const dry = await (await refund({ homeId: "home-1", dryRun: true })).json() as { quote: Record<string, unknown>; basis: string; message?: string };
      expect(dry.basis).toBe("eu_uk_full_refund");
      expect(dry.quote).toMatchObject({ eligible: true, reason: null, refundCents: 4900, paidCents: 4900, usedCreditCents: 0, windowEndsAt: aoeEnd(NOW, 14) });
      expect(dry.message).toBeUndefined();
      expect(refundsPosted()).toHaveLength(0);
      const res = await refund({ homeId: "home-1" });
      expect(await res.json()).toMatchObject({ refunded: true, amountCents: dry.quote.refundCents });
      // Once paid, the preview says so (nothing more is owed), it never offers the same money twice.
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ basis: "eu_uk_full_refund", quote: { eligible: false, reason: "already_refunded", refundCents: 0 } });
    });

    it("r2-5 asking again while the first request is pending resumes it: no refusal email, and it is paid once", async () => {
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine" });
      await paidUs();
      envOver = { DB: identityRace(async () => "pending") }; // a check that cannot finish right now
      const first = await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin });
      expect(first.status).toBe(202);
      // Asked again while the check still cannot finish: the same pending request, not "already refunded".
      const again = await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin });
      expect(again.status).toBe(202);
      expect(await again.json()).toMatchObject({ refunded: false, pending: true });
      expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
      envOver = {};
      // Asked a third time once the check can run: the open request resumes and is paid, once.
      const third = await refund({ homeId: "home-1" });
      expect(third.status).toBe(200);
      expect(await third.json()).toMatchObject({ refunded: true, amountCents: 4900 });
      vi.mocked(Date.now).mockReturnValue(NOW + DAY); await sweep();
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(1);
    });

    it("r2-7 an undecided request advanced after the retention period never recaptures the payment's identity", async () => {
      identityFails = 3; // Stripe down at invoice.paid, for the request's quote and for its decision
      await paidUs();
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      expect((await refund({ homeId: "home-1" })).status).toBe(202);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_captures")).toBe(0);
      // Over 24 months later the request is advanced again (asked again): the receipt time is still in the 7-day window, but the payment
      // is past retention TODAY, so nothing is read from Stripe and no key or capture is recorded again.
      const t = NOW + 800 * DAY;
      expect(retentionCutoff(t)).toBeGreaterThan(NOW);
      vi.mocked(Date.now).mockReturnValue(t); stripeCalls = [];
      // Settled, not left waiting (Astra ASTRA-REFUND3 #3, test r3-3): the timely request is honoured without the identity check.
      expect((await refund({ homeId: "home-1" })).status).toBe(200);
      expect(stripeCalls.some((c) => c.path.startsWith("/v1/payment_intents/"))).toBe(false);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_captures")).toBe(0);
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
    });

    it("r2-8 the one-per-person limit binds only a customer who accepted a terms version carrying it; matching ignores case and provider +tags", async () => {
      expect(normalizeEmail("PAT+News@Example.COM")).toBe("pat+news@example.com"); // case always; +tag kept where the provider may mean another mailbox
      expect(normalizeEmail("Pat.Smith+News@GMAIL.com")).toBe("patsmith@gmail.com");
      expect(normalizeEmail("Pat+News@Outlook.COM")).toBe("pat@outlook.com");
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      // The other account already got the offer for that card (its keys are claimed).
      await env.DB.prepare(`INSERT INTO refund_identity_claims (kind,key_hash,invoice_id,user_id,op_id,claimed_at)
        SELECT kind,key_hash,invoice_id,?,?,? FROM refund_identity_keys WHERE invoice_id='in_other'`).bind(OTHER, `firstmonth:${OTHER}`, NOW - DAY).run();
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      // Accepted the version that carries the limit (at checkout, before paying): refused.
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false, reason: "not_first_payment", oncePerPerson: true } });
      // Accepted only a version without it: the limit does not bind this customer, the offer applies.
      await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-before-the-limit' WHERE user_id=?").bind(OWNER).run();
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true, oncePerPerson: false } });
      // A version carrying it accepted only AFTER the payment does not reach back to it.
      await env.DB.prepare(`INSERT INTO terms_acceptances (id,user_id,cloud_terms_version,tos_version,privacy_version,source,wording,accepted_at,client_meta)
        VALUES ('accept-later',?,?,?,?,'reaccept','w',?,'{}')`).bind(OWNER, LEGAL_DOCS.cloudTerms.versionId, LEGAL_DOCS.termsOfService.versionId,
        LEGAL_DOCS.privacyPolicy.versionId, NOW + 60_000).run();
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      const res = await refund({ homeId: "home-1" });
      expect(res.status).toBe(200); // decided and paid; a claim held by another payment does not refuse an unbound customer
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      // With no version listed at all (production today), nobody is bound.
      expect((await import("../src/refund-identity")).REFUND_LIMIT_TERMS_VERSIONS).toEqual([]);
    });
  });

  describe("Astra ASTRA-REFUND3 (round 3): one test per finding", () => {
    const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    const st = () => stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
    const otherUser = () => env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'O','other@example.test',1,?,?)`)
      .bind(OTHER, NOW, NOW).run();

    it("r3-1 an unreadable payment never becomes eligible because the grace or enrichment period ran out; its request keeps recovering", async () => {
      piGone.add("pi_1");
      await paidUs(); // in_1: Stripe answered 404, only the account email is recorded
      expect((await refund({ homeId: "home-1" })).status).toBe(202);
      // Another account's later payment with the same card, also unreadable (only its account email is recorded).
      await otherUser();
      piGone.add("pi_other");
      const later = { homeId: "home-other", userId: OTHER, invoiceId: "in_other_later", paidAt: NOW + 60_000, paymentIntent: "pi_other" };
      expect(await captureRefundIdentity(baseEnv(), st(), later, NOW + 60_000)).toBe(true);
      // Day 4 (past the capture grace) and day 16 (past the enrichment period): Stripe still cannot show either payment. Nothing is paid.
      for (const t of [NOW + 4 * DAY, NOW + 16 * DAY]) {
        vi.mocked(Date.now).mockReturnValue(t); await sweep();
        expect(await firstPaymentCheck(baseEnv(), st(), later, t)).toBe("identity_check_unavailable");
      }
      expect(refundsPosted()).toHaveLength(0);
      expect(await env.DB.prepare("SELECT decided_at FROM refund_ops WHERE kind='first_month'").first()).toEqual({ decided_at: null });
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_enrich WHERE invoice_id='in_1'")).toBe(0); // the enrichment period is over
      // Stripe recovers: the waiting request reads in_1 again by itself, and the earlier payment gets the one refund.
      piGone.delete("pi_1"); piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      piGone.delete("pi_other"); piIdentity.pi_other = cardPayment({ fingerprint: "fp_shared" });
      vi.mocked(Date.now).mockReturnValue(NOW + 17 * DAY); await sweep();
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_settled WHERE invoice_id='in_1'")).toBe(1);
      // The later same-card payment is refused: one 7-day refund, not two.
      expect(await firstPaymentCheck(baseEnv(), st(), later, NOW + 17 * DAY)).toBe("not_first_payment");
    }, 30_000);

    it("r3-2 a capture in flight while its previous key is retired writes nothing under the retired key: it hashes again with the active ring", async () => {
      const rotated = { REFUND_KEY_SECRET: "test-only-refund-identity-hmac-secret-ROTATED-987654", REFUND_KEY_VERSION: "2",
        REFUND_KEY_SECRET_PREVIOUS: REFUND_SECRET, REFUND_KEY_VERSION_PREVIOUS: "1" } as Partial<Env>;
      envOver = rotated;
      await otherAccountPaid(cardPayment({ fingerprint: "fp_other" })); // hashed under v1 and v2: nothing is known under v1 only
      // A capture under the rotated keyring [v2, v1] reaches Stripe and waits there.
      let reached!: () => void; const atStripe = new Promise<void>((r) => { reached = r; });
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      const real = st();
      const paused = { paymentIdentity: async (pi: string | null, cus: string | null) => { reached(); await gate; return real.paymentIdentity(pi, cus); } } as unknown as StripeClient;
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine", email: "me@example.test" });
      const ref = { homeId: "home-1", userId: OWNER, invoiceId: "in_race", paidAt: NOW, paymentIntent: "pi_1" };
      const inFlight = captureRefundIdentity(baseEnv(rotated), paused, ref, NOW);
      await atStripe;
      // Meanwhile the sweep retires v1.
      expect(await retireRedundantKeys(baseEnv(rotated), NOW)).toEqual([1]);
      release();
      expect(await inFlight).toBe(true);
      // Recorded under the active key only: no key of the retired version came back, and the keyring keeps working.
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE key_version=1")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_race' AND key_version=2")).toBeGreaterThan(0);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_write_guards")).toBe(0);
      expect(await keyring(baseEnv(rotated), NOW)).not.toBeNull();
      expect(await firstPaymentCheck(baseEnv(rotated), real, ref, NOW)).toBeNull();
      expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind LIKE 'refund_key.%' AND kind<>'refund_key.previous_retired'").first()).toBeNull();
      // A Worker still configured with the retired key as its CURRENT key records nothing (the sweep captures it with the active ring).
      const stale = await captureRefundIdentity(baseEnv(), real, { ...ref, invoiceId: "in_stale" }, NOW);
      expect(stale).toBe(false);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_stale'")).toBe(0);
      expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='refund_key.retired_in_use'").first()).toEqual({ kind: "refund_key.retired_in_use" });
      expect(await captureRefundIdentity(baseEnv(rotated), real, { ...ref, invoiceId: "in_stale" }, NOW)).toBe(true);
      expect((await env.DB.prepare("SELECT DISTINCT key_version AS v FROM refund_identity_keys WHERE invoice_id='in_stale'").all()).results).toEqual([{ v: 2 }]);
      envOver = {};
    });

    it("r3-3 a request still undecided when its payment passes retention is settled by the sweep: honoured as received, nothing recaptured", async () => {
      identityFails = 3;
      await paidUs();
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      expect((await refund({ homeId: "home-1" })).status).toBe(202);
      identityFails = 1_000_000; // Stripe never shows the payment again
      for (const d of [2, 3, 4]) { vi.mocked(Date.now).mockReturnValue(NOW + d * DAY); await sweep(); }
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund.stuck' AND resolved_at IS NULL")).toBeGreaterThan(0);
      expect(refundsPosted()).toHaveLength(0);
      // Past the 24-month retention the payment's identity is gone for good. The sweep alone settles the request: nobody clears it.
      const t = NOW + 800 * DAY;
      vi.mocked(Date.now).mockReturnValue(t); stripeCalls = [];
      await sweep();
      expect(stripeCalls.some((c) => c.path.startsWith("/v1/payment_intents/"))).toBe(false);
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      const op = (await env.DB.prepare("SELECT basis,detail,decided_at,done_at FROM refund_ops WHERE kind='first_month'").first<{ basis: string; detail: string;
        decided_at: number; done_at: number | null }>())!;
      expect(op).toMatchObject({ basis: "seven_day_offer", decided_at: t, done_at: t });
      expect(JSON.parse(op.detail)).toMatchObject({ identityExpired: true });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund.stuck' AND resolved_at IS NULL")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys")).toBe(0);
      // Later sweeps change nothing: paid once.
      vi.mocked(Date.now).mockReturnValue(t + DAY); await sweep();
      expect(refundsPosted()).toHaveLength(1);
    }, 30_000);

    const objection = (body: Record<string, unknown>) => send("/v1/admin/refund-identity-objection", { body, headers: admin });

    it("r3-4 an objection restricts the person's codes at once: requests that need them wait with their receipt time until the decision notice is sent", async () => {
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine" });
      await paidUs();
      expect(await (await objection({ action: "object", userId: OWNER })).json()).toMatchObject({ restricted: true, objectedAt: NOW });
      // The person's own request waits (recorded with its receipt time), and is never refused meanwhile.
      expect((await refund({ homeId: "home-1" })).status).toBe(202);
      expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
      // Another account's later payment with the same card would be refused only on the restricted codes: it waits too.
      await otherAccountPaid(cardPayment({ fingerprint: "fp_mine" }), NOW + 60_000, "in_other_later");
      const later = { homeId: "home-other", userId: OTHER, invoiceId: "in_other_later", paidAt: NOW + 60_000, paymentIntent: "pi_other" };
      expect(await firstPaymentCheck(baseEnv(), st(), later, NOW + 60_000)).toBe("identity_check_unavailable");
      // Weeks pass (well past the 7-day window): nothing is decided or paid while the objection is open; ops is reminded of the deadline.
      for (const d of [3, 10, 26]) { vi.mocked(Date.now).mockReturnValue(NOW + d * DAY); await sweep(); }
      expect(refundsPosted()).toHaveLength(0);
      expect(await env.DB.prepare("SELECT decided_at FROM refund_ops WHERE kind='first_month'").first()).toEqual({ decided_at: null });
      expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='refund_identity.objection_due'").first()).toEqual({ kind: "refund_identity.objection_due" });
      // The decision notice is sent (codes kept): the restriction ends and the sweep decides the request as of its receipt time.
      expect(await (await objection({ action: "decision_notice_sent", userId: OWNER, decision: "keep" })).json())
        .toMatchObject({ restricted: false, decision: "keep", noticeSentAt: NOW + 26 * DAY });
      vi.mocked(Date.now).mockReturnValue(NOW + 27 * DAY); await sweep();
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(await env.DB.prepare("SELECT basis,created_at FROM refund_ops WHERE kind='first_month'").first()).toEqual({ basis: "seven_day_offer", created_at: NOW });
      // The kept codes are used again: the later same-card payment is refused.
      expect(await firstPaymentCheck(baseEnv(), st(), later, NOW + 27 * DAY)).toBe("not_first_payment");
      // The checkpoint needs an open objection.
      expect((await objection({ action: "decision_notice_sent", userId: OWNER, decision: "keep" })).status).toBe(409);
    }, 30_000);

    it("r3-4 an erase decision deletes only the objector's codes, which are never captured again", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      expect((await objection({ action: "object", userId: OTHER })).status).toBe(200);
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      // Our payment matches only the objector's restricted codes: it waits, it is not refused on them.
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false, reason: "identity_check_unavailable" } });
      expect(await (await objection({ action: "decision_notice_sent", userId: OTHER, decision: "erase" })).json()).toMatchObject({ decision: "erase" });
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE user_id=?", OTHER)).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_1'")).toBeGreaterThan(0);
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true } });
      const theirs = { homeId: "home-other", userId: OTHER, invoiceId: "in_other", paidAt: NOW - 20 * DAY, paymentIntent: "pi_other" };
      expect(await captureRefundIdentity(baseEnv(), st(), theirs, NOW)).toBe(false);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE user_id=?", OTHER)).toBe(0);
      expect(await firstPaymentCheck(baseEnv(), st(), theirs, NOW)).toBeNull(); // nothing left to refuse on
    });

    it("r3-4 an EU/UK withdrawal never waits on an objection", async () => {
      await reserve();
      expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
      await sessionCompleted({ customer_details: { address: { country: "DE" } } });
      await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp();
      expect((await objection({ action: "object", userId: OWNER })).status).toBe(200);
      signedIn = OWNER;
      const res = await send("/v1/account/withdraw", { body: { confirm: true, name: "Ada Buyer", client: { ip: "198.51.100.5", userAgent: "ua-w" } } });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ withdrawn: true, basis: "eu_uk_full_refund", refundCents: 4900, status: "completed" });
    });

    it("r4-1 a capture in flight while the person's codes are erased writes nothing: erased codes never come back", async () => {
      expect((await objection({ action: "object", userId: OWNER })).status).toBe(200);
      let reached!: () => void; const atStripe = new Promise<void>((r) => { reached = r; });
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      const real = st();
      const paused = { paymentIdentity: async (pi: string | null, cus: string | null) => { reached(); await gate; return real.paymentIdentity(pi, cus); } } as unknown as StripeClient;
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_erased", email: "erased@example.test" });
      const ref = { homeId: "home-1", userId: OWNER, invoiceId: "in_erased", paidAt: NOW, paymentIntent: "pi_1" };
      const inFlight = captureRefundIdentity(baseEnv(), paused, ref, NOW);
      await atStripe;
      // The erasure runs while Stripe is being read.
      expect(await (await objection({ action: "decision_notice_sent", userId: OWNER, decision: "erase" })).json()).toMatchObject({ decision: "erase" });
      release();
      expect(await inFlight).toBe(false);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE user_id=?", OWNER)).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_captures WHERE invoice_id='in_erased'")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_write_guards")).toBe(0);
      // An enrichment read in flight the same way writes nothing either.
      let reached2!: () => void; const atStripe2 = new Promise<void>((r) => { reached2 = r; });
      let release2!: () => void; const gate2 = new Promise<void>((r) => { release2 = r; });
      const paused2 = { paymentIdentity: async (pi: string | null, cus: string | null) => { reached2(); await gate2; return real.paymentIdentity(pi, cus); } } as unknown as StripeClient;
      const later = { ...ref, invoiceId: "in_erased_2", paidAt: NOW + 1_000 };
      vi.mocked(Date.now).mockReturnValue(NOW + 2_000);
      expect((await objection({ action: "object", userId: OWNER })).status).toBe(200);
      const enrich = captureRefundIdentity(baseEnv(), paused2, later, NOW + 2_000, { enrich: true });
      await atStripe2;
      expect((await objection({ action: "decision_notice_sent", userId: OWNER, decision: "erase" })).status).toBe(200);
      release2();
      expect(await enrich).toBe(false);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE user_id=?", OWNER)).toBe(0);
      // A payment made after the erasure is recorded as usual.
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_after" });
      expect(await captureRefundIdentity(baseEnv(), real, { ...ref, invoiceId: "in_after", paidAt: NOW + 3_000 }, NOW + 3_000)).toBe(true);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE invoice_id='in_after'")).toBeGreaterThan(0);
    });

    /** env.DB on which the first identity match that REFUSES (firstPaymentCheck's final match) runs `after` before it answers: another
     *  worker's write landing right after the identity check, before anything is committed or sent. */
    const afterRefusalMatch = (after: () => Promise<unknown>): D1Database => {
      let fired = false;
      return new Proxy(env.DB, { get(t, k) {
        if (k === "prepare") return (sql: string) => {
          const stmt = t.prepare(sql);
          if (fired || !sql.startsWith("SELECT 1 AS x FROM refund_identity_keys mine")
            || !sql.includes("AND NOT EXISTS (SELECT 1 FROM refund_identity_restrictions r WHERE r.user_id=c.user_id")) return stmt;
          return { bind: (...a: unknown[]) => { const b = stmt.bind(...a); return { first: async () => {
            const r = await b.first(); if (r && !fired) { fired = true; await after(); } return r; } }; } } as unknown as D1PreparedStatement;
        };
        const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
      } });
    };
    const objectsNow = (userId: string) => () => env.DB.prepare("INSERT INTO refund_identity_restrictions (user_id,objected_at) VALUES (?,?)").bind(userId, NOW).run();

    it("r4-2 an objection opened after the receipt's identity check, before the refusal is sent, holds the request: no refusal, no email", async () => {
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" })); // earlier: our payment is not the first
      await paidUs();
      envOver = { DB: afterRefusalMatch(objectsNow(OTHER)) };
      expect((await refund({ homeId: "home-1" })).status).toBe(202);
      envOver = {};
      expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
      expect(await env.DB.prepare("SELECT decided_at,created_at FROM refund_ops WHERE kind='first_month'").first()).toEqual({ decided_at: null, created_at: NOW });
      // Once the decision notice is sent (codes kept), the sweep decides it: refused on the kept codes, told once.
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "keep" })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY); await sweep();
      expect(notices.filter((n) => n.kind === "refund_declined").map((n) => n.data.reason)).toEqual(["not_first_payment"]);
      expect(refundsPosted()).toHaveLength(0);
    }, 30_000);

    // The other account's later same-card payment, claimed by its own offer: refuses ours at the decision, not at receipt.
    const claimTheirs = () => env.DB.prepare(`INSERT INTO refund_identity_claims (kind,key_hash,invoice_id,user_id,op_id,claimed_at)
      SELECT kind,key_hash,invoice_id,?,?,? FROM refund_identity_keys WHERE invoice_id='in_other_later'`).bind(OTHER, `firstmonth:${OTHER}`, NOW).run();

    it("r4-2 an objection opened after the decision's identity check, before its batch, holds the request: no refusal, no email", async () => {
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }), NOW + 60_000, "in_other_later");
      // Receipt passed its identity check, then the other claim lands and the request waits; the decision refuses on the claim.
      envOver = { DB: identityRace(async (n) => { if (n === 1) { await claimTheirs(); return "pending"; } }, afterRefusalMatch(objectsNow(OTHER))) };
      const res = await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin });
      envOver = {};
      expect(res.status).toBe(202);
      expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
      expect(await env.DB.prepare("SELECT decided_at,basis FROM refund_ops WHERE kind='first_month'").first()).toEqual({ decided_at: null, basis: null });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_write_guards")).toBe(0);
      // The refusal never committed (the decision batch rolled back): the payment's ledger was never advanced.
      expect(await count("SELECT COALESCE(MAX(version),0) AS n FROM refund_invoice_ledger WHERE invoice_id='in_1'")).toBe(0);
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "keep" })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY); await sweep();
      expect(notices.filter((n) => n.kind === "refund_declined").map((n) => n.data.reason)).toEqual(["not_first_payment"]);
      expect(refundsPosted()).toHaveLength(0);
    }, 30_000);

    it("r4-2 an objection opened after a refusal is decided, before its notice is sent, reopens the request: the notice is never sent", async () => {
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }), NOW + 60_000, "in_other_later");
      envOver = { DB: identityRace(async (n) => { if (n === 1) { await claimTheirs(); notifierFails = true; return "pending"; } }) };
      await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin });
      envOver = {};
      notifierFails = false;
      expect(await env.DB.prepare("SELECT basis,notified_at FROM refund_ops WHERE kind='first_month'").first()).toEqual({ basis: "not_first_payment", notified_at: null });
      expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
      expect((await objection({ action: "object", userId: OTHER })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + DAY); await sweep();
      expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
      expect(await env.DB.prepare("SELECT decided_at,basis FROM refund_ops WHERE kind='first_month'").first()).toEqual({ decided_at: null, basis: null });
      // Erased instead: nothing is left to refuse on, and the request is decided as of its receipt time (paid).
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "erase" })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY); await sweep();
      expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
    }, 30_000);

    it("r4-3 erase, then a new objection decided keep: erased codes are never recaptured and never leave a request pending", async () => {
      // A payment Stripe could not show at invoice.paid (uncaptured) and another account's captured one.
      await otherAccountPaid(cardPayment({ fingerprint: "fp_theirs" }));
      identityFails = 1_000_000;
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_mine" });
      await paidUs();
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_captures WHERE invoice_id='in_1'")).toBe(0);
      for (const u of [OWNER, OTHER]) {
        vi.mocked(Date.now).mockReturnValue(NOW + DAY);
        expect((await objection({ action: "object", userId: u })).status).toBe(200);
        expect((await objection({ action: "decision_notice_sent", userId: u, decision: "erase" })).status).toBe(200);
        vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
        expect((await objection({ action: "object", userId: u })).status).toBe(200);
        expect(await (await objection({ action: "decision_notice_sent", userId: u, decision: "keep" })).json()).toMatchObject({ decision: "keep" });
      }
      identityFails = 0;
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY); await sweep();
      // Nothing was recaptured for either person.
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE user_id IN (?,?)", OWNER, OTHER)).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_captures WHERE invoice_id='in_1'")).toBe(0);
      const theirs = { homeId: "home-other", userId: OTHER, invoiceId: "in_other", paidAt: NOW - 20 * DAY, paymentIntent: "pi_other" };
      expect(await captureRefundIdentity(baseEnv(), st(), theirs, NOW + 3 * DAY)).toBe(false);
      // The captured payment whose keys were erased is judged (nothing left to refuse on), not pending until retention.
      expect(await firstPaymentCheck(baseEnv(), st(), theirs, NOW + 3 * DAY)).toBeNull();
      // And the uncaptured one is decided and paid.
      expect((await refund({ homeId: "home-1" })).status).toBe(200);
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE user_id=?", OWNER)).toBe(0);
    }, 30_000);

    it("r4-4 the objection reminder resolves once its objections are decided, and stays while one is open", async () => {
      expect((await objection({ action: "object", userId: OWNER })).status).toBe(200);
      expect((await objection({ action: "object", userId: OTHER })).status).toBe(200);
      const open = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund_identity.objection_due' AND resolved_at IS NULL");
      vi.mocked(Date.now).mockReturnValue(NOW + 26 * DAY); await sweep();
      expect(await open()).toBe(1);
      expect((await objection({ action: "decision_notice_sent", userId: OWNER, decision: "keep" })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 27 * DAY); await sweep();
      expect(await open()).toBe(1); // OTHER is still undecided
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "erase" })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 28 * DAY); await sweep();
      expect(await open()).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund_identity.objection_due' AND resolved_at IS NOT NULL")).toBe(1);
    }, 30_000);

    it("r3-5 an EU/UK 14-day refund asked on day 13 and retried on day 15 resolves the same request: no window_expired, no refusal, paid once", async () => {
      await reserve();
      expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
      await sessionCompleted({ customer_details: { address: { country: "DE" } } });
      await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp();
      refundFails = 1_000; // Stripe cannot take the refund for now
      vi.mocked(Date.now).mockReturnValue(NOW + 13 * DAY);
      expect((await refund({ homeId: "home-1" })).status).toBe(202);
      // Day 15, Stripe still failing: the same pending request, not a 7-day quote.
      vi.mocked(Date.now).mockReturnValue(NOW + 15 * DAY);
      const again = await refund({ homeId: "home-1" });
      expect(again.status).toBe(202);
      expect(await again.json()).toMatchObject({ refunded: false, pending: true });
      expect(await (await refund({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ basis: "eu_uk_full_refund", pending: true, quote: { refundCents: 4900 } });
      // Stripe recovers: the retry pays the full refund, once.
      refundFails = 0;
      expect(await (await refund({ homeId: "home-1" })).json()).toMatchObject({ refunded: true, amountCents: 4900 });
      vi.mocked(Date.now).mockReturnValue(NOW + 16 * DAY); await sweep();
      expect(refundsMade.map((r) => r.amount)).toEqual([4900]); // the failed submissions made nothing at Stripe
      expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(1);
      expect(await env.DB.prepare("SELECT id,basis FROM refund_ops").first()).toEqual({ id: "eu14:in_1", basis: "eu_uk_full_refund" });
    }, 30_000);
  });

  describe("Astra ASTRA-REFUND5 (round 5): one test per finding", () => {
    const objection = (body: Record<string, unknown>) => send("/v1/admin/refund-identity-objection", { body, headers: admin });
    const REFUSAL_SUBJECT = "Murage Cloud: about your refund request";
    let mails: { subject: string; text: string }[] = [];
    let mailDown = false;
    let mailGate: Promise<void> | null = null;
    let mailReached: (() => void) | null = null;
    /** The REAL default notifier, sending through an EMAIL binding that can fail or be held at the handoff. */
    const withMail = () => {
      mails = []; mailDown = false; mailGate = null; mailReached = null;
      envOver = { EMAIL: { async send(m: { subject: string; text: string }) {
        if (mailGate) { const g = mailGate; mailGate = null; mailReached?.(); await g; }
        if (mailDown) throw new Error("mail_down");
        mails.push(m);
      } } } as unknown as Partial<Env>;
    };
    const realDeps = (over: Partial<BillingDependencies> = {}): BillingDependencies => ({ ...deps(), notifier: undefined, ...over });
    const sweepReal = (d: BillingDependencies = realDeps()) => sweepBilling(baseEnv(envOver), d).catch(() => undefined);
    const refusals = () => mails.filter((m) => m.subject === REFUSAL_SUBJECT);
    const claimTheirs = () => env.DB.prepare(`INSERT INTO refund_identity_claims (kind,key_hash,invoice_id,user_id,op_id,claimed_at)
      SELECT kind,key_hash,invoice_id,?,?,? FROM refund_identity_keys WHERE invoice_id='in_other_later'`).bind(OTHER, `firstmonth:${OTHER}`, NOW).run();
    const refusalNotice = () => env.DB.prepare("SELECT sent_at,canceled_at FROM billing_notices WHERE kind='refund_declined'").first<{ sent_at: number | null; canceled_at: number | null }>();

    it("r5-1 a decided refusal whose email failed is never sent by the sweep after an objection: the request reopens, the queued notice is cancelled", async () => {
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }), NOW + 60_000, "in_other_later");
      withMail(); mailDown = true;
      const racing = realDeps();
      // Receipt passed its identity check; the claim lands and the request waits; the decision refuses on the claim.
      const mailOnly = envOver;
      envOver = { ...mailOnly, DB: identityRace(async (n) => { if (n === 1) { await claimTheirs(); return "pending"; } }) };
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, racing)).status).toBe(409);
      envOver = mailOnly;
      // Decided and recorded by the REAL notifier; the send failed.
      expect(await env.DB.prepare("SELECT basis,notified_at FROM refund_ops WHERE kind='first_month'").first()).toEqual({ basis: "not_first_payment", notified_at: null });
      expect(await refusalNotice()).toEqual({ sent_at: null, canceled_at: null });
      expect(await (await objection({ action: "object", userId: OTHER })).json()).toMatchObject({ restricted: true });
      mailDown = false;
      vi.mocked(Date.now).mockReturnValue(NOW + DAY); await sweepReal(racing);
      expect(refusals()).toHaveLength(0);
      expect(await env.DB.prepare("SELECT decided_at,basis FROM refund_ops WHERE kind='first_month'").first()).toEqual({ decided_at: null, basis: null });
      expect((await refusalNotice())!.canceled_at).not.toBeNull();
      // Later sweeps never send it either; erased codes: the request is decided as of its receipt time and paid.
      vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY); await sweepReal(racing);
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "erase" })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY); await sweepReal(racing);
      expect(refusals()).toHaveLength(0);
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(await refusalNotice()).toMatchObject({ sent_at: null });
      envOver = {};
    }, 30_000);

    it("r5-1 a refusal told at the request whose email failed is held while an objection is open, and never sent once its codes are erased", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail(); mailDown = true;
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps())).status).toBe(409);
      expect(await refusalNotice()).toEqual({ sent_at: null, canceled_at: null });
      expect((await objection({ action: "object", userId: OTHER })).status).toBe(200);
      mailDown = false;
      for (const d of [1, 2]) { vi.mocked(Date.now).mockReturnValue(NOW + d * DAY); await sweepReal(); }
      expect(refusals()).toHaveLength(0);
      // Held, not failed: no try counted, nobody alerted.
      expect(await env.DB.prepare("SELECT attempts,canceled_at FROM billing_notices WHERE kind='refund_declined'").first()).toEqual({ attempts: 1, canceled_at: null });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind LIKE 'notice.%'")).toBe(0);
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "erase" })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY); await sweepReal();
      expect(refusals()).toHaveLength(0);
      expect((await refusalNotice())!.canceled_at).not.toBeNull();
      envOver = {};
    }, 30_000);

    /** env.DB on which the request route's final refusal check (`SELECT <refusalStands> AS ok`) runs `after` once it has answered. */
    const afterFinalCheck = (after: () => Promise<unknown>): D1Database => {
      let fired = false;
      return new Proxy(env.DB, { get(t, k) {
        if (k === "prepare") return (sql: string) => {
          const stmt = t.prepare(sql);
          if (fired || !sql.startsWith("SELECT (NOT EXISTS (SELECT 1 FROM refund_identity_restrictions") || !sql.endsWith(" AS ok")) return stmt;
          return { bind: (...a: unknown[]) => { const b = stmt.bind(...a); return { first: async () => {
            const r = await b.first(); if (!fired) { fired = true; await after(); } return r; } }; } } as unknown as D1PreparedStatement;
        };
        const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
      } });
    };
    const sendLocks = (userId: string) => count("SELECT COUNT(*) AS n FROM refund_refusal_sends WHERE user_id=?", userId);
    const restriction = (userId: string) => env.DB.prepare("SELECT pending_since,restricted_at,dispatch_unknown_at FROM refund_identity_restrictions WHERE user_id=?").bind(userId).first();

    it("r5-2 an objection that lands after the final check, before the send, cancels the refusal: held as pending, nothing sent", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      envOver = { ...envOver, DB: afterFinalCheck(() => recordObjection(baseEnv(), OTHER, NOW)) };
      const res = await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps());
      const mailOnly = { EMAIL: envOver.EMAIL } as Partial<Env>;
      envOver = mailOnly;
      expect(res.status).toBe(202);
      expect(refusals()).toHaveLength(0);
      expect((await refusalNotice())!.canceled_at).not.toBeNull();
      expect(await env.DB.prepare("SELECT decided_at,created_at FROM refund_ops WHERE kind='first_month'").first()).toEqual({ decided_at: null, created_at: NOW });
      expect(await sendLocks(OTHER)).toBe(0);
      // The objection is decided (codes kept): the waiting request is decided as of its receipt and refused, told exactly once.
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "keep" })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY); await sweepReal();
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY); await sweepReal();
      expect(refusals()).toHaveLength(1);
      expect(await refusalNotice()).toMatchObject({ canceled_at: null });
      expect((await refusalNotice())!.sent_at).not.toBeNull();
      expect(refundsPosted()).toHaveLength(0);
      envOver = {};
    }, 30_000);

    /** A refusal email held at the EMAIL handoff while the objection arrives: the objection is recorded at once as pending_restriction
     *  (ASTRA-REFUND6 #3, no waiting), the handoff already under way finishes first, and the objection is finalised right after it. */
    async function objectionDuringHandoff(sendFails: boolean) {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      let release!: () => void; mailGate = new Promise<void>((r) => { release = r; });
      const atHandoff = new Promise<void>((r) => { mailReached = () => r(); });
      const request = send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps());
      await atHandoff;
      expect(await sendLocks(OTHER)).toBe(1);
      const o = await objection({ action: "object", userId: OTHER });
      expect(o.status).toBe(200);
      expect(await o.json()).toMatchObject({ restricted: true, pending: true });
      expect(await restriction(OTHER)).toMatchObject({ pending_since: NOW, restricted_at: null });
      mailDown = sendFails;
      release();
      const res = await request;
      expect(res.status).toBe(409);
      expect(await sendLocks(OTHER)).toBe(0);
      // The sender's release finalised it: nothing for anyone to retry.
      expect(await restriction(OTHER)).toMatchObject({ pending_since: null, restricted_at: NOW });
      mailDown = false;
      for (const d of [1, 2]) { vi.mocked(Date.now).mockReturnValue(NOW + d * DAY); await sweepReal(); }
    }

    it("r5-2 an objection during the refusal's email handoff lands after it: the refusal went out first, once", async () => {
      await objectionDuringHandoff(false);
      expect(refusals()).toHaveLength(1);
      expect((await refusalNotice())!.sent_at).not.toBeNull();
      envOver = {};
    }, 30_000);

    it("r5-2 an objection during a handoff that fails lands after it, and the failed refusal is never retried", async () => {
      await objectionDuringHandoff(true);
      expect(refusals()).toHaveLength(0);
      expect(await refusalNotice()).toMatchObject({ sent_at: null });
      envOver = {};
    }, 30_000);

    /** Starts a refusal request and holds its email at the EMAIL handoff; resolves once that send is in flight (lock rows written). */
    async function heldRefusal() {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      let release!: () => void; mailGate = new Promise<void>((r) => { release = r; });
      const atHandoff = new Promise<void>((r) => { mailReached = () => r(); });
      const request = send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps());
      await atHandoff;
      return { release, request };
    }
    /** env.DB that runs `before` ahead of the n-th statement whose SQL starts with `prefix` (alone, or ahead of the batch carrying it). */
    const dbHook = (prefix: string, n: number, before: () => Promise<unknown>): D1Database => {
      let seen = 0;
      const real = new WeakMap<object, D1PreparedStatement>();
      return new Proxy(env.DB, { get(t, k) {
        if (k === "prepare") return (sql: string) => {
          const stmt = t.prepare(sql);
          if (!sql.trimStart().startsWith(prefix) || ++seen !== n) return stmt;
          const wrap = (s: D1PreparedStatement): unknown => {
            const w = { bind: (...a: unknown[]) => wrap(s.bind(...a)),
              first: async (c?: string) => { await before(); return c === undefined ? s.first() : s.first(c); },
              run: async () => { await before(); return s.run(); }, all: async () => { await before(); return s.all(); } };
            real.set(w, s);
            return w;
          };
          return wrap(stmt) as D1PreparedStatement;
        };
        if (k === "batch") return async (stmts: D1PreparedStatement[]) => {
          if (stmts.some((x) => real.has(x))) await before();
          return t.batch(stmts.map((x) => real.get(x) ?? x));
        };
        const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
      } });
    };

    it("r6-1 a send that ends right after the objection's second failed guard: the objection is recorded (200), one restriction row", async () => {
      const { release, request } = await heldRefusal();
      // The sender's handoff ends (its lock rows go) between the objection's second failed guard and its follow-up lock read.
      envOver = { ...envOver, DB: dbHook("SELECT 1 AS x FROM refund_refusal_sends", 2, () => env.DB.prepare("DELETE FROM refund_refusal_sends").run()) };
      const o = await objection({ action: "object", userId: OTHER });
      envOver = { EMAIL: envOver.EMAIL } as Partial<Env>;
      expect(o.status).toBe(200);
      expect(await o.json()).toMatchObject({ restricted: true });
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_restrictions WHERE user_id=?", OTHER)).toBe(1);
      release();
      expect((await request).status).toBe(409);
      envOver = {};
    }, 30_000);

    /** env.DB with `ms` of latency added to every database round trip (each statement and each batch). */
    const slowDb = (ms: number): D1Database => {
      const delay = () => new Promise((r) => setTimeout(r, ms));
      const real = new WeakMap<object, D1PreparedStatement>();
      const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
        const p = new Proxy(s, { get(t, k) {
          if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
          if (k === "first" || k === "run" || k === "all" || k === "raw") return async (...a: unknown[]) => { await delay(); return (t[k] as (...x: unknown[]) => unknown).apply(t, a); };
          const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
        } });
        real.set(p, s); return p;
      };
      return new Proxy(env.DB, { get(t, k) {
        if (k === "prepare") return (sql: string) => wrap(t.prepare(sql));
        if (k === "batch") return async (stmts: D1PreparedStatement[]) => { await delay(); return t.batch(stmts.map((x) => real.get(x) ?? x)); };
        const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
      } });
    };

    it("r6-3 with 50 ms per database round trip, an objection during a handoff is recorded at once (pending), never a 409", async () => {
      const { release, request } = await heldRefusal();
      envOver = { ...envOver, DB: slowDb(50) };
      const t0 = performance.now();
      const o = await objection({ action: "object", userId: OTHER });
      const took = performance.now() - t0;
      envOver = { EMAIL: envOver.EMAIL } as Partial<Env>;
      expect(o.status).toBe(200);
      expect(await o.json()).toMatchObject({ restricted: true, pending: true });
      expect(took).toBeLessThan(5_000);
      expect(await restriction(OTHER)).toMatchObject({ pending_since: NOW, restricted_at: null });
      release();
      expect((await request).status).toBe(409);
      expect(await restriction(OTHER)).toMatchObject({ pending_since: null, restricted_at: NOW });
      envOver = {};
    }, 30_000);

    it("r6-3 a pending objection is never overtaken: three later refusal senders in a row are all held, none dispatched", async () => {
      // Three other accounts each share exactly one key with OTHER's earlier payment (its email, its billing name and address, its card)
      // and nothing with anyone else: each of their refusals rests on OTHER alone.
      const address = { line1: "1 Main St", postal_code: "94105", country: "US" };
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared", email: "other@example.com", name: "Pat Other", address }));
      const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
      const later: Record<number, { identity: Record<string, unknown>; paidAt: number }> = {
        2: { identity: cardPayment({ fingerprint: "fp_u2", email: "other@example.com" }), paidAt: NOW + 2_000 },
        3: { identity: cardPayment({ fingerprint: "fp_u3", name: "Pat Other", address }), paidAt: NOW + 3_000 },
        4: { identity: cardPayment({ fingerprint: "fp_shared" }), paidAt: NOW - DAY }, // before our payment: only OTHER's is earlier
      };
      for (const n of [2, 3, 4]) {
        piIdentity[`pi_u${n}`] = later[n].identity;
        expect(await captureRefundIdentity(baseEnv(), st, { homeId: `home-u${n}`, userId: `u${n}`, invoiceId: `in_u${n}`, paidAt: later[n].paidAt, paymentIntent: `pi_u${n}` }, NOW)).toBe(true);
        expect(await refusalNoticeState(baseEnv(), { invoiceId: `in_u${n}`, userId: `u${n}` })).toBe("send");
      }
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      let release!: () => void; mailGate = new Promise<void>((r) => { release = r; });
      const atHandoff = new Promise<void>((r) => { mailReached = () => r(); });
      const request = send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps());
      await atHandoff;
      expect(await (await objection({ action: "object", userId: OTHER })).json()).toMatchObject({ restricted: true, pending: true });
      for (const n of [2, 3, 4]) {
        const lease = (await acquireHomeLease(env, `home-u${n}`, `sender-u${n}`))!;
        await expect(defaultNotifier.notify(baseEnv(envOver), { id: `refund_declined:home-u${n}:not_first_payment:in_u${n}`, homeId: `home-u${n}`, ownerId: `u${n}`,
          kind: "refund_declined", data: { reason: "not_first_payment", invoiceId: `in_u${n}`, userId: `u${n}` } }, lease)).rejects.toThrow("refusal_held");
        await releaseHomeLease(env, lease);
      }
      // Only the handoff that was already under way holds a dispatch; none of the three got one, none was claimed.
      expect(await count("SELECT COUNT(*) AS n FROM refund_refusal_sends WHERE notice_id LIKE '%in_u%'")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE id LIKE '%in_u%' AND (sent_at IS NOT NULL OR claimed_until IS NOT NULL)")).toBe(0);
      release();
      expect((await request).status).toBe(409);
      expect(refusals()).toHaveLength(1); // the one handed off before the objection
      expect(await restriction(OTHER)).toMatchObject({ pending_since: null, restricted_at: NOW });
      envOver = {};
    }, 30_000);

    /** The refusal's dispatch rows, and the stalled sender's home lease, aged past their `until` on the database's clock (as if the sender
     *  had stalled for over two minutes): a takeover may now act, but only through reconciliation. */
    const ageDispatches = () => env.DB.batch([env.DB.prepare("UPDATE refund_refusal_sends SET until=until-?").bind(10 * 60_000),
      env.DB.prepare("UPDATE billing_home_leases SET lease_until=lease_until-? WHERE lease_until IS NOT NULL").bind(10 * 60_000)]);
    const dispatchOf = () => env.DB.prepare("SELECT sent_at,canceled_at,claimed_until,dispatch_fence,dispatch_state FROM billing_notices WHERE kind='refund_declined'").first();

    it("r6-2 an expiry takeover while the sender is stalled before its EMAIL handoff: fence revoked, then released, no refusal is sent", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      let stalled!: () => void; const atStall = new Promise<void>((r) => { stalled = r; });
      // The sender stalls right before it marks the dispatch handed off (the last step before calling EMAIL).
      envOver = { ...envOver, DB: dbHook("UPDATE billing_notices SET dispatch_state='handed_off'", 1, async () => { stalled(); await gate; }) };
      const request = send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps());
      await atStall;
      envOver = { EMAIL: envOver.EMAIL } as Partial<Env>;
      expect(await (await objection({ action: "object", userId: OTHER })).json()).toMatchObject({ restricted: true, pending: true });
      // Over two minutes later on the database's clock, the sweep takes over: it reconciles the dispatch before finalising the objection.
      await ageDispatches();
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * 60_000);
      await finalisePendingObjections(baseEnv(), NOW + 3 * 60_000);
      expect(await dispatchOf()).toMatchObject({ sent_at: null, dispatch_fence: null, dispatch_state: null });
      expect(await restriction(OTHER)).toMatchObject({ pending_since: null, restricted_at: NOW + 3 * 60_000, dispatch_unknown_at: null });
      expect(await sendLocks(OTHER)).toBe(0);
      // The stalled sender resumes: its fenced handoff is refused, nothing reaches EMAIL, and it records nothing.
      release();
      expect((await request).status).toBe(409);
      expect(refusals()).toHaveLength(0);
      expect(await dispatchOf()).toMatchObject({ sent_at: null, dispatch_state: null });
      // Held while the objection is open; never sent once the codes it rested on are erased.
      for (const d of [1, 2]) { vi.mocked(Date.now).mockReturnValue(NOW + d * DAY); await sweepReal(); }
      expect(refusals()).toHaveLength(0);
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "erase" })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY); await sweepReal();
      expect(refusals()).toHaveLength(0);
      expect((await refusalNotice())!.canceled_at).not.toBeNull();
      envOver = {};
    }, 30_000);

    it("r7-2 a sender stalled in preparing its trace header is revoked by a takeover: its handoff is refused, EMAIL is never started", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      let stalled!: () => void; const atStall = new Promise<void>((r) => { stalled = r; });
      // The reviewer's pause point: noticeTraceId() (its SHA-256 digest of the refusal's notice id).
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let stall = true;
      const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (alg: AlgorithmIdentifier, data: BufferSource) => {
        if (stall && new TextDecoder().decode(data).startsWith("refund_declined:")) { stall = false; stalled(); await gate; }
        return digest(alg, data);
      });
      try {
        const request = send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps());
        await atStall;
        // The trace header is prepared before the handoff: the dispatch is still only 'dispatching'.
        expect(await dispatchOf()).toMatchObject({ sent_at: null, dispatch_state: "dispatching" });
        expect(await (await objection({ action: "object", userId: OTHER })).json()).toMatchObject({ restricted: true, pending: true });
        // At +120,010 ms (past the dispatch's `until`) the sweep reconciles it: the fence is revoked.
        await ageDispatches();
        vi.mocked(Date.now).mockReturnValue(NOW + 120_010);
        await finalisePendingObjections(baseEnv(), NOW + 120_010);
        expect(await dispatchOf()).toMatchObject({ sent_at: null, dispatch_fence: null, dispatch_state: null });
        release();
        expect((await request).status).toBe(409);
        expect(refusals()).toHaveLength(0);
        expect(await dispatchOf()).toMatchObject({ sent_at: null, dispatch_state: null });
      } finally { spy.mockRestore(); }
      envOver = {};
    }, 30_000);

    it("r6-2 an expiry takeover while EMAIL itself is held: recorded as sent-or-unknown, the late finalise is refused, never sent again", async () => {
      const { release, request } = await heldRefusal();
      expect(await (await objection({ action: "object", userId: OTHER })).json()).toMatchObject({ restricted: true, pending: true });
      await ageDispatches();
      await finalisePendingObjections(baseEnv(), NOW + 3 * 60_000);
      // Already handed to EMAIL: nobody can tell whether it went out. The record says so; the objection notes it.
      expect(await dispatchOf()).toMatchObject({ sent_at: null, dispatch_fence: null, dispatch_state: "unknown" });
      expect(await restriction(OTHER)).toMatchObject({ pending_since: null, restricted_at: NOW + 3 * 60_000, dispatch_unknown_at: NOW + 3 * 60_000 });
      release();
      expect((await request).status).toBe(409);
      expect(refusals()).toHaveLength(1); // the provider call already under way could not be recalled
      // Its late finalise carried a revoked fence: refused, the takeover's record stands.
      expect(await dispatchOf()).toMatchObject({ sent_at: null, dispatch_state: "unknown" });
      // Revalidated like any queued refusal: held while the objection is open (never sent a second time), cancelled once obsolete.
      for (const d of [1, 2]) { vi.mocked(Date.now).mockReturnValue(NOW + d * DAY); await sweepReal(); }
      expect(refusals()).toHaveLength(1);
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "erase" })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY); await sweepReal();
      expect(refusals()).toHaveLength(1);
      expect((await refusalNotice())!.canceled_at).not.toBeNull();
      envOver = {};
    }, 30_000);

    /** A 7-day request refused at request time on OTHER's codes (told at once), then OTHER's objection upheld: their codes are erased. */
    async function refusedThenErased() {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps())).status).toBe(409);
      expect(refusals()).toHaveLength(1);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(await env.DB.prepare("SELECT received_at,rested_on,reopened_at FROM refund_refusal_receipts WHERE invoice_id='in_1'").first())
        .toEqual({ received_at: NOW, rested_on: JSON.stringify([OTHER]), reopened_at: null });
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      expect((await objection({ action: "object", userId: OTHER })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "erase" })).status).toBe(200);
    }
    const reopenedOp = () => env.DB.prepare("SELECT id,created_at,basis,amount_cents FROM refund_ops WHERE kind='first_month'").first();

    it("r6-4 a request-time refusal whose codes are erased, asked again on day 8: paid from the original receipt, never window_expired", async () => {
      await refusedThenErased();
      vi.mocked(Date.now).mockReturnValue(NOW + 8 * DAY);
      const again = await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps());
      const body = await again.json() as Record<string, unknown>;
      expect(body.error).not.toBe("window_expired");
      expect(again.status).toBe(200);
      expect(body).toMatchObject({ refunded: true, amountCents: 4900 });
      expect(await reopenedOp()).toEqual({ id: `firstmonth:${OWNER}`, created_at: NOW, basis: "seven_day_offer", amount_cents: 4900 });
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(await env.DB.prepare("SELECT reopened_at,op_id FROM refund_refusal_receipts WHERE invoice_id='in_1'").first())
        .toEqual({ reopened_at: NOW + 8 * DAY, op_id: `firstmonth:${OWNER}` });
      envOver = {};
    }, 30_000);

    it("r6-4 a request-time refusal whose codes are erased is reopened by the sweep on its own, from its receipt, and paid", async () => {
      await refusedThenErased();
      vi.mocked(Date.now).mockReturnValue(NOW + 9 * DAY); await sweepReal();
      vi.mocked(Date.now).mockReturnValue(NOW + 10 * DAY); await sweepReal();
      expect(await reopenedOp()).toEqual({ id: `firstmonth:${OWNER}`, created_at: NOW, basis: "seven_day_offer", amount_cents: 4900 });
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(await count("SELECT COUNT(*) AS n FROM refund_refusal_receipts WHERE reopened_at IS NULL")).toBe(0);
      envOver = {};
    }, 30_000);

    it("r6-4 a request-time refusal that still stands is never reopened by the sweep or by asking again", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps())).status).toBe(409);
      vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY); await sweepReal();
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps())).status).toBe(409);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(refundsPosted()).toHaveLength(0);
      envOver = {};
    }, 30_000);

    it("r7-3 two matching people: one erased, the refusal still stands; the other ages out -> no event, no reopen, no payment", async () => {
      const THIRD = "user-third";
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      // A third person paid with the same card just inside the 24 months: their codes age out on day 4.
      piIdentity.pi_third = cardPayment({ fingerprint: "fp_shared" });
      const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
      expect(await captureRefundIdentity(baseEnv(envOver), st, { homeId: "home-third", userId: THIRD, invoiceId: "in_third",
        paidAt: retentionCutoff(NOW + 4 * DAY) - 1, paymentIntent: "pi_third" }, NOW)).toBe(true);
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps())).status).toBe(409);
      const rested = await env.DB.prepare("SELECT rested_on FROM refund_refusal_receipts WHERE invoice_id='in_1'").first<{ rested_on: string }>();
      expect((JSON.parse(rested!.rested_on) as string[]).sort()).toEqual([OTHER, THIRD].sort());
      // OTHER's codes are erased on an upheld objection: the refusal still stands on THIRD's, so no invalidation is recorded.
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      expect((await objection({ action: "object", userId: OTHER })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "erase" })).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_refusal_invalidations")).toBe(0);
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY); await sweepReal();
      // THIRD's codes age out (the 24-month purge): today nothing matches, but that is no grounds to reopen.
      vi.mocked(Date.now).mockReturnValue(NOW + 5 * DAY); await sweepReal();
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE user_id=?", THIRD)).toBe(0);
      vi.mocked(Date.now).mockReturnValue(NOW + 6 * DAY); await sweepReal();
      expect(await env.DB.prepare("SELECT reopened_at FROM refund_refusal_receipts WHERE invoice_id='in_1'").first()).toEqual({ reopened_at: null });
      // Day 9: the 7-day offer's window (AoE end of the 7th day after payment, checkout WP5) has passed.
      vi.mocked(Date.now).mockReturnValue(NOW + 9 * DAY);
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps())).status).not.toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 10 * DAY); await sweepReal();
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE COALESCE(amount_cents,0)>0")).toBe(0);
      expect(refundsPosted()).toHaveLength(0);
      envOver = {};
    }, 30_000);

    it("r7-3 an erasure that invalidates the refusal records its event (who invalidated which refusal) in the same write", async () => {
      await refusedThenErased();
      expect(await env.DB.prepare("SELECT invoice_id,erased_user_id,erased_through,held FROM refund_refusal_invalidations").all().then((r) => r.results))
        .toEqual([{ invoice_id: "in_1", erased_user_id: OTHER, erased_through: NOW + 2 * DAY, held: 0 }]);
      envOver = {};
    }, 30_000);

    it("r7-4 an erasure while the refusal email is held: the receipt and its rested_on were written before EMAIL; day-8 reapply pays", async () => {
      const { release, request } = await heldRefusal();
      // The receipt is already on record, with the person the refusal rests on, while EMAIL is in flight.
      expect(await env.DB.prepare("SELECT received_at,rested_on,reopened_at FROM refund_refusal_receipts WHERE invoice_id='in_1'").first())
        .toEqual({ received_at: NOW, rested_on: JSON.stringify([OTHER]), reopened_at: null });
      expect((await objection({ action: "object", userId: OTHER })).status).toBe(200);
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "erase" })).status).toBe(200);
      release();
      expect((await request).status).toBe(409);
      expect(await env.DB.prepare("SELECT rested_on FROM refund_refusal_receipts WHERE invoice_id='in_1'").first()).toEqual({ rested_on: JSON.stringify([OTHER]) });
      expect(await count("SELECT COUNT(*) AS n FROM refund_refusal_invalidations WHERE invoice_id='in_1' AND held=0")).toBe(1);
      vi.mocked(Date.now).mockReturnValue(NOW + 8 * DAY);
      const again = await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps());
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ refunded: true, amountCents: 4900 });
      expect(await reopenedOp()).toEqual({ id: `firstmonth:${OWNER}`, created_at: NOW, basis: "seven_day_offer", amount_cents: 4900 });
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      envOver = {};
    }, 30_000);

    /** env.DB whose next batch containing a statement starting with `prefix` fails once (a transient database error), before it commits. */
    const failBatchOnce = (prefix: string): D1Database => {
      let armed = true;
      const tagged = new WeakSet<object>();
      return new Proxy(env.DB, { get(t, k) {
        if (k === "prepare") return (sql: string) => {
          const stmt = t.prepare(sql);
          if (!sql.trimStart().startsWith(prefix)) return stmt;
          const bind = stmt.bind.bind(stmt);
          return Object.assign(stmt, { bind: (...a: unknown[]) => { const b = bind(...a); tagged.add(b); return b; } });
        };
        if (k === "batch") return async (stmts: D1PreparedStatement[]) => {
          if (armed && stmts.some((x) => tagged.has(x))) { armed = false; throw new Error("D1_ERROR: injected transient failure"); }
          return t.batch(stmts);
        };
        const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
      } });
    };

    it("r7-1 a transient database failure before the reopening batch commits: the receipt stays open, the next sweep reopens and pays once", async () => {
      await refusedThenErased();
      envOver = { ...envOver, DB: failBatchOnce("INSERT INTO first_month_refunds") };
      vi.mocked(Date.now).mockReturnValue(NOW + 9 * DAY); await sweepReal();
      // Nothing was written by the failed batch, and the receipt was not closed on its own.
      expect(await env.DB.prepare("SELECT reopened_at,op_id FROM refund_refusal_receipts WHERE invoice_id='in_1'").first()).toEqual({ reopened_at: null, op_id: null });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(refundsPosted()).toHaveLength(0);
      for (const d of [10, 11]) { vi.mocked(Date.now).mockReturnValue(NOW + d * DAY); await sweepReal(); }
      expect(await reopenedOp()).toEqual({ id: `firstmonth:${OWNER}`, created_at: NOW, basis: "seven_day_offer", amount_cents: 4900 });
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(await env.DB.prepare("SELECT op_id FROM refund_refusal_receipts WHERE invoice_id='in_1'").first()).toEqual({ op_id: `firstmonth:${OWNER}` });
      envOver = {};
    }, 30_000);

    /** A third person's same-card payment, captured now through the real code path (`paidAt` is when they paid). */
    const THIRD = "user-third";
    async function thirdPaid(paidAt: number, capturedAt: number) {
      piIdentity.pi_third = cardPayment({ fingerprint: "fp_shared" });
      const st = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
      expect(await captureRefundIdentity(baseEnv(envOver), st, { homeId: "home-third", userId: THIRD, invoiceId: "in_third", paidAt,
        paymentIntent: "pi_third" }, capturedAt)).toBe(true);
    }
    const eraseOn = async (userId: string, objectAt: number, decideAt: number) => {
      vi.mocked(Date.now).mockReturnValue(objectAt);
      expect((await objection({ action: "object", userId })).status).toBe(200);
      vi.mocked(Date.now).mockReturnValue(decideAt);
      expect((await objection({ action: "decision_notice_sent", userId, decision: "erase" })).status).toBe(200);
    };

    it("r8-1 a matching payment captured after the refusal: erase A (still stands on B), then erase B -> reopened, paid once on day 8", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps())).status).toBe(409);
      expect(await env.DB.prepare("SELECT rested_on FROM refund_refusal_receipts WHERE invoice_id='in_1'").first()).toEqual({ rested_on: JSON.stringify([OTHER]) });
      // Later, THIRD's EARLIER same-card payment is captured: it matches today, but the frozen rested_on never names it.
      await thirdPaid(NOW - 2 * DAY, NOW + DAY / 2);
      await eraseOn(OTHER, NOW + DAY, NOW + 2 * DAY);
      expect(await count("SELECT COUNT(*) AS n FROM refund_refusal_invalidations")).toBe(0); // still stands on THIRD's codes
      await eraseOn(THIRD, NOW + 3 * DAY, NOW + 4 * DAY);
      expect(await env.DB.prepare("SELECT invoice_id,erased_user_id,held FROM refund_refusal_invalidations").all().then((r) => r.results))
        .toEqual([{ invoice_id: "in_1", erased_user_id: THIRD, held: 0 }]);
      expect(await count("SELECT COUNT(*) AS n FROM refund_refusal_erasure_scan")).toBe(0);
      vi.mocked(Date.now).mockReturnValue(NOW + 8 * DAY);
      const again = await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps());
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ refunded: true, amountCents: 4900 });
      vi.mocked(Date.now).mockReturnValue(NOW + 9 * DAY); await sweepReal();
      expect(await reopenedOp()).toEqual({ id: `firstmonth:${OWNER}`, created_at: NOW, basis: "seven_day_offer", amount_cents: 4900 });
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      envOver = {};
    }, 30_000);

    /** Day 8 asks again, day 9 sweeps: the refusal stands as recorded, nothing is reopened or paid. */
    async function neverReopened() {
      vi.mocked(Date.now).mockReturnValue(NOW + 9 * DAY);
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps())).status).not.toBe(200);
      vi.mocked(Date.now).mockReturnValue(NOW + 10 * DAY); await sweepReal();
      expect(await env.DB.prepare("SELECT reopened_at FROM refund_refusal_receipts WHERE invoice_id='in_1'").first()).toEqual({ reopened_at: null });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE COALESCE(amount_cents,0)>0")).toBe(0);
      expect(refundsPosted()).toHaveLength(0);
    }

    it("r8-2 erasing a matcher whose codes were already purged invalidates nothing: no event, no payment", async () => {
      await thirdPaid(retentionCutoff(NOW + 4 * DAY) - 1, NOW); // ages out on day 4
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps())).status).toBe(409);
      expect(await env.DB.prepare("SELECT rested_on FROM refund_refusal_receipts WHERE invoice_id='in_1'").first()).toEqual({ rested_on: JSON.stringify([THIRD]) });
      vi.mocked(Date.now).mockReturnValue(NOW + 5 * DAY); await sweepReal();
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE user_id=?", THIRD)).toBe(0);
      await eraseOn(THIRD, NOW + 6 * DAY, NOW + 7 * DAY);
      expect(await count("SELECT COUNT(*) AS n FROM refund_refusal_invalidations")).toBe(0);
      await neverReopened();
      envOver = {};
    }, 30_000);

    it("r8-2 erase A while B's objection is open, B's codes purged, B decided keep: the purge promotes nothing, no payment", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      await thirdPaid(retentionCutoff(NOW + 4 * DAY) - 1, NOW);
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps())).status).toBe(409);
      vi.mocked(Date.now).mockReturnValue(NOW + DAY);
      expect((await objection({ action: "object", userId: THIRD })).status).toBe(200);
      // OTHER erased while THIRD's codes are only masked by the open objection: they still match, so this erasure lost nothing.
      await eraseOn(OTHER, NOW + 2 * DAY, NOW + 3 * DAY);
      expect(await count("SELECT COUNT(*) AS n FROM refund_refusal_invalidations")).toBe(0);
      vi.mocked(Date.now).mockReturnValue(NOW + 5 * DAY); await sweepReal();
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_keys WHERE user_id=?", THIRD)).toBe(0);
      vi.mocked(Date.now).mockReturnValue(NOW + 6 * DAY);
      expect((await objection({ action: "decision_notice_sent", userId: THIRD, decision: "keep" })).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_refusal_invalidations")).toBe(0);
      await neverReopened();
      envOver = {};
    }, 30_000);

    const DB_NOW_SQL = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
    /** env.DB whose next batch carrying a statement that starts with `prefix` commits, then runs `after` before its answer is returned. */
    const holdAfterCommit = (prefix: string, after: () => Promise<unknown>): D1Database => {
      let armed = true;
      const tagged = new WeakSet<object>();
      return new Proxy(env.DB, { get(t, k) {
        if (k === "prepare") return (sql: string) => {
          const stmt = t.prepare(sql);
          if (!sql.trimStart().startsWith(prefix)) return stmt;
          const bind = stmt.bind.bind(stmt);
          return Object.assign(stmt, { bind: (...a: unknown[]) => { const b = bind(...a); tagged.add(b); return b; } });
        };
        if (k === "batch") return async (stmts: D1PreparedStatement[]) => {
          const res = await t.batch(stmts);
          if (armed && stmts.some((x) => tagged.has(x))) { armed = false; await after(); }
          return res;
        };
        const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
      } });
    };

    it("r8-3 the handoff write commits but its answer is delayed: reconciled and erased meanwhile, the late sender never starts EMAIL", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      let held!: () => void; const atHold = new Promise<void>((r) => { held = r; });
      // The reviewer's pause point: the successful handoff write is committed, its acknowledgement is held.
      envOver = { ...envOver, DB: holdAfterCommit("UPDATE billing_notices SET dispatch_state='handed_off'", async () => { held(); await gate; }) };
      const request = send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps());
      await atHold;
      envOver = { EMAIL: envOver.EMAIL } as Partial<Env>;
      expect(await dispatchOf()).toMatchObject({ sent_at: null, dispatch_state: "handed_off" });
      expect(await (await objection({ action: "object", userId: OTHER })).json()).toMatchObject({ restricted: true, pending: true });
      // Past the renewed `until` the sweep reconciles the dispatch (recorded as sent-or-unknown, fence revoked); the codes are erased.
      await ageDispatches();
      vi.mocked(Date.now).mockReturnValue(NOW + 3 * 60_000);
      await finalisePendingObjections(baseEnv(), NOW + 3 * 60_000);
      expect(await dispatchOf()).toMatchObject({ sent_at: null, dispatch_fence: null, dispatch_state: "unknown" });
      expect((await objection({ action: "decision_notice_sent", userId: OTHER, decision: "erase" })).status).toBe(200);
      // The acknowledgement arrives: past the local deadline, so EMAIL is never called.
      release();
      expect((await request).status).toBe(409);
      expect(refusals()).toHaveLength(0);
      vi.mocked(Date.now).mockReturnValue(NOW + DAY); await sweepReal();
      expect(refusals()).toHaveLength(0);
      expect((await refusalNotice())!.canceled_at).not.toBeNull();
      envOver = {};
    }, 30_000);

    it("r8-3 the handoff renews the dispatch rows and the home lease in the same write", async () => {
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }));
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs();
      withMail();
      let release!: () => void; mailGate = new Promise<void>((r) => { release = r; });
      const atEmail = new Promise<void>((r) => { mailReached = () => r(); });
      // 90 s of the dispatch's and the lease's two minutes are used up before the handoff (on the database's clock).
      const age = (ms: number) => env.DB.batch([env.DB.prepare("UPDATE refund_refusal_sends SET until=until-?").bind(ms),
        env.DB.prepare("UPDATE billing_home_leases SET lease_until=lease_until-? WHERE lease_until IS NOT NULL").bind(ms)]);
      envOver = { ...envOver, DB: dbHook("UPDATE billing_notices SET dispatch_state='handed_off'", 1, () => age(90_000)) };
      const request = send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }, realDeps());
      await atEmail;
      const left = await env.DB.prepare(`SELECT (SELECT MIN(until) FROM refund_refusal_sends)-${DB_NOW_SQL} AS sends,
        (SELECT lease_until FROM billing_home_leases WHERE home_id='home-1')-${DB_NOW_SQL} AS lease`).first<{ sends: number; lease: number }>();
      // Renewed to a full two minutes from the handoff, not the 30 s the claim had left.
      expect(left!.sends).toBeGreaterThan(100_000);
      expect(left!.lease).toBeGreaterThan(100_000);
      release();
      expect((await request).status).toBe(409);
      expect(refusals()).toHaveLength(1);
      envOver = {};
    }, 30_000);

    it("r5-3 a forced non-EU internal withdrawal whose offer claim conflicts pays the statutory refund at once: no ledger_conflict retry", async () => {
      piIdentity.pi_1 = cardPayment({ fingerprint: "fp_shared" });
      await paidUs(); await serviceUp();
      await env.DB.prepare("UPDATE checkout_consents SET early_start=1 WHERE home_id='home-1'").run();
      // A later same-card payment holds the offer's claim on our keys, and its owner's objection is open: the identity check cannot
      // run, so the 7-day offer is applied unchecked (it beats pro-rata) and its claim conflicts at the decision.
      await otherAccountPaid(cardPayment({ fingerprint: "fp_shared" }), NOW + 60_000, "in_other_later");
      await claimTheirs();
      await recordObjection(baseEnv(), OTHER, NOW + 60_000);
      const at = NOW + 3 * DAY;
      vi.mocked(Date.now).mockReturnValue(at);
      // Forced: the non-EU route refuses a withdrawal (409), so the operation is opened directly, as the internal fallback would be.
      const [sql, binds] = refundOpInsert({ id: "withdrawal:forced", kind: "withdrawal", homeId: "home-1", userId: OWNER, subscriptionId: "sub_test1", endPlan: true,
        detail: { confirmedAt: at, consentId: await latestConsentId("home-1") } }, at);
      await env.DB.prepare(sql).bind(...(binds ?? [])).run();
      const stripe = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, stripeFetch);
      const op = (await advanceRefundOp(baseEnv(), { stripe, flux, deps: deps(), now: at }, "withdrawal:forced"))!;
      // r13 (plan §3.1, checkout WP3/WP5): no deduction is claimed for service supplied, so the statutory withdrawal refund is the whole 4,900.
      expect(op).toMatchObject({ basis: "pro_rata", amount_cents: 4900, attempts: 0, last_error: null, done_at: at });
      // The 7-day offer never beats a statutory refund that already returns everything, so it is not applied and nothing of it can conflict.
      expect(JSON.parse(op.detail!)).toMatchObject({ identityUnchecked: true, daysSupplied: 3 });
      expect(refundsPosted().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      // The uplift took nothing: no claim on our keys, no once-per-person slot, no guard left behind.
      expect(await count("SELECT COUNT(*) AS n FROM refund_identity_claims WHERE invoice_id='in_1'")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_write_guards")).toBe(0);
    }, 30_000);
  });
});

describe("auto top-up settings (stored for B4)", () => {
  it("can be turned on, changed or off from My Cloud, each change logged; bad numbers are refused", async () => {
    await paidUs(); signedIn = OWNER;
    const set = (body: Record<string, unknown>) => send("/v1/account/topup", { body: { client: { ip: "198.51.100.9", userAgent: "ua" }, ...body } });
    const on = await set({ enabled: true, amountUsd: 30, thresholdUsd: 10, capUsd: 90 });
    expect(await on.json()).toMatchObject({ enabled: true, authorization: expect.stringContaining("up to $90 per calendar month") });
    expect(await env.DB.prepare("SELECT enabled,amount_cents,cap_cents FROM topup_settings").first()).toEqual({ enabled: 1, amount_cents: 3000, cap_cents: 9000 });
    expect((await set({ enabled: false, amountUsd: 30, thresholdUsd: 10, capUsd: 90 })).status).toBe(200);
    expect(await env.DB.prepare("SELECT enabled FROM topup_settings").first()).toEqual({ enabled: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM topup_events")).toBe(2);
    expect(await env.DB.prepare("SELECT source,ip,user_agent FROM topup_events ORDER BY created_at, rowid LIMIT 1").first()).toEqual({ source: "account", ip: "198.51.100.9", user_agent: "ua" });
    expect(await (await set({ enabled: true, amountUsd: 30, thresholdUsd: 10, capUsd: 20 })).json()).toEqual({ error: "topup_invalid" });
  });
});

describe("export request pauses the day-14 deletion", () => {
  async function suspendedWithTwoNotices() {
    await paidUs();
    await hook(stripeEvent("invoice.payment_failed", invoice({ id: "in_2", billing_reason: "subscription_cycle" }), NOW / 1000 + 60)); await reconcile();
    vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY + 1000); await reconcile();
    const s = await getHome();
    expect(s.desired_state).toBe("suspended");
    await sweepBilling(baseEnv(), deps());
    vi.mocked(Date.now).mockReturnValue(s.delete_after! - 3 * DAY); await sweepBilling(baseEnv(), deps());
    expect((await getHome()).suspension_notices).toBe(2);
    return s.delete_after!;
  }
  const request = () => send("/v1/account/export-request", { body: {} });

  it("records one open request per home, alerts operators, and acknowledges by email", async () => {
    await paidUs(); signedIn = OWNER;
    const res = await request();
    expect(res.status).toBe(201);
    const body = await res.json() as { requestId: string; pausesDeletionUntil: number };
    expect(body.pausesDeletionUntil).toBe(NOW + 7 * DAY);
    expect(await env.DB.prepare("SELECT status,home_id FROM data_export_requests").first()).toEqual({ status: "open", home_id: "home-1" });
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='export_requested'").first()).toEqual({ kind: "export_requested" });
    expect(notices.some((n) => n.kind === "export_requested")).toBe(true);
    // Deletion timing is config.retentionMs (14 days in this fixture; 30 in production), rendered, never hard-coded.
    const exportText = (notices.find((n) => n.kind === "export_requested")!.data as { emailText: string }).emailText;
    expect(exportText).toContain("deletion goes ahead on the usual schedule: 14 days after your server was suspended");
    const again = await (await request()).json() as { requestId: string; existing: boolean };
    expect(again).toMatchObject({ requestId: body.requestId, existing: true });
    expect(await count("SELECT COUNT(*) AS n FROM data_export_requests")).toBe(1);
    expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ exportRequest: { status: "open" } });
  });
  it("while a request is open the deletion waits; delivery resumes it", async () => {
    const deleteAfter = await suspendedWithTwoNotices(); signedIn = OWNER;
    vi.mocked(Date.now).mockReturnValue(deleteAfter - DAY);
    const { requestId } = await (await request()).json() as { requestId: string };
    vi.mocked(Date.now).mockReturnValue(deleteAfter + 1000); await reconcile();
    expect((await getHome()).desired_state).toBe("suspended"); // day 14 passed, request open: kept
    vi.mocked(Date.now).mockReturnValue(deleteAfter + 3 * DAY); await reconcile();
    expect((await getHome()).desired_state).toBe("suspended");
    expect((await send("/v1/admin/export-delivered", { body: { requestId } })).status).toBe(401); // operator only
    expect((await send("/v1/admin/export-delivered", { body: { requestId }, headers: admin })).status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM data_export_requests").first()).toEqual({ status: "delivered" });
    expect(notices.some((n) => n.kind === "export_delivered")).toBe(true);
    await reconcile();
    expect((await getHome()).desired_state).toBe("deleting");
  });
  it("after 7 days an undelivered request stops pausing, and the sweep marks it expired", async () => {
    const deleteAfter = await suspendedWithTwoNotices(); signedIn = OWNER;
    vi.mocked(Date.now).mockReturnValue(deleteAfter - DAY); await request();
    vi.mocked(Date.now).mockReturnValue(deleteAfter - DAY + 7 * DAY - 1000); await reconcile();
    expect((await getHome()).desired_state).toBe("suspended");
    vi.mocked(Date.now).mockReturnValue(deleteAfter - DAY + 7 * DAY + 1000);
    await reconcile();
    expect((await getHome()).desired_state).toBe("deleting");
    await sweepBilling(baseEnv(), deps());
    expect(await env.DB.prepare("SELECT status FROM data_export_requests").first()).toEqual({ status: "expired" });
  });
  it("without a request the deletion is not delayed", async () => {
    const deleteAfter = await suspendedWithTwoNotices();
    vi.mocked(Date.now).mockReturnValue(deleteAfter + 1000); await reconcile();
    expect((await getHome()).desired_state).toBe("deleting");
  });
});

describe("EU online withdrawal function (Directive 2023/2673)", () => {
  const withdraw = (body: Record<string, unknown> = {}) => send("/v1/account/withdraw", { body: { confirm: true, name: "Ada Buyer", client: { ip: "198.51.100.5", userAgent: "ua-w" }, ...body } });
  async function euPaid(over: Record<string, unknown>) {
    await reserve();
    expect((await checkout("starter", { billingCountry: "DE", ...over })).status).toBe(200);
    await sessionCompleted({ customer_details: { address: { country: "DE" } } });
    await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp();
    signedIn = OWNER;
  }
  it("is offered to an EU buyer inside 14 days only, and not to a US buyer", async () => {
    await euPaid({ earlyStart: true });
    expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ withdrawal: { available: true, endsAt: aoeEnd(NOW, 14) } });
    vi.mocked(Date.now).mockReturnValue(aoeEnd(NOW, 14) + 1000);
    expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ withdrawal: { available: false } });
    expect(await (await withdraw()).json()).toEqual({ error: "withdrawal_not_available" });
  });
  it("Astra WP5-2 #3: a pre-0061 consent (no stored deadline) is offered withdrawal until the SAME AoE date the full refund uses (its own paid_at)", async () => {
    await euPaid({ earlyStart: true });
    const late = NOW + 5 * DAY; // the payment cleared days after the contract (an asynchronous method)
    await env.DB.prepare("UPDATE checkout_consents SET statutory_withdraw_until=NULL,guarantee_withdraw_until=NULL,refund7_until=NULL,paid_at=? WHERE home_id='home-1'").bind(late).run();
    // past completion + 336 h but inside AoE date(paid_at)+14: open, and the date shown is that one
    vi.mocked(Date.now).mockReturnValue(NOW + 14 * DAY + 1000);
    expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ withdrawal: { available: true, endsAt: aoeEnd(late, 14) } });
    vi.mocked(Date.now).mockReturnValue(aoeEnd(late, 14) + 1000);
    expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ withdrawal: { available: false } });
    expect(await (await withdraw()).json()).toEqual({ error: "withdrawal_not_available" });
  });
  it("US buyer has no withdrawal function", async () => {
    await paidUs(); signedIn = OWNER;
    expect(await (await withdraw()).json()).toEqual({ error: "withdrawal_not_available" });
  });
  it("needs the confirm flag, a signed-in customer, and works once", async () => {
    await euPaid({ earlyStart: true });
    expect((await withdraw({ confirm: false })).status).toBe(400);
    signedIn = null; expect((await withdraw()).status).toBe(401);
    signedIn = OWNER;
    expect((await withdraw()).status).toBe(201);
    expect(await (await withdraw()).json()).toEqual({ error: "already_withdrawn" });
  });
  it("within 14 days of the server's start everything paid comes back; the acknowledgement carries date and time; it is logged", async () => {
    await euPaid({ earlyStart: true });
    vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY);
    const res = await withdraw();
    expect(await res.json()).toMatchObject({ withdrawn: true, basis: "eu_uk_full_refund", refundCents: 4900, daysSupplied: 3, deductedCents: 0, status: "completed" });
    const call = stripeCalls.find((c) => c.method === "POST" && c.path === "/v1/refunds")!;
    expect(call.form.get("amount")).toBe("4900"); expect(call.headers.get("idempotency-key")).toMatch(/^refundop:withdrawal:withdrawal-/);
    expect(stripeCalls.some((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_test1")).toBe(true);
    const ack = notices.find((n) => n.kind === "withdrawal_ack")!.data as { emailText: string };
    expect(ack.emailText).toContain(`Received: ${new Date(NOW + 3 * DAY).toISOString().replace("T", " ").slice(0, 19)} UTC`);
    expect(ack.emailText).toContain("Name given: Ada Buyer");
    expect(await env.DB.prepare("SELECT confirmed_at,name,ip,user_agent,status,basis FROM withdrawals").first())
      .toEqual({ confirmed_at: NOW + 3 * DAY, name: "Ada Buyer", ip: "198.51.100.5", user_agent: "ua-w", status: "completed", basis: "eu_uk_full_refund" });
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "canceled" });
    expect(fluxLog.some((f) => f.hook === "stop")).toBe(true);
  });
  it("after the 7-day offer but within 14 days of the start, nothing is deducted for the days supplied (Decision A)", async () => {
    await euPaid({ earlyStart: true });
    vi.mocked(Date.now).mockReturnValue(NOW + 10 * DAY);
    expect(await (await withdraw()).json()).toMatchObject({ basis: "eu_uk_full_refund", daysSupplied: 10, deductedCents: 0, refundCents: 4900 });
    expect(stripeCalls.find((c) => c.method === "POST" && c.path === "/v1/refunds")!.form.get("amount")).toBe("4900");
  });
  it("records the acknowledgement with the withdrawal: a busy home at send time loses nothing; the sweep sends it, with the amount (Astra MAKERKIT2 #3)", async () => {
    await euPaid({ earlyStart: true });
    vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY);
    // Astra's reproduction: another operation holds the home's lease when notify() runs, so it fails before anything is recorded.
    const busy: BillingNotifier = { async notify(e, n, lease) { if (n.kind === "withdrawal_ack") throw new HomeBusy(); return notifier.notify(e, n, lease); } };
    const res = await send("/v1/account/withdraw", { body: { confirm: true, name: "Ada Buyer", client: { ip: "198.51.100.5", userAgent: "ua-w" } } }, { ...deps(), notifier: busy });
    expect(res.status).toBe(201);
    expect(notices.filter((n) => n.kind === "withdrawal_ack")).toHaveLength(0);
    const row = await env.DB.prepare("SELECT payload,sent_at FROM billing_notices WHERE kind='withdrawal_ack'").first<{ payload: string; sent_at: number | null }>();
    expect(row?.sent_at).toBeNull();
    // Recorded with the withdrawal, then completed with the decided refund before the lease was released.
    expect((JSON.parse(row!.payload) as { emailText: string }).emailText).toMatch(/We refund \S+ to the way you paid/);
    // A repeat press is "already withdrawn"; the sweep delivers the acknowledgement.
    expect(await (await withdraw()).json()).toEqual({ error: "already_withdrawn" });
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    const sent = notices.filter((n) => n.kind === "withdrawal_ack");
    expect(sent).toHaveLength(1);
    expect((sent[0].data as { emailText: string }).emailText).toContain("Name given: Ada Buyer");
  });
  it("a mail failure does not undo the withdrawal; a refund failure is flagged for ops", async () => {
    await euPaid({ earlyStart: true });
    notifierFails = true;
    expect((await withdraw()).status).toBe(201);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawals")).toBe(1);
  });
});

describe("Astra review of ca3f90bbd: one test per finding", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  const withdrawNow = (body: Record<string, unknown> = {}) => send("/v1/account/withdraw", { body: { confirm: true, client: { ip: "198.51.100.5", userAgent: "ua-w" }, ...body } });
  const refundRoute = (body: Record<string, unknown>) => send("/v1/admin/refund-first-month", { body, headers: admin });
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds").map((c) => Number(c.form.get("amount")));
  const sweep = () => sweepBilling(baseEnv(), deps()).catch(() => undefined);
  async function euEarlyPaid() {
    await reserve(); expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    await sessionCompleted({ customer_details: { address: { country: "DE" } } });
    await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp(); signedIn = OWNER;
  }

  it("#1 one open checkout per home: a repeat reuses the session, a changed choice expires it first, a second completion is cancelled and refunded", async () => {
    creditNotesOn = true; // a direct duplicate is refunded through a credit note (Astra DROPDOWN-DIRECT-2 (2))
    await reserve();
    const a = await (await checkout("starter")).json() as { sessionId: string; url: string; consentId: string };
    const creates = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions").length;
    expect(await (await checkout("starter")).json()).toMatchObject({ sessionId: a.sessionId, url: a.url, reused: true });
    expect(creates()).toBe(1);
    // A submission while another is being created is refused, not doubled.
    await env.DB.prepare("UPDATE open_checkouts SET state='creating'").run();
    expect(await (await checkout("pro")).json()).toEqual({ error: "checkout_in_progress" });
    await env.DB.prepare("UPDATE open_checkouts SET state='open'").run();
    // A changed choice: the open session is expired before a new one exists; only one is ever open.
    const c = await (await checkout("pro")).json() as { sessionId: string };
    expect(c.sessionId).not.toBe(a.sessionId);
    expect(stripeCalls.some((x) => x.path === `/v1/checkout/sessions/${a.sessionId}/expire`)).toBe(true);
    expect(sessions.filter((x) => x.status === "open").map((x) => x.id)).toEqual([c.sessionId]);
    expect(creates()).toBe(2);
    expect((await sessionCompleted({ id: c.sessionId, amount_total: 9900, metadata: { home_id: "home-1", plan: "pro", consent_id: await latestConsentId("home-1") } })).status).toBe(200);
    // The superseded session completes anyway (it raced the expiry): never a second subscription. Cancelled, refunded in full, ops told.
    expect((await sessionCompleted({ id: a.sessionId, subscription: "sub_dup", invoice: "in_dup", metadata: { home_id: "home-1", plan: "starter", consent_id: a.consentId } })).status).toBe(200);
    expect(await env.DB.prepare("SELECT subscription_id AS s, plan FROM billing_subscriptions").first()).toEqual({ s: "sub_test1", plan: "pro" });
    expect(stripeCalls.some((x) => x.method === "DELETE" && x.path === "/v1/subscriptions/sub_dup")).toBe(true);
    expect(refundPosts()).toEqual([]);
    expect(stripeCalls.filter((x) => x.method === "POST" && x.path === "/v1/credit_notes").map((x) => Number(x.form.get("refund_amount")))).toEqual([4900]);
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='checkout.duplicate_subscription'").first()).toEqual({ kind: "checkout.duplicate_subscription" });
    expect((await hook(stripeEvent("invoice.paid", invoice({ id: "in_dup", subscription: "sub_dup" })))).status).toBe(200);
    expect(fluxLog.filter((f) => f.hook === "grant")).toHaveLength(0);
    expect(await (await checkout("pro")).json()).toEqual({ error: "already_subscribed" });
  });

  it("#2 nothing is granted or started before the confirmation is durably sent, whatever order Stripe delivers in", async () => {
    await reserve(); await checkout("starter");
    expect((await hook(stripeEvent("invoice.paid", invoice()))).status).toBe(500); // before checkout.session.completed
    notifierFails = true;
    expect((await sessionCompleted()).status).toBe(500); // the confirmation could not be handed off
    at(NOW + 10 * 60_000); await sweep();
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox")).toBe(0);
    expect(fluxLog.filter((f) => f.hook === "grant")).toEqual([]);
    expect(await env.DB.prepare("SELECT error FROM stripe_events WHERE type='invoice.paid'").first()).toEqual({ error: "confirmation_pending" });
    notifierFails = false;
    for (const m of [30, 60, 120]) { at(NOW + m * 60_000); await sweep(); }
    expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(1);
    expect(fluxLog.filter((f) => f.hook === "grant")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL")).toBe(0);
  });

  it("#3 a charged customer who withdraws before invoice.paid is never told 'nothing charged': the late invoice completes the refund", async () => {
    await reserve(); await checkout("starter", { billingCountry: "DE", earlyStart: true });
    await sessionCompleted({ customer_details: { address: { country: "DE" } } }); signedIn = OWNER;
    at(NOW + DAY);
    expect(await (await withdrawNow()).json()).toMatchObject({ withdrawn: true, status: "processing", refundCents: null });
    expect(stripeCalls.some((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_test1")).toBe(true); // billing stopped at once
    expect(refundPosts()).toEqual([]);
    expect((notices.find((n) => n.kind === "withdrawal_ack")!.data as { emailText: string }).emailText).not.toContain("not been charged");
    expect((await hook(stripeEvent("invoice.paid", invoice()))).status).toBe(200);
    expect(refundPosts()).toEqual([4900]);
    // The home never became ready, so nothing was supplied: the full payment comes back.
    expect(await env.DB.prepare("SELECT status,refund_cents,days_supplied AS d FROM withdrawals").first()).toEqual({ status: "completed", refund_cents: 4900, d: 0 });
    expect(fluxLog.filter((f) => f.hook === "grant")).toHaveLength(0); // the late invoice starts nothing
  });
  it("#3 the payment state is settled from Stripe's invoice list when the webhook is late", async () => {
    await reserve(); await checkout("starter", { billingCountry: "DE", earlyStart: true });
    await sessionCompleted({ customer_details: { address: { country: "DE" } } }); await reconcile(); await serviceUp(); signedIn = OWNER;
    paidInvoices = [{ id: "in_1", amount_paid: 4900, tax: 0, payment_intent: "pi_1", created: NOW / 1000,
      lines: { data: [{ period: { start: NOW / 1000, end: NOW / 1000 + 30 * 86400 } }] } }];
    at(NOW + 10 * DAY);
    expect(await (await withdrawNow()).json()).toMatchObject({ status: "completed", basis: "eu_uk_full_refund", refundCents: 4900, daysSupplied: 10 });
  });

  it("#4 a failed refund keeps its checkpoints: billing stops at once, the sweep retries, ops is alerted, then it completes", async () => {
    await euEarlyPaid(); at(NOW + 2 * DAY);
    refundFails = 3;
    expect(await (await withdrawNow()).json()).toMatchObject({ status: "processing" });
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "canceled" });
    expect(await (await withdrawNow()).json()).toEqual({ error: "already_withdrawn" }); // recorded once; the operation carries on
    at(NOW + 2 * DAY + 10 * 60_000); await sweep();
    at(NOW + 2 * DAY + 30 * 60_000); await sweep();
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='refund.stuck' AND resolved_at IS NULL").first()).toEqual({ kind: "refund.stuck" });
    at(NOW + 3 * DAY); await sweep();
    expect(await env.DB.prepare("SELECT status,refund_cents FROM withdrawals").first()).toEqual({ status: "completed", refund_cents: 4900 });
    expect(refundsMade).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund.stuck' AND resolved_at IS NULL")).toBe(0);
  });
  it("#4 first-month route: a failure answers 202 and keeps the claim; an answer lost at Stripe is settled by op id, never refunded twice", async () => {
    await paidUs();
    refundLost = 1;
    expect((await refundRoute({ homeId: "home-1" })).status).toBe(202);
    expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(1);
    // Asked again while it is pending: the same request resumes (ASTRA-REFUND2 #5), settles the lost answer by op id, never a refusal.
    expect(await (await refundRoute({ homeId: "home-1" })).json()).toMatchObject({ refunded: true, refundId: "re_1", amountCents: 4900 });
    expect(notices.some((n) => n.kind === "refund_declined")).toBe(false);
    at(NOW + 10 * 60_000); await sweep();
    expect(refundsMade).toHaveLength(1);
    expect(refundPosts()).toEqual([4900]);
    expect(await env.DB.prepare("SELECT stripe_refund_id AS r FROM first_month_refunds").first()).toEqual({ r: "re_1" });
    expect(await env.DB.prepare("SELECT done_at IS NOT NULL AS d FROM refund_ops").first()).toEqual({ d: 1 });
  });

  it("#5 both refund routes share one ledger: an EU/UK full refund asked by email, then a withdrawal refunds only what is still owed (nothing)", async () => {
    await euEarlyPaid(); usedMicrocents = 40_000_000;
    at(NOW + DAY);
    // Within 14 days of the start an EU/UK request is the full refund, whatever credit was used (no credit read at all).
    const usedReadsBefore = fluxLog.filter((f) => f.hook === "used").length;
    expect(await (await refundRoute({ homeId: "home-1" })).json()).toMatchObject({ refunded: true, amountCents: 4900 });
    expect(fluxLog.filter((f) => f.hook === "used").length).toBe(usedReadsBefore);
    expect(refundPosts()).toEqual([4900]);
    at(NOW + 7 * DAY);
    expect(await (await withdrawNow()).json()).toMatchObject({ basis: "eu_uk_full_refund", refundCents: 0 });
    expect(refundPosts()).toEqual([4900]);
  });
  it("#5 the EU/UK full refund is not the 7-day offer: it never uses the one-per-customer slot, and a second ask pays nothing more", async () => {
    await euEarlyPaid(); at(NOW + 3 * DAY);
    expect(await (await withdrawNow()).json()).toMatchObject({ basis: "eu_uk_full_refund", refundCents: 4900 });
    expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(0);
    expect(await (await refundRoute({ homeId: "home-1" })).json()).toMatchObject({ error: "already_refunded" });
    expect(refundPosts()).toEqual([4900]);
  });

  it("#7 withdrawal deductions count from when the service was actually supplied (a day after consent): 9 days, $34.30", async () => {
    await reserve(); expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    const d1 = (NOW + DAY) / 1000; at(NOW + DAY);
    expect((await hook(stripeEvent("checkout.session.completed", await boundSession({ object: "checkout.session", id: "cs_test_1", mode: "subscription", payment_status: "paid", consent: { terms_of_service: "accepted" },
      customer: "cus_test1", subscription: "sub_test1", invoice: "in_1", client_reference_id: "home-1", amount_total: 4900, total_details: { amount_tax: 0 },
      customer_details: { address: { country: "DE" } }, metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1") } }, {}, retrievable), d1))).status).toBe(200);
    expect((await hook(stripeEvent("invoice.paid", invoice({ lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: d1, end: d1 + 30 * 86400 } }] } }), d1))).status).toBe(200);
    await reconcile(); await serviceUp(); // the home is ready a day after consent
    signedIn = OWNER;
    // One withdrawal clock: 14 days from the completed checkout (the contract), as the confirmation says.
    expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ withdrawal: { available: true, endsAt: aoeEnd(NOW + DAY, 14) } });
    at(NOW + 10 * DAY);
    expect(await (await withdrawNow()).json()).toMatchObject({ basis: "eu_uk_full_refund", daysSupplied: 9, deductedCents: 0, refundCents: 4900 });
    expect(await env.DB.prepare("SELECT service_supplied_at AS s FROM withdrawals").first()).toEqual({ s: NOW + DAY });
  });

  it("#8 export: one non-extendable pause per deletion cycle (a later request is still answered), refused once deletion is committed, and the deletion batch re-checks", async () => {
    await paidUs();
    await hook(stripeEvent("invoice.payment_failed", invoice({ id: "in_2", billing_reason: "subscription_cycle" }), NOW / 1000 + 60)); await reconcile();
    at(NOW + 3 * DAY + 1000); await reconcile();
    const s = await getHome(); expect(s.desired_state).toBe("suspended");
    await sweep(); at(s.delete_after! - 3 * DAY); await sweep();
    expect((await getHome()).suspension_notices).toBe(2);
    signedIn = OWNER;
    const ask = () => send("/v1/account/export-request", { body: {} });
    at(s.delete_after! - DAY);
    const first = await (await ask()).json() as { requestId: string; pausesDeletionUntil: number };
    expect(first.pausesDeletionUntil).toBe(s.delete_after! - DAY + 7 * DAY);
    at(s.delete_after! + DAY);
    expect(await (await ask()).json()).toMatchObject({ requestId: first.requestId, pausesDeletionUntil: first.pausesDeletionUntil, existing: true });
    expect((await send("/v1/admin/export-delivered", { body: { requestId: first.requestId }, headers: admin })).status).toBe(200);
    // A second request in the same deletion period is accepted, recorded and answered, but does not pause the deletion again.
    const again = await ask();
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({ state: "recorded_without_pause", pausesDeletionUntil: null });
    expect(await env.DB.prepare("SELECT status,pause_until AS p FROM data_export_requests WHERE id<>?").bind(first.requestId).first()).toEqual({ status: "open", p: null });
    expect((notices.filter((n) => n.kind === "export_requested").at(-1)!.data as { emailText: string }).emailText).toContain(EXPORT_REPEAT_WORDING);
    expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ exportRequest: { status: "open", pausesDeletion: false } });
    await reconcile();
    expect((await getHome()).desired_state).toBe("deleting");
    expect(await env.DB.prepare("SELECT status FROM data_export_requests WHERE id<>?").bind(first.requestId).first()).toEqual({ status: "open" }); // still owed an answer
    const late = await ask();
    expect(late.status).toBe(409); expect(await late.json()).toEqual({ error: "home_deleting" });
    // The lifecycle's own guard: inside the batch that moves a home to "deleting", an open request makes the write fail.
    await env.DB.prepare("INSERT INTO data_export_requests (id,home_id,user_id,requested_at,status,pause_until,cycle) VALUES ('x1','home-1',?,?,'open',?,1)")
      .bind(OWNER, Date.now(), Date.now() + DAY).run();
    await expect(env.DB.prepare(`INSERT INTO cloud_write_guards VALUES ('g1',${NO_EXPORT_HOLD_SQL})`).bind("home-1", Date.now()).run()).rejects.toThrow();
  });

  it("#9 / Astra JOURNEY-A-10 #3: with Flux off (the stub) a withdrawal is refunded in full, COMPLETED and confirmed; the Flux Stop stays journaled with ONE alert", async () => {
    await euEarlyPaid(); at(NOW + 2 * DAY);
    const res = await send("/v1/account/withdraw", { body: { confirm: true } }, { ...deps(), flux: stubFluxHooks });
    expect(await res.json()).toMatchObject({ withdrawn: true, refundCents: 4900 });
    expect(refundPosts()).toEqual([4900]);
    // The probe left done_at and notified_at NULL (the stub threw before the notice). Now the cash refund completes and its email goes out.
    expect(await env.DB.prepare("SELECT done_at IS NOT NULL AS done,notified_at IS NOT NULL AS told,credits_revoked_at AS revoked,last_error AS err FROM refund_ops").first())
      .toEqual({ done: 1, told: 1, revoked: null, err: null }); // the Flux Stop is still pending in the journal
    const refunded = notices.filter((n) => n.kind === "refunded");
    expect(refunded).toHaveLength(1);
    expect(JSON.stringify(refunded[0].data)).not.toMatch(/Flux/); // no claim of Flux execution
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.stop_pending' AND resolved_at IS NULL").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund.stuck'").first()).toEqual({ n: 0 });
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
  });

  it("#10 the total including tax is priced by Stripe Tax before consent, bound to the consent and in the confirmation", async () => {
    await reserve(); taxFails = false;
    const q = await quoteFor("starter", "DE", "10115", 20);
    expect(q).toMatchObject({ source: "stripe_tax", price_cents: 4900, tax_cents: 931, total_cents: 5831, topup_amount_cents: 2000, topup_tax_cents: 380,
      topup_total_cents: 2380, postal_code: "10115" });
    const calc = stripeCalls.find((c) => c.path === "/v1/tax/calculations")!;
    expect(calc.form.get("customer_details[address][country]")).toBe("DE"); expect(calc.form.get("customer_details[address][postal_code]")).toBe("10115");
    expect((await quoteFor("starter", "DE", "10115", 20)).id).toBe(q.id); // reused while fresh (each Stripe Tax call is billed)
    expect(stripeCalls.filter((c) => c.path === "/v1/tax/calculations")).toHaveLength(1);
    const d = buildDisclosure("starter", NOW, q);
    expect(d.variants.immediate.renewalText).toContain("Today's total is $58.31 in USD."); expect(d.variants.immediate.renewalText).toContain("Total including tax: $58.31 a month ($49.00 plus $9.31 tax).");
    const topup = { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 };
    // r13: the route no longer binds a top-up to a quote (its wording is the server's, "plus tax where it applies"); a quote is not checked
    // (the legacy-consent fields below are written by the test helper, as for any consent made before r13)
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true, topup }, q)).status).toBe(200);
    const row = (await env.DB.prepare("SELECT * FROM checkout_consents ORDER BY created_at DESC, rowid DESC LIMIT 1").first<Record<string, unknown>>())!;
    expect(row).toMatchObject({ tax_source: "stripe_tax", quote_id: q.id, postal_code: "10115", quoted_tax_cents: 931, quoted_total_cents: 5831, quoted_topup_total_cents: 2380 });
    expect(JSON.parse(row.wording as string).topupCharge).toContain("charge my payment method $20 plus tax where it applies for $20 of Flux credits");
    expect(JSON.parse(row.disclosure as string)).toMatchObject({ tax: { quoteId: q.id, totalCents: 5831 } });
    await sessionCompleted({ amount_total: 5831, total_details: { amount_tax: 931 }, customer_details: { address: { country: "DE" } } });
    const t = (notices.find((n) => n.kind === "confirmation")!.data as { emailText: string }).emailText;
    expect(t).toContain("Total including tax: $58.31 a month ($49.00 plus $9.31 tax), as shown before you agreed.");
    expect(t).toContain("Charged at checkout: $58.31 (tax $9.31).");
    expect(t).toContain("Amount: $20.00 ($23.80 including tax).");
  });

  it("#11 complete copies (tables, dates), and the confirmation is built only from the archived versions accepted", async () => {
    expect(LEGAL_DOCS.termsOfService.text).toContain("Level | What it means");
    expect(LEGAL_DOCS.termsOfService.text).toMatch(/Effective \w+ \d{1,2}, \d{4} · Last updated/);
    expect(LEGAL_DOCS.cloudTerms.text).toMatch(/^# Murage Cloud terms/);
    await reserve(); await checkout("starter");
    // A revision deployed after the customer accepted: the archive keeps what they saw, and that is what is sent.
    const old = "# Murage Cloud terms\n\nOLD ACCEPTED TEXT, the version before the revision.";
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(old)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO legal_doc_archive (version_id,title,sha256,text,archived_at) VALUES ('cloud-terms-0ld0ld0ld0ld','Murage Cloud terms',?,?,?)").bind(sha, old, NOW),
      env.DB.prepare("UPDATE checkout_consents SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'"),
    ]);
    expect((await sessionCompleted()).status).toBe(200);
    const t = (notices.find((n) => n.kind === "confirmation")!.data as { emailText: string }).emailText;
    expect(t).toContain("OLD ACCEPTED TEXT");
    expect(t).toContain("(version cloud-terms-0ld0ld0ld0ld)");
    expect(t).not.toContain(LEGAL_DOCS.cloudTerms.text);
    expect(t).toContain(LEGAL_DOCS.termsOfService.text);
  });
  it("#11 an altered archive copy fails closed: no confirmation, no service", async () => {
    await reserve(); await checkout("starter");
    await env.DB.prepare("UPDATE legal_doc_archive SET text=text||' tampered' WHERE version_id=?").bind(LEGAL_DOCS.cloudTerms.versionId).run();
    expect((await sessionCompleted()).status).toBe(500);
    expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox")).toBe(0);
  });

  it("#12 consent binds to the document versions shown; a changed version gets a 30-day notice and a fresh, logged acceptance", async () => {
    await reserve();
    const current = { cloudTerms: LEGAL_DOCS.cloudTerms.versionId, termsOfService: LEGAL_DOCS.termsOfService.versionId, privacyPolicy: LEGAL_DOCS.privacyPolicy.versionId };
    const stale = { ...current, cloudTerms: "cloud-terms-000000000000" };
    expect(await (await checkout("starter", { documentVersions: stale })).json()).toEqual({ error: "disclosure_stale" });
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents")).toBe(0);
    expect((await checkout("starter")).status).toBe(200);
    await sessionCompleted(); await hook(stripeEvent("invoice.paid", invoice()));
    expect(await env.DB.prepare("SELECT source,cloud_terms_version AS v FROM terms_acceptances").first()).toEqual({ source: "checkout", v: current.cloudTerms });
    signedIn = OWNER;
    expect(await (await get("/v1/account/terms")).json()).toMatchObject({ reacceptRequired: false });
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'").run(); // the terms changed after this acceptance
    await sweep(); await sweep();
    const sent = notices.filter((n) => n.kind === "terms_change");
    expect(sent).toHaveLength(1);
    expect((sent[0].data as { emailText: string }).emailText).toContain(LEGAL_DOCS.cloudTerms.text);
    expect((sent[0].data as { emailText: string }).emailText).toContain("apply to your plan only after you accept them");
    expect(await (await get("/v1/account/terms")).json()).toMatchObject({ reacceptRequired: true,
      changed: [{ title: "Murage Cloud terms", versionId: current.cloudTerms }], effectiveAt: NOW + 30 * DAY });
    expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ terms: { reacceptRequired: true } });
    const accept = (documentVersions: unknown) => send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions, client: { ip: "198.51.100.8", userAgent: "ua-r" } } });
    expect((await accept(stale)).status).toBe(409);
    expect((await accept(current)).status).toBe(200);
    expect(await (await get("/v1/account/terms")).json()).toMatchObject({ reacceptRequired: false });
    const row = (await env.DB.prepare("SELECT wording,client_meta FROM terms_acceptances WHERE source='reaccept'").first<{ wording: string; client_meta: string }>())!;
    expect(row.wording).toBe(WORDING.reaccept);
    expect(JSON.parse(row.client_meta)).toMatchObject({ claimed: { ip: "198.51.100.8", userAgent: "ua-r" }, observed: { ip: "203.0.113.10" } });
    // The re-acceptance writer stores the generated id, which the one-per-person limit matches once REFUND_LIMIT_V2_LIVE=1 (and only then);
    // the checkout row now carries an older id, so the re-acceptance row is the only one that can match.
    const later = NOW + 365 * DAY;
    expect(await refundLimitAccepted({ ...env, REFUND_LIMIT_TERMS_VERSIONS: "", REFUND_LIMIT_V2_LIVE: "1" } as Env, OWNER, later, null)).toBe(true);
    expect(await refundLimitAccepted({ ...env, REFUND_LIMIT_TERMS_VERSIONS: "" } as Env, OWNER, later, null)).toBe(false);
    expect(await refundLimitAccepted({ ...env, REFUND_LIMIT_TERMS_VERSIONS: "", REFUND_LIMIT_V2_LIVE: "0" } as Env, OWNER, later, null)).toBe(false);
  });

  async function agedTermsCustomer() {
    await reserve(); expect((await checkout("starter")).status).toBe(200);
    await sessionCompleted(); await hook(stripeEvent("invoice.paid", invoice())); signedIn = OWNER;
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'").run(); // the terms changed after this acceptance
    await sweep(); // the 30-day notice (the first reminder)
    expect(notices.filter((n) => n.kind === "terms_change")).toHaveLength(1);
    // A renewal before the effective date is not an acceptance.
    const d29 = (NOW + 29 * DAY) / 1000; at(NOW + 29 * DAY);
    expect((await hook(stripeEvent("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: d29, end: d29 + 30 * 86400 } }] } }), d29))).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM terms_acceptances")).toBe(1);
    expect(await (await get("/v1/account/terms")).json()).toMatchObject({ reacceptRequired: true, planEndsAt: null });
    // Effective date, still not accepted: the accepted terms run to the end of the paid period, then the plan does not renew.
    at(NOW + 30 * DAY); await sweep();
    const call = stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_test1").at(-1)!;
    expect(call.form.get("cancel_at_period_end")).toBe("true");
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c FROM billing_subscriptions").first()).toEqual({ c: 1 });
    expect(await (await get("/v1/account/terms")).json()).toMatchObject({ reacceptRequired: true, planEndsAt: NOW + 59 * DAY });
  }
  it("#12 never re-accepting: old terms to the end of the paid period, then no renewal; reminders at notice, 7 days before and at the end", async () => {
    await agedTermsCustomer();
    expect((notices.filter((n) => n.kind === "terms_change")[0].data as { emailText: string }).emailText).toContain(TERMS_NONACCEPTANCE_WORDING);
    at(NOW + 51 * DAY); await sweep();
    expect(notices.filter((n) => n.kind === "terms_change")).toHaveLength(1);
    at(NOW + 52 * DAY); await sweep(); await sweep();
    const seven = notices.filter((n) => n.kind === "terms_change");
    expect(seven).toHaveLength(2);
    expect((seven[1].data as { emailText: string }).emailText).toContain(`If you do not accept the updated terms by then, your plan does not renew and ends on that day.`);
    at(NOW + 59 * DAY); await sweep(); await sweep();
    const all = notices.filter((n) => n.kind === "terms_change");
    expect(all).toHaveLength(3);
    expect(all[2].id).toMatch(/:end$/);
    expect(stripeCalls.some((c) => c.form.get("cancel_at_period_end") === "false")).toBe(false);
  });
  it("#12 accepting before the paid period ends lifts the non-renewal; no further reminders", async () => {
    await agedTermsCustomer();
    at(NOW + 40 * DAY);
    const current = { cloudTerms: LEGAL_DOCS.cloudTerms.versionId, termsOfService: LEGAL_DOCS.termsOfService.versionId, privacyPolicy: LEGAL_DOCS.privacyPolicy.versionId };
    expect(await (await send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions: current } })).json()).toMatchObject({ accepted: true, planContinues: true });
    expect(stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_test1").at(-1)!.form.get("cancel_at_period_end")).toBe("false");
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c FROM billing_subscriptions").first()).toEqual({ c: 0 });
    at(NOW + 52 * DAY); await sweep(); at(NOW + 59 * DAY); await sweep();
    expect(notices.filter((n) => n.kind === "terms_change")).toHaveLength(1);
  });

  it("#13 a required confirmation is never abandoned (past 8 attempts and 7 days, with an ops alert), and an old unsent notice still goes out", async () => {
    await reserve(); await checkout("starter");
    notifierFails = true;
    expect((await sessionCompleted()).status).toBe(500);
    await env.DB.prepare("UPDATE stripe_events SET attempts=20,received_at=?,next_attempt_at=NULL").bind(NOW - 30 * DAY).run();
    at(NOW + DAY); await sweep();
    // A customer is waiting: its own per-event stuck alert (lane C design 3), never the fleet's billing.event_stuck (A7).
    expect(await env.DB.prepare("SELECT kind,resolved_at FROM cloud_alerts WHERE kind='billing.webhook_stuck'").first()).toEqual({ kind: "billing.webhook_stuck", resolved_at: null });
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='billing.event_stuck'").first()).toBeNull();
    notifierFails = false;
    at(NOW + DAY + 7 * 3_600_000); await sweep();
    expect(await env.DB.prepare("SELECT resolved_at FROM cloud_alerts WHERE kind='billing.webhook_stuck'").first()).toEqual({ resolved_at: NOW + DAY + 7 * 3_600_000 });
    expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox")).toBe(1);
    const mails: { subject: string }[] = [];
    const mailEnv = baseEnv({ EMAIL: { async send(m: { subject: string }) { mails.push(m); } } } as unknown as Partial<Env>);
    await env.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at) VALUES ('payment_failed:home-1:old','home-1','payment_failed','{}',?)").bind(NOW - 30 * DAY).run();
    await sweepBilling(mailEnv, { stripeFetch, flux }).catch(() => undefined);
    expect(mails.map((m) => m.subject)).toContain("Murage Cloud: your payment failed");
    expect(await env.DB.prepare("SELECT sent_at IS NOT NULL AS s FROM billing_notices WHERE id='payment_failed:home-1:old'").first()).toEqual({ s: 1 });
  });

  it("#14 yearly reminders reach every due customer: 201 due plans, one reminder each over two sweeps", async () => {
    const started = NOW - 340 * DAY;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 201; i++) {
      stmts.push(env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
        VALUES (?,?,?,'ready','ready',?,'k',?,?)`).bind(`rem-${i}`, `inst-rem-${i}`, OWNER, IMAGE, NOW, NOW));
      stmts.push(env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at,service_start_at)
        VALUES (?,?,?,'starter','active',?,?,?)`).bind(`rem-${i}`, `cus_rem${i}`, `sub_rem${i}`, NOW, NOW, started));
    }
    await env.DB.batch(stmts);
    await sweep(); await sweep(); await sweep();
    const sent = notices.filter((n) => n.kind === "renewal_reminder");
    expect(sent).toHaveLength(201);
    expect(new Set(sent.map((n) => n.homeId)).size).toBe(201);
  });

  it("#15 one notice id is sent once even when two senders race; a ledger refund and its charge.refunded webhook send one refund notice", async () => {
    await reserve();
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const mails: string[] = [];
    const mailEnv = baseEnv({ EMAIL: { async send(m: { subject: string }) { await gate; mails.push(m.subject); } } } as unknown as Partial<Env>);
    const n = { id: "payment_failed:home-1:race", homeId: "home-1", ownerId: OWNER, kind: "payment_failed" as const, data: {} };
    // Two senders that both believe they hold the lease (the claim, not the lease, is what stops the second here).
    const lease = (await acquireHomeLease(env, "home-1", "race"))!;
    const first = defaultNotifier.notify(mailEnv, n, lease);
    await new Promise((r) => setTimeout(r, 50));
    await expect(defaultNotifier.notify(mailEnv, n, lease)).rejects.toThrow("notice_in_flight");
    release(); await first;
    await defaultNotifier.notify(mailEnv, n, lease);
    expect(mails).toEqual(["Murage Cloud: your payment failed"]);
    await releaseHomeLease(env, lease);
    expect((await checkout("starter")).status).toBe(200); await sessionCompleted(); await hook(stripeEvent("invoice.paid", invoice())); await reconcile();
    expect((await refundRoute({ homeId: "home-1" })).status).toBe(200);
    expect((await hook(stripeEvent("charge.refunded", { object: "charge", id: "ch_1", customer: "cus_test1", invoice: "in_1", payment_intent: "pi_1", refunded: true,
      refunds: { data: [{ id: "re_1", metadata: { op_id: `firstmonth:${OWNER}` } }] } }))).status).toBe(200);
    expect(notices.filter((x) => x.kind === "refunded").map((x) => x.id)).toEqual([`refunded:home-1:firstmonth:${OWNER}`]);
  });

  it("#16 a raised or resolved abuse alert is a suspicion, not a closure: the 7-day refund stays available", async () => {
    await paidUs();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,resolved_at) VALUES ('a1','home-1','abuse.mining_suspected','high','{}',?,?)").bind(NOW, NOW + 1000),
      env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('a2','home-1','abuse.spam_suspected','warning','{}',?)").bind(NOW),
    ]);
    const dry = await (await refundRoute({ homeId: "home-1", dryRun: true })).json() as { quote: Record<string, unknown> };
    expect(dry.quote).toMatchObject({ eligible: true, reason: null, refundCents: 4900 });
  });

  it("#17 the top-up authorization is applied to Flux auto-recharge (B4) at checkout and on every change; the stub records it as not applied", async () => {
    await reserve(); await checkout("starter", { topup: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } });
    await sessionCompleted();
    expect(fluxLog.filter((f) => f.hook === "autorecharge").map((f) => f.args)).toEqual([{ homeId: "home-1", enabled: true, amountMicrocents: 20_000_000,
      thresholdMicrocents: 5_000_000, monthlyCapMicrocents: 100_000_000, revision: 1, consentId: await latestConsentId("home-1") }]);
    signedIn = OWNER;
    expect(await (await send("/v1/account/topup", { body: { enabled: false, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } })).json()).toMatchObject({ enabled: false, applied: true });
    expect(fluxLog.filter((f) => f.hook === "autorecharge").at(-1)!.args).toMatchObject({ enabled: false, revision: 2 });
    expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ topup: { enabled: false, applied: true } });
    const res = await send("/v1/account/topup", { body: { enabled: true, amountUsd: 25, thresholdUsd: 5, capUsd: 50 } }, { ...deps(), flux: stubFluxHooks });
    expect(await res.json()).toMatchObject({ enabled: true, applied: false });
    expect(await env.DB.prepare("SELECT apply_error FROM topup_settings").first()).toEqual({ apply_error: "flux_not_wired" });
    expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ topup: { applied: false, applyError: "flux_not_wired" } });
  });

  it("#18 the consent records claimed and observed IP and user agent, and says when the claimed metadata was unavailable", async () => {
    await reserve();
    const body = { homeId: "home-1", plan: "starter", consent: { ...consentFor("starter", NOW), client: undefined } };
    expect((await send("/v1/billing/checkout", { body, headers: { ...admin, "User-Agent": "portal-node/1" } })).status).toBe(200);
    const row = (await env.DB.prepare("SELECT ip,ip_seen,user_agent,user_agent_seen,client_meta FROM checkout_consents").first<Record<string, string | null>>())!;
    expect(row).toMatchObject({ ip: null, ip_seen: "203.0.113.10", user_agent: "portal-node/1", user_agent_seen: "portal-node/1" });
    expect(JSON.parse(row.client_meta!)).toEqual({ claimed: { ip: null, ipSource: "unavailable", userAgent: null }, observed: { ip: "203.0.113.10", userAgent: "portal-node/1" } });
  });
});

describe("Astra re-review of 0d3a289e0: one test per reproduction", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  const withdrawNow = () => send("/v1/account/withdraw", { body: { confirm: true } });
  const refundRoute = (body: Record<string, unknown>) => send("/v1/admin/refund-first-month", { body, headers: admin });
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const sweep = () => sweepBilling(baseEnv(), deps()).catch(() => undefined);
  async function euEarlyPaid(ready = true) {
    await reserve(); expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    await sessionCompleted({ customer_details: { address: { country: "DE" } } });
    await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); if (ready) await serviceUp(); signedIn = OWNER;
  }

  it("R2-1 cancelling a duplicate never touches the paying subscription (deleted, updated and failed-invoice events for it are ignored)", async () => {
    await paidUs();
    expect((await sessionCompleted({ id: "cs_dup", subscription: "sub_dup", invoice: "in_dup" })).status).toBe(200);
    expect(stripeCalls.some((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_dup")).toBe(true);
    const inbox = await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox");
    const subEvt = { object: "subscription", id: "sub_dup", customer: "cus_test1", status: "canceled", cancel_at_period_end: false,
      items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } };
    expect(await (await hook(stripeEvent("customer.subscription.deleted", subEvt, NOW / 1000 + 10))).json()).toMatchObject({ received: true });
    await hook(stripeEvent("customer.subscription.updated", { ...subEvt, status: "past_due", cancel_at_period_end: true }, NOW / 1000 + 11));
    await hook(stripeEvent("invoice.payment_failed", invoice({ id: "in_dup2", subscription: "sub_dup" }), NOW / 1000 + 12));
    expect(await env.DB.prepare("SELECT subscription_id AS s, status, cancel_at_period_end AS c FROM billing_subscriptions").first()).toEqual({ s: "sub_test1", status: "active", c: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox")).toBe(inbox);
    // (since Astra DROPDOWN-DIRECT-1 (2) the duplicate is tombstoned when it is refused, so its later events are ignored at the door)
    expect(await env.DB.prepare("SELECT error FROM stripe_events WHERE type='customer.subscription.deleted'").first()).toEqual({ error: "rejected_subscription" });
    await reconcile(); expect((await getHome()).desired_state).not.toBe("payment_problem");
  });

  it("R2-2 a refund is completed only when Stripe says it succeeded; a later failure reopens it, alerts, and a new submission follows", async () => {
    await euEarlyPaid(); at(NOW + 2 * DAY);
    refundStatus = "pending";
    expect(await (await withdrawNow()).json()).toMatchObject({ status: "processing" });
    const opId = (await env.DB.prepare("SELECT id FROM refund_ops").first<{ id: string }>())!.id;
    expect(await env.DB.prepare("SELECT refund_status AS s, refunded_at AS r, done_at AS d FROM refund_ops").first()).toEqual({ s: "pending", r: null, d: null });
    expect(await env.DB.prepare("SELECT status FROM withdrawals").first()).toEqual({ status: "processing" });
    refundsMade[0].status = "succeeded";
    expect((await hook(stripeEvent("refund.updated", { object: "refund", id: "re_1", status: "succeeded", metadata: { op_id: opId } }, (NOW + 2 * DAY) / 1000))).status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM withdrawals").first()).toEqual({ status: "completed" });
    // Stripe later reports the refund failed: the obligation is open again, ops is told, a new refund (new key) is made.
    refundStatus = "succeeded"; refundsMade[0].status = "failed";
    expect((await hook(stripeEvent("refund.failed", { object: "refund", id: "re_1", status: "failed", metadata: { op_id: opId } }, (NOW + 2 * DAY) / 1000 + 5))).status).toBe(200);
    expect(await env.DB.prepare("SELECT done_at AS d, refunded_at AS r FROM refund_ops").first()).toEqual({ d: null, r: null });
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='refund.failed'").first()).toEqual({ kind: "refund.failed" });
    expect(await env.DB.prepare("SELECT status FROM withdrawals").first()).toEqual({ status: "processing" });
    await sweep();
    expect(refundPosts().map((c) => c.headers.get("idempotency-key"))).toEqual([`refundop:${opId}:1`, `refundop:${opId}:2`]);
    expect(await env.DB.prepare("SELECT status FROM withdrawals").first()).toEqual({ status: "completed" });
  });

  it("R2-3 the refund intent is recorded before the Stripe call: after a crash that recorded nothing else, 48 hours later, no second refund", async () => {
    await paidUs();
    refundLost = 1; // Stripe made the refund; the answer never arrived
    expect((await refundRoute({ homeId: "home-1" })).status).toBe(202);
    expect(await env.DB.prepare("SELECT submission, submitted_at IS NOT NULL AS s FROM refund_ops").first()).toEqual({ submission: 1, s: 1 });
    // As if the failure itself was never recorded (worker died): no error counter, no refund id.
    await env.DB.prepare("UPDATE refund_ops SET attempts=0,last_error=NULL,next_attempt_at=NULL,lease_until=NULL").run();
    at(NOW + 48 * 3_600_000); listCalls = 0; await sweep();
    expect(listCalls).toBeGreaterThan(0);
    expect(refundsMade).toHaveLength(1);
    expect(refundPosts()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT done_at IS NOT NULL AS d, stripe_refund_id AS r FROM refund_ops").first()).toEqual({ d: 1, r: "re_1" });
  });

  it("R2-4 overlapping refund decisions on one payment serialize: a full refund asked twice at once never pays more than was paid", async () => {
    await euEarlyPaid(); usedMicrocents = 40_000_000;
    at(NOW + 7 * DAY);
    const [r1, r2] = await Promise.all([refundRoute({ homeId: "home-1" }), withdrawNow()]);
    // Each request reads its contract inside the home's lease (round 9), so one of two simultaneous requests may be told the home is busy and
    // records nothing; the portal asks again (retryWhileBusy), as here.
    if (r1.status === 409) await refundRoute({ homeId: "home-1" });
    if (r2.status === 409) await withdrawNow();
    at(NOW + 7 * DAY + 5 * 60_000); await sweep(); // anything left pending is finished by the sweep
    const total = refundPosts().reduce((n, c) => n + Number(c.form.get("amount")), 0);
    expect(total).toBe(4900);
    expect(await env.DB.prepare("SELECT decided_cents AS d FROM refund_invoice_ledger WHERE invoice_id='in_1'").first()).toEqual({ d: 4900 });
  });

  it("R2-6 a withdrawal deducts only for service actually supplied: a paid home that never became ready is refunded in full", async () => {
    await euEarlyPaid(false);
    expect((await getHome()).desired_state).not.toBe("ready");
    at(NOW + 10 * DAY);
    expect(await (await withdrawNow()).json()).toMatchObject({ basis: "eu_uk_full_refund", daysSupplied: 0, deductedCents: 0, refundCents: 4900 });
  });
  it("R2-6 supplied service stops counting when the home stops being served", async () => {
    await euEarlyPaid();
    await env.DB.prepare("UPDATE service_intervals SET ended_at=?").bind(NOW + 4 * DAY).run(); // suspended on day 4
    at(NOW + 10 * DAY);
    expect(await (await withdrawNow()).json()).toMatchObject({ basis: "eu_uk_full_refund", daysSupplied: 4, deductedCents: 0, refundCents: 4900 });
  });

  it("R2-7 a cancellation Stripe does not confirm is not treated as cancelled: the refund is still submitted once, the operation stays open and retries the end", async () => {
    await euEarlyPaid(); at(NOW + 2 * DAY);
    cancelStuck = true;
    expect(await (await withdrawNow()).json()).toMatchObject({ status: "processing" });
    // INTEGRATED-1 #6: refunds go before the end. The unconfirmed cancel never holds the money back; the end is its own checkpoint.
    expect(await env.DB.prepare("SELECT canceled_at AS c, done_at AS d, last_error AS e FROM refund_ops").first()).toEqual({ c: null, d: null, e: "subscription_not_canceled" });
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "active" });
    expect(refundPosts()).toHaveLength(1);
    cancelStuck = false; at(NOW + 2 * DAY + 10 * 60_000); await sweep();
    expect(await env.DB.prepare("SELECT status FROM withdrawals").first()).toEqual({ status: "completed" });
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "canceled" });
    expect(await env.DB.prepare("SELECT canceled_at IS NOT NULL AS c, done_at IS NOT NULL AS d FROM refund_ops").first()).toEqual({ c: 1, d: 1 });
    expect(refundPosts()).toHaveLength(1); // never a second refund
  });

  it("INTEGRATED-1 #6 a non-parked end failure (Stripe 500 on cancel) still refunds first, once; the end is retried and completes later", async () => {
    await euEarlyPaid(); at(NOW + 2 * DAY);
    cancelDown500 = true; // the probe: the cancel fails with a non-parked error while refund submission is available
    expect(await (await withdrawNow()).json()).toMatchObject({ status: "processing" });
    expect(refundPosts()).toHaveLength(1);
    const first = await env.DB.prepare("SELECT canceled_at AS c, done_at AS d, refunded_at IS NOT NULL AS r FROM refund_ops").first<{ c: number | null; d: number | null; r: number }>();
    expect(first).toEqual({ c: null, d: null, r: 1 });
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "active" });
    // A second pass with the cancel still failing: no second refund, the end is not forgotten, the operation stays open.
    at(NOW + 2 * DAY + 10 * 60_000); await sweep().catch(() => undefined);
    at(NOW + 2 * DAY + 3 * 3_600_000); await sweep().catch(() => undefined);
    expect(refundPosts()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT canceled_at AS c, done_at AS d FROM refund_ops").first()).toEqual({ c: null, d: null });
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "active" });
    // The cancel succeeds: the end completes and the operation is done, with no second refund.
    cancelDown500 = false; at(NOW + 3 * DAY); await sweep();
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "canceled" });
    expect(await env.DB.prepare("SELECT canceled_at IS NOT NULL AS c, done_at IS NOT NULL AS d FROM refund_ops").first()).toEqual({ c: 1, d: 1 });
    expect(await env.DB.prepare("SELECT status FROM withdrawals").first()).toEqual({ status: "completed" });
    expect(refundPosts()).toHaveLength(1);
  });

  it("R2-8 / R3-8 the notice comes first (enforced in code); an early acceptance does not erase it, and the new versions apply only from its effective date", async () => {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'").run();
    const current = { cloudTerms: LEGAL_DOCS.cloudTerms.versionId, termsOfService: LEGAL_DOCS.termsOfService.versionId, privacyPolicy: LEGAL_DOCS.privacyPolicy.versionId };
    const accept = () => send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions: current } });
    expect(await (await get("/v1/account/terms")).json()).toMatchObject({ reacceptRequired: false, noticePending: true });
    const early = await accept(); expect(early.status).toBe(409); expect(await early.json()).toEqual({ error: "notice_pending" });
    await sweep();
    const sent = notices.filter((n) => n.kind === "terms_change");
    expect(sent).toHaveLength(1);
    expect((sent[0].data as { emailText: string }).emailText).toContain(LEGAL_DOCS.cloudTerms.text);
    expect(await (await get("/v1/account/terms")).json()).toMatchObject({ reacceptRequired: true, noticePending: false });
    at(NOW + 5 * DAY);
    expect((await accept()).status).toBe(200);
    expect(await (await get("/v1/account/terms")).json()).toMatchObject({ reacceptRequired: false, effective: { cloudTerms: "cloud-terms-0ld0ld0ld0ld" } });
    at(NOW + 30 * DAY); await sweep();
    expect(await (await get("/v1/account/terms")).json()).toMatchObject({ effective: { cloudTerms: current.cloudTerms, from: NOW + 30 * DAY } });
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c FROM billing_subscriptions").first()).toEqual({ c: 0 });
    expect(notices.filter((n) => n.kind === "terms_change")).toHaveLength(1);
  });

  it("R2-9 B4 stays fail-closed: a live deployment on the stub raises flux.not_wired and refunds wait", async () => {
    await sweepBilling(baseEnv({ CLOUD_B3_MODE: "live" } as Partial<Env>), { ...deps(), flux: stubFluxHooks }).catch(() => undefined);
    expect(await env.DB.prepare("SELECT kind,severity FROM cloud_alerts WHERE kind='flux.not_wired'").first()).toEqual({ kind: "flux.not_wired", severity: "high" });
    await sweepBilling(baseEnv(), deps()).catch(() => undefined);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.not_wired'")).toBe(1);
  });

  it("R2-10 email is at-least-once with one stable X-Notice-ID per notice: a resend after a lost answer carries the same id", async () => {
    await reserve();
    const sent: { headers?: Record<string, string> }[] = [];
    let lose = true;
    const mailEnv = baseEnv({ EMAIL: { async send(m: { headers?: Record<string, string> }) { sent.push(m); if (lose) { lose = false; throw new Error("timeout"); } } } } as unknown as Partial<Env>);
    const n = { id: "payment_failed:home-1:lost", homeId: "home-1", ownerId: OWNER, kind: "payment_failed" as const, data: {} };
    const lease = (await acquireHomeLease(env, "home-1", "lost"))!;
    await expect(defaultNotifier.notify(mailEnv, n, lease)).rejects.toThrow("timeout");
    await defaultNotifier.notify(mailEnv, n, lease);
    expect(sent).toHaveLength(2);
    expect(sent[0].headers?.["X-Notice-ID"]).toMatch(/^[0-9a-f]{32}$/);
    expect(sent[1].headers?.["X-Notice-ID"]).toBe(sent[0].headers?.["X-Notice-ID"]);
    expect(Object.keys(sent[0].headers ?? {})).toEqual(["X-Notice-ID"]);
    await defaultNotifier.notify(mailEnv, n, lease); // sent: nothing more
    expect(sent).toHaveLength(2);
  });
});

describe("Astra review of 2939441b7: one test per reproduction", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  const withdrawNow = () => send("/v1/account/withdraw", { body: { confirm: true } });
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
  async function hookWith(event: unknown, d: BillingDependencies) {
    const raw = JSON.stringify(event);
    return send("/v1/billing/webhook", { raw, headers: { "stripe-signature": await signStripePayload(raw, WHSEC, Math.floor(Date.now() / 1000)) } }, d);
  }
  async function euEarlyPaid() {
    await reserve(); expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    await sessionCompleted({ customer_details: { address: { country: "DE" } } });
    await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp(); signedIn = OWNER;
  }

  it("R3-1 the REAL default notifier path passes Cloudflare's header rules: the confirmation goes out and service activates", async () => {
    const mails: { subject: string; headers?: Record<string, string> }[] = [];
    // Cloudflare's documented restriction: only custom X- headers; anything else (Message-ID among them) fails the whole send.
    envOver = { EMAIL: { async send(m: { subject: string; headers?: Record<string, string> }) {
      for (const k of Object.keys(m.headers ?? {})) if (!/^X-/i.test(k)) throw new Error("E_HEADER_NOT_ALLOWED");
      mails.push(m);
    } } } as unknown as Partial<Env>;
    const real: BillingDependencies = { ...deps(), notifier: undefined };
    await reserve(); expect((await checkout("starter")).status).toBe(200);
    const res = await hookWith(stripeEvent("checkout.session.completed", await boundSession({ object: "checkout.session", id: "cs_test_1", mode: "subscription", payment_status: "paid",
      consent: { terms_of_service: "accepted" }, customer: "cus_test1", subscription: "sub_test1", invoice: "in_1", client_reference_id: "home-1", amount_total: 4900,
      total_details: { amount_tax: 0 }, customer_details: { address: { country: "US" } },
      metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1") } }, {}, retrievable)), real);
    expect(res.status).toBe(200);
    expect(mails.map((m) => m.subject)).toContain("Murage Cloud: your order confirmation and contract copy");
    expect(await env.DB.prepare("SELECT sent_at IS NOT NULL AS s FROM billing_notices WHERE kind='confirmation'").first()).toEqual({ s: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox")).toBe(1);
  });

  it("R3-2 a late failure event for an older refund attempt never clears the current one: one obligation, one payout", async () => {
    await euEarlyPaid(); at(NOW + 2 * DAY);
    refundStatus = "pending";
    await withdrawNow();
    const opId = (await env.DB.prepare("SELECT id FROM refund_ops").first<{ id: string }>())!.id;
    refundsMade[0].status = "failed";
    expect((await hook(stripeEvent("refund.failed", { object: "refund", id: "re_1", status: "failed", metadata: { op_id: opId, submission: "1" } }, (NOW + 2 * DAY) / 1000))).status).toBe(200);
    await sweep(); // submission 2, pending
    expect(refundPosts()).toHaveLength(2);
    expect(await env.DB.prepare("SELECT stripe_refund_id AS r, submission FROM refund_ops").first()).toEqual({ r: "re_2", submission: 2 });
    // Stripe delivers another (stale) failure for attempt 1, out of order.
    const stale = await hook(stripeEvent("refund.updated", { object: "refund", id: "re_1", status: "failed", metadata: { op_id: opId, submission: "1" } }, (NOW + 2 * DAY) / 1000 + 9));
    expect(stale.status).toBe(200);
    expect(await env.DB.prepare("SELECT error FROM stripe_events ORDER BY received_at DESC, rowid DESC LIMIT 1").first()).toEqual({ error: "stale_refund_event" });
    expect(await env.DB.prepare("SELECT stripe_refund_id AS r FROM refund_ops").first()).toEqual({ r: "re_2" });
    at(NOW + 2 * DAY + 2 * 3_600_000); await sweep();
    expect(refundPosts()).toHaveLength(2); // no third payout
    refundsMade[1].status = "succeeded";
    await hook(stripeEvent("refund.updated", { object: "refund", id: "re_2", status: "succeeded", metadata: { op_id: opId, submission: "2" } }, (NOW + 2 * DAY) / 1000 + 20));
    expect(await env.DB.prepare("SELECT status FROM withdrawals").first()).toEqual({ status: "completed" });
    expect(refundsMade.filter((r) => r.status === "succeeded")).toHaveLength(1);
  });

  it("R3-3 accepting changed terms never reverses the customer's own cancellation", async () => {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'").run();
    await sweep(); at(NOW + 30 * DAY); await sweep(); // notice, then non-renewal at the effective date
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c FROM billing_subscriptions").first()).toEqual({ c: 1 });
    expect(await (await send("/v1/account/cancel-plan", { body: {} })).json()).toMatchObject({ canceled: true });
    const current = { cloudTerms: LEGAL_DOCS.cloudTerms.versionId, termsOfService: LEGAL_DOCS.termsOfService.versionId, privacyPolicy: LEGAL_DOCS.privacyPolicy.versionId };
    expect((await send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions: current } })).status).toBe(200);
    expect(stripeCalls.some((c) => c.form.get("cancel_at_period_end") === "false")).toBe(false);
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c, customer_cancel_at IS NOT NULL AS own FROM billing_subscriptions").first()).toEqual({ c: 1, own: 1 });
  });

  it("R3-4 two checkouts completing at once for one home: exactly one subscription is kept, the other is cancelled and refunded", async () => {
    creditNotesOn = true; // a direct duplicate is refunded through a credit note (Astra DROPDOWN-DIRECT-2 (2))
    await reserve();
    const a = await (await checkout("starter")).json() as { sessionId: string; consentId: string };
    const b = await (await checkout("pro")).json() as { sessionId: string; consentId: string };
    const done = async (sessionId: string, sub: string, inv: string, consentId: string, plan: string) => hook(stripeEvent("checkout.session.completed", await boundSession({
      object: "checkout.session", id: sessionId, mode: "subscription", payment_status: "paid", consent: { terms_of_service: "accepted" }, customer: "cus_test1",
      subscription: sub, invoice: inv, client_reference_id: "home-1", amount_total: 4900, total_details: { amount_tax: 0 }, customer_details: { address: { country: "US" } },
      metadata: { home_id: "home-1", plan, consent_id: consentId } }, {}, retrievable)));
    await Promise.all([done(a.sessionId, "sub_a", "in_a", a.consentId, "starter"), done(b.sessionId, "sub_b", "in_b", b.consentId, "pro")]);
    at(NOW + 60_000); await sweep(); // a completion that found the home busy is retried (serialized)
    const kept = (await env.DB.prepare("SELECT subscription_id AS s FROM billing_subscriptions").first<{ s: string }>())!.s;
    const lost = kept === "sub_a" ? "sub_b" : "sub_a";
    expect(stripeCalls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([`/v1/subscriptions/${lost}`]);
    expect(refundPosts()).toHaveLength(0);
    expect(stripeCalls.filter((x) => x.method === "POST" && x.path === "/v1/credit_notes").map((x) => Number(x.form.get("refund_amount")))).toEqual([4900]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox")).toBe(1);
  });
  it("R3-4 a checkout taken over while its Stripe call was slow expires its own session instead of leaving a second one open", async () => {
    await reserve();
    onSessionCreate = () => env.DB.prepare("UPDATE open_checkouts SET consent_id='consent-newer-submission'").run(); // a newer request took over meanwhile
    const res = await checkout("starter");
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: "checkout_superseded" });
    expect(stripeCalls.some((c) => c.path === "/v1/checkout/sessions/cs_test_1/expire")).toBe(true);
    expect(sessions.filter((x) => x.status === "open")).toHaveLength(0);
  });

  it("R3-5 the forward migration carries pre-0024 refund accounting and settles a legacy lost-response refund without paying twice", async () => {
    await euEarlyPaid(); usedMicrocents = 40_000_000;
    at(NOW + DAY);
    expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin })).status).toBe(200); // the EU/UK full $49
    // The database as the previous version left it: no ledger rows.
    await env.DB.prepare("DELETE FROM refund_invoice_ledger").run();
    const backfill = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0027_"))!;
    for (const q of backfill.queries) await env.DB.prepare(q).run();
    expect(await env.DB.prepare("SELECT decided_cents AS d FROM refund_invoice_ledger WHERE invoice_id='in_1'").first()).toEqual({ d: 4900 });
    at(NOW + 7 * DAY);
    expect(await (await withdrawNow()).json()).toMatchObject({ refundCents: 0 });
    expect(refundPosts().reduce((n, c) => n + Number(c.form.get("amount")), 0)).toBe(4900);
  });
  it("R3-5 a legacy operation whose refund reached Stripe (old key format, no submission number) is settled by op id, not paid again", async () => {
    await paidUs();
    refundLost = 1;
    expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin })).status).toBe(202);
    // As the previous version would have left it: no submission bookkeeping, no submission metadata on the refund.
    await env.DB.prepare("UPDATE refund_ops SET submission=0,submitted_at=NULL,attempts=0,lease_until=NULL,next_attempt_at=NULL").run();
    delete refundsMade[0].metadata.submission;
    const backfill = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0027_"))!;
    for (const q of backfill.queries) await env.DB.prepare(q).run();
    expect(await env.DB.prepare("SELECT submitted_at IS NOT NULL AS s FROM refund_ops").first()).toEqual({ s: 1 });
    at(NOW + 48 * 3_600_000); await sweep();
    expect(refundsMade).toHaveLength(1);
    expect(await env.DB.prepare("SELECT done_at IS NOT NULL AS d FROM refund_ops").first()).toEqual({ d: 1 });
  });

  it("r13 drops the quote rule: a tax failure is still 409 tax_unavailable on the quote route, but checkout needs no quote (Stripe prices on its own page)", async () => {
    await reserve(); taxFails = true;
    const res = await send("/v1/legal/quote", { body: { plan: "starter", country: "US", homeId: "home-1" }, headers: admin });
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: "tax_unavailable" });
    expect(await count("SELECT COUNT(*) AS n FROM tax_quotes")).toBe(0);
    // A consent that carries no quote is accepted, immediate and EU alike; a quoteId, if sent, is ignored.
    for (const country of ["US", "NL"]) {
      const r = await send("/v1/billing/checkout", { body: { homeId: "home-1", plan: "starter", consent: consentFor("starter", NOW, { billingCountry: country }) }, headers: admin });
      expect(r.status, country).toBe(200);
    }
    expect(stripeCalls.some((c) => c.path === "/v1/checkout/sessions" && c.method === "POST")).toBe(true);
    expect(await env.DB.prepare("SELECT quote_id AS q, quoted_total_cents AS t, tax_source AS s FROM checkout_consents ORDER BY created_at DESC, rowid DESC LIMIT 1").first()).toEqual({ q: null, t: null, s: "hosted" });
  });

  it("R3-9 poison work is isolated: undeliverable notices back off and are escalated to ops while the next customer gets theirs; one failing non-renewal does not stop the next", { timeout: 90_000 }, async () => {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 101; i++) {
      stmts.push(env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'P',?,1,?,?)`).bind(`p-${i}`, `p${i}@example.test`, NOW, NOW),
        env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
          VALUES (?,?,?,'ready','ready',?,'k',?,?)`).bind(`ph-${i}`, `inst-p-${i}`, `p-${i}`, IMAGE, NOW, NOW),
        env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at,current_period_end,reminder_due_at)
          VALUES (?,?,?,'starter','active',?,?,?,?)`).bind(`ph-${i}`, `cus_p${i}`, `sub_p${i}`, NOW, NOW, NOW + 40 * DAY, NOW + 365 * DAY),
        env.DB.prepare(`INSERT INTO terms_acceptances (id,user_id,cloud_terms_version,tos_version,privacy_version,source,wording,accepted_at,client_meta)
          VALUES (?,?,'cloud-terms-0ld0ld0ld0ld',?,?,'checkout','x',?,'{}')`).bind(`acc-${i}`, `p-${i}`, LEGAL_DOCS.termsOfService.versionId, LEGAL_DOCS.privacyPolicy.versionId, NOW));
    }
    await env.DB.batch(stmts);
    const poisoned: BillingNotifier = { async notify(e, n) {
      if (n.homeId !== "ph-100" && n.kind === "terms_change") throw new Error("mailbox_gone");
      await notifier.notify(e, n);
    } };
    const d = (): BillingDependencies => ({ ...deps(), notifier: poisoned });
    await sweepBilling(baseEnv(), d()).catch(() => undefined);
    at(NOW + 10 * 60_000); await sweepBilling(baseEnv(), d()).catch(() => undefined);
    expect(notices.filter((n) => n.kind === "terms_change" && n.homeId === "ph-100")).toHaveLength(1); // the healthy customer got theirs
    for (let k = 1; k <= 9; k++) { at(NOW + k * 7 * 3_600_000); await sweepBilling(baseEnv(), d()).catch(() => undefined); }
    expect(await count("SELECT COUNT(*) AS n FROM terms_notice_obligations WHERE dead_at IS NOT NULL")).toBe(100);
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='terms.notice_dead' LIMIT 1").first()).toEqual({ kind: "terms.notice_dead" });
    // Non-renewal enforcement: two customers past their effective date; the first one's Stripe call keeps failing.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO terms_change_notices (user_id,cloud_terms_version,tos_version,privacy_version,home_id,notified_at,effective_at) VALUES ('p-0',?,?,?,'ph-0',?,?)`)
        .bind(LEGAL_DOCS.cloudTerms.versionId, LEGAL_DOCS.termsOfService.versionId, LEGAL_DOCS.privacyPolicy.versionId, NOW, NOW + DAY),
      env.DB.prepare(`INSERT INTO terms_change_notices (user_id,cloud_terms_version,tos_version,privacy_version,home_id,notified_at,effective_at) VALUES ('p-1',?,?,?,'ph-1',?,?)`)
        .bind(LEGAL_DOCS.cloudTerms.versionId, LEGAL_DOCS.termsOfService.versionId, LEGAL_DOCS.privacyPolicy.versionId, NOW, NOW + DAY),
    ]);
    cancelStuck = true; // makes the POST below fail only for sub_p0
    const failing: StripeFetch = async (input, init) => (String(input).includes("/v1/subscriptions/sub_p0")
      ? new Response(JSON.stringify({ error: { code: "rate_limit" } }), { status: 500 }) : stripeFetch(input, init));
    at(NOW + 3 * DAY); await sweepBilling(baseEnv(), { ...d(), stripeFetch: failing }).catch(() => undefined);
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c FROM billing_subscriptions WHERE home_id='ph-1'").first()).toEqual({ c: 1 });
    expect(await env.DB.prepare("SELECT enforce_attempts AS a FROM terms_change_notices WHERE user_id='p-0'").first()).toEqual({ a: 1 });
  });
});

describe("Astra review of 6bc5e037c: one per-home serializer; one test per reproduction", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const tick = () => new Promise((r) => setTimeout(r, 60));
  const current = () => ({ cloudTerms: LEGAL_DOCS.cloudTerms.versionId, termsOfService: LEGAL_DOCS.termsOfService.versionId, privacyPolicy: LEGAL_DOCS.privacyPolicy.versionId });
  async function nonRenewalSet() {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_end=?").bind(NOW + 60 * DAY).run(); // a paid period still running at the effective date
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'").run();
    await sweep(); at(NOW + 30 * DAY); await sweep();
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
  }

  it("R4-1 a refund call that outlives its lease cannot pay twice: the next holder reuses the same submission key; the late worker records nothing", async () => {
    await paidUs();
    let release!: () => void; holdRefund = new Promise<void>((r) => { release = r; });
    const slow = send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin }); // its Stripe call hangs
    await tick();
    await env.DB.prepare("UPDATE billing_home_leases SET lease_until=0").run(); // the lease has expired (on the DATABASE's clock)
    await sweep(); // a new holder: same submission, same key: Stripe's idempotency returns the one refund
    release(); await slow;
    expect(refundsMade).toHaveLength(1);
    expect(new Set(refundPosts().map((c) => c.headers.get("idempotency-key")))).toEqual(new Set([`refundop:firstmonth:${OWNER}:1`]));
    expect(await env.DB.prepare("SELECT stripe_refund_id AS r, done_at IS NOT NULL AS d FROM refund_ops").first()).toEqual({ r: "re_1", d: 1 });
  });

  it("R4-2 a customer's cancellation that races a re-acceptance always ends with renewal off, confirmed by Stripe", async () => {
    await nonRenewalSet();
    let release!: () => void; holdSubPost = new Promise<void>((r) => { release = r; });
    const accepting = send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions: current() } }); // its "renew" call hangs
    await tick();
    // Astra TAXCOUNTRY-8 (coordinator a): the home is busy (the re-acceptance holds its lease), yet the cancellation intent is recorded
    // FIRST, bound to the subscription: the answer is "processing" (never home_busy), and the sweep confirms it.
    const busy = await send("/v1/account/cancel-plan", { body: {} });
    expect(busy.status).toBe(200); expect(await busy.json()).toEqual({ canceled: false, processing: true });
    expect(await env.DB.prepare("SELECT subscription_id AS s, customer_cancel_at IS NOT NULL AS c, cancel_intent_rev>cancel_synced_rev AS pending FROM billing_subscriptions").first())
      .toEqual({ s: "sub_test1", c: 1, pending: 1 });
    release(); await accepting; holdSubPost = null;
    expect(await (await send("/v1/account/cancel-plan", { body: {} })).json()).toMatchObject({ canceled: true });
    at(NOW + 30 * DAY + 60_000); await sweep();
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c, cancel_synced_rev=cancel_intent_rev AS synced FROM billing_subscriptions").first()).toEqual({ c: 1, synced: 1 });
  });

  it("R4-3 two completions racing for a home whose earlier subscription was cancelled: exactly one is kept", async () => {
    creditNotesOn = true; // the loser names the consent but is not its bound session: refused on its own (direct: refunded through a credit note)
    await reserve(); await checkout("starter");
    await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='sub_old',status='canceled'").run();
    const consentId = await latestConsentId("home-1");
    const done = (session: string, sub: string, inv: string) => sessionCompleted({ id: session, subscription: sub, invoice: inv, metadata: { home_id: "home-1", plan: "starter", consent_id: consentId } });
    await Promise.all([done("cs_x", "sub_x", "in_x"), done("cs_y", "sub_y", "in_y")]);
    at(NOW + 60_000); await sweep();
    const kept = (await env.DB.prepare("SELECT subscription_id AS s FROM billing_subscriptions").first<{ s: string }>())!.s;
    expect(["sub_x", "sub_y"]).toContain(kept);
    expect(stripeCalls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([`/v1/subscriptions/${kept === "sub_x" ? "sub_y" : "sub_x"}`]);
    expect(refundsMade.map((r) => r.amount)).toEqual([4900]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox")).toBe(1);
  });

  it("R4-7 enforcement: rows waiting for a later deadline do not crowd out the next customer; a notice sent by the generic retry completes its obligation", async () => {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 101; i++) {
      stmts.push(env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
          VALUES (?,?,?,'ready','ready',?,'k',?,?)`).bind(`eh-${i}`, `inst-e-${i}`, `e-${i}`, IMAGE, NOW, NOW),
        env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at,current_period_end,reminder_due_at)
          VALUES (?,?,?,'starter','active',?,?,?,?)`).bind(`eh-${i}`, `cus_e${i}`, `sub_e${i}`, NOW, NOW, NOW + 60 * DAY, NOW + 365 * DAY),
        env.DB.prepare(`INSERT INTO terms_change_notices (user_id,cloud_terms_version,tos_version,privacy_version,home_id,notified_at,effective_at)
          VALUES (?,?,?,?,?,?,?)`).bind(`e-${i}`, LEGAL_DOCS.cloudTerms.versionId, LEGAL_DOCS.termsOfService.versionId, LEGAL_DOCS.privacyPolicy.versionId, `eh-${i}`, NOW - 31 * DAY, NOW - DAY),
        env.DB.prepare(`INSERT INTO terms_acceptances (id,user_id,cloud_terms_version,tos_version,privacy_version,source,wording,accepted_at,client_meta)
          VALUES (?,?,'cloud-terms-0ld0ld0ld0ld',?,?,'checkout','x',?,'{}')`).bind(`eacc-${i}`, `e-${i}`, LEGAL_DOCS.termsOfService.versionId, LEGAL_DOCS.privacyPolicy.versionId, NOW - 60 * DAY));
    }
    await env.DB.batch(stmts);
    await sweep(); await sweep();
    expect(subState.sub_e100?.cancel_at_period_end).toBe(true); // customer 101 reached on the second sweep
    expect(await count("SELECT COUNT(*) AS n FROM terms_change_notices WHERE enforce_next_at=?", NOW + 53 * DAY)).toBe(101);
    // A dead-lettered notice obligation that the generic retry then delivered.
    await paidUs();
    const v = current();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO terms_notice_obligations (user_id,cloud_terms_version,tos_version,privacy_version,home_id,created_at,attempts,dead_at) VALUES (?,?,?,?,'home-1',?,8,?)`)
        .bind(OWNER, v.cloudTerms, v.termsOfService, v.privacyPolicy, NOW, NOW),
      env.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at,sent_at) VALUES (?,'home-1','terms_change','{}',?,?)")
        .bind(`terms_change:home-1:${v.cloudTerms}:${v.termsOfService}:${v.privacyPolicy}`, NOW, NOW + DAY),
    ]);
    at(NOW + 2 * DAY); await sweep();
    expect(await env.DB.prepare("SELECT notified_at AS n, effective_at AS e FROM terms_change_notices WHERE user_id=?").bind(OWNER).first()).toEqual({ n: NOW + DAY, e: NOW + 31 * DAY });
  });

  it("P2 successive revisions: an accepted revision whose own notice is not yet effective is never reported effective", async () => {
    await paidUs(); signedIn = OWNER;
    const B = "cloud-terms-bbbbbbbbbbbb";
    await env.DB.batch([
      env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-aaaaaaaaaaaa'"),
      env.DB.prepare(`INSERT INTO terms_acceptances (id,user_id,cloud_terms_version,tos_version,privacy_version,source,wording,accepted_at,client_meta) VALUES ('accB',?,?,?,?,'reaccept','x',?,'{}')`)
        .bind(OWNER, B, LEGAL_DOCS.termsOfService.versionId, LEGAL_DOCS.privacyPolicy.versionId, NOW + 5 * DAY),
      env.DB.prepare(`INSERT INTO terms_change_notices (user_id,cloud_terms_version,tos_version,privacy_version,home_id,notified_at,effective_at) VALUES (?,?,?,?,'home-1',?,?)`)
        .bind(OWNER, B, LEGAL_DOCS.termsOfService.versionId, LEGAL_DOCS.privacyPolicy.versionId, NOW, NOW + 30 * DAY),
    ]);
    at(NOW + 10 * DAY); // revision C (the deployed one) now exists too
    expect(await (await get("/v1/account/terms")).json()).toMatchObject({ effective: { cloudTerms: "cloud-terms-aaaaaaaaaaaa" } });
  });
});

describe("Astra review of ff8cf45be: one test per reproduction", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const deletes = () => stripeCalls.filter((c) => c.method === "DELETE").map((c) => c.path);
  const tick = () => new Promise((r) => setTimeout(r, 60));
  const expireLease = () => env.DB.prepare("UPDATE billing_home_leases SET lease_until=0").run();
  const current = () => ({ cloudTerms: LEGAL_DOCS.cloudTerms.versionId, termsOfService: LEGAL_DOCS.termsOfService.versionId, privacyPolicy: LEGAL_DOCS.privacyPolicy.versionId });
  async function hookWith(event: unknown, d: BillingDependencies) {
    const raw = JSON.stringify(event);
    return send("/v1/billing/webhook", { raw, headers: { "stripe-signature": await signStripePayload(raw, WHSEC, Math.floor(Date.now() / 1000)) } }, d);
  }
  const subDeleted = (id = "sub_test1", created = NOW / 1000 + 5) => stripeEvent("customer.subscription.deleted", { object: "subscription", id, customer: "cus_test1", status: "canceled",
    items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }, created);

  it("#1 a request that outlives its lease and lands after the customer's cancellation is corrected by the next sweep (journal + fresh key)", async () => {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_end=?").bind(NOW + 60 * DAY).run(); // a paid period still running at the effective date
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'").run();
    await sweep(); at(NOW + 30 * DAY); await sweep();
    expect(subState.sub_test1.cancel_at_period_end).toBe(true); // renewal off for non-acceptance
    let release!: () => void; holdSubPost = new Promise<void>((r) => { release = r; });
    const accepting = send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions: current() } }); // its "renew" POST hangs
    await tick();
    await expireLease(); // the lease expires while that request is in flight
    expect(await (await send("/v1/account/cancel-plan", { body: {} })).json()).toMatchObject({ canceled: true });
    expect(subState.sub_test1.cancel_at_period_end).toBe(true); // Stripe confirmed the customer's cancellation
    release(); await accepting; holdSubPost = null; // round 7: the old request was settled by its own key before the cancel, so it cannot land late
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
    await sweep();
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c, cancel_synced_rev=cancel_intent_rev AS synced FROM billing_subscriptions").first()).toEqual({ c: 1, synced: 1 });
    const muts = (await env.DB.prepare("SELECT idempotency_key AS k, desired_cancel AS d, state FROM sub_mutations WHERE desired_cancel=1 OR state<>'confirmed' ORDER BY created_at, rowid").all<{ k: string; d: number; state: string }>()).results;
    expect(new Set(muts.map((m) => m.k)).size).toBe(muts.length); // never a reused key
    expect(muts.at(-1)).toMatchObject({ d: 1, state: "confirmed" });
  });

  it("#1 a subscription with a cancellation intent is re-verified against Stripe at least daily, even when its revisions agree", async () => {
    await paidUs(); signedIn = OWNER;
    expect((await send("/v1/account/cancel-plan", { body: {} })).status).toBe(200);
    subState.sub_test1.cancel_at_period_end = false; // drift behind our back (a dashboard edit, a late request)
    await sweep();
    expect(subState.sub_test1.cancel_at_period_end).toBe(false); // verified within the last day: not looked at again yet
    at(NOW + DAY + 60_000); await sweep();
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
  });

  it("#2 an invoice worker paused in its credit grant cannot turn a subscription deleted meanwhile back to active", async () => {
    await paidUs();
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    const slowFlux: FluxEntitlementHooks = { ...flux, async grantMonthlyCredits(e, input) { await held; return flux.grantMonthlyCredits(e, input); } };
    const day30 = NOW / 1000 + 30 * 86400;
    const renewal = hookWith(stripeEvent("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: day30, end: day30 + 30 * 86400 } }] } }), day30), { ...deps(), flux: slowFlux });
    await tick();
    await expireLease();
    expect((await hook(subDeleted())).status).toBe(200); // a new holder: the subscription ends
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "canceled" });
    release();
    expect((await renewal).status).toBe(500); // the old worker lost its lease: it records nothing and the event is retried
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "canceled" });
  });

  it("#2 a dispute whose home lookup fails once is retried under the lease; while another worker holds the lease it waits instead of cancelling", async () => {
    await paidUs();
    const dispute = () => stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_1", charge: "ch_1", reason: "fraudulent" });
    chargeFails = 2; // the delivery's lookups fail (the hold's attribution, then its recorded retry inside processing): no unleased fallback
    const ev = dispute();
    expect((await hook(ev)).status).toBe(500);
    expect(deletes()).toEqual([]);
    await env.DB.prepare("INSERT OR REPLACE INTO billing_home_leases (home_id,holder,lease_until,generation) VALUES ('home-1','other-worker',?,7)").bind(Date.now() + 10 * 365 * DAY).run();
    expect((await hook(ev)).status).toBe(500); // lookup works now, but another holder owns the home
    expect(deletes()).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "active" });
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL").run();
    at(NOW + DAY); await sweep();
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "disputed" });
    expect(deletes()).toEqual(["/v1/subscriptions/sub_test1"]);
  });

  it("#2 the live no-capacity refund goes through the refund ledger under the lease and completes its outbox only once Stripe says succeeded", async () => {
    await paidUs();
    envOver = { CLOUD_B3_MODE: "live" };
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_homes SET entitlement='refund_pending',payment_version=5 WHERE id='home-1'"),
      env.DB.prepare("INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('ob-1','home-1',1,?,'refund_required',?,?)")
        .bind(OWNER, JSON.stringify({ paymentId: "in_1", version: 5 }), NOW),
    ]);
    await env.DB.prepare("INSERT OR REPLACE INTO billing_home_leases (home_id,holder,lease_until,generation) VALUES ('home-1','other-worker',?,3)").bind(Date.now() + 10 * 365 * DAY).run();
    await sweep(); // the home is busy: nothing is refunded outside the ledger, nothing completed
    expect(refundPosts()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT completed_at AS c FROM cloud_outbox WHERE id='ob-1'").first()).toEqual({ c: null });
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL").run();
    refundStatus = "pending";
    await sweep(); // Stripe accepted it but has not finished
    expect(refundPosts()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT kind,end_plan AS e FROM refund_ops WHERE id='no_capacity:in_1'").first()).toEqual({ kind: "no_capacity", e: 1 });
    expect(await env.DB.prepare("SELECT completed_at AS c FROM cloud_outbox WHERE id='ob-1'").first()).toEqual({ c: null });
    expect((await getHome()).entitlement).toBe("refund_pending");
    refundsMade[0].status = "succeeded"; at(NOW + 2 * 3_600_000);
    await sweep();
    expect(refundPosts()).toHaveLength(1);
    expect((await getHome()).entitlement).toBe("refunded");
    expect(await env.DB.prepare("SELECT completed_at IS NOT NULL AS c FROM cloud_outbox WHERE id='ob-1'").first()).toEqual({ c: 1 });
    expect(deletes()).toEqual(["/v1/subscriptions/sub_test1"]);
  });

  it("Astra TAXCOUNTRY-8 P1-4: a superseded payment's refund ends ITS OWN subscription, never the home's current one, and leaves the home paid", async () => {
    await paidUs();
    envOver = { CLOUD_B3_MODE: "live" };
    await env.DB.prepare("INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('refund:superseded:in_1','home-1',1,?,'refund_required',?,?)")
      .bind(OWNER, JSON.stringify({ paymentId: "in_1", version: 5, subscriptionId: "sub_superseded", status: "paid" }), NOW).run();
    await sweep();
    expect(await env.DB.prepare("SELECT kind,end_plan AS e,subscription_id AS s FROM refund_ops WHERE id='no_capacity:in_1'").first())
      .toEqual({ kind: "no_capacity", e: 1, s: "sub_superseded" });
    expect(deletes()).not.toContain("/v1/subscriptions/sub_test1");
    expect((await getHome()).entitlement).toBe("paid");
  });

  it("round 9b (9a note): a superseded payment's refund and every other refund obligation of the SAME payment never pay out twice (one ledger, one Stripe key)", async () => {
    await paidUs();
    envOver = { CLOUD_B3_MODE: "live" };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('refund:superseded:in_1','home-1',1,?,'refund_required',?,?)")
        .bind(OWNER, JSON.stringify({ paymentId: "in_1", version: 5, subscriptionId: "sub_superseded", status: "paid" }), NOW),
      // The same payment owed back by another path (its holder's own refund obligation), and a ledger operation of another kind for it.
      env.DB.prepare("INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('refund:retired:in_1','home-1',1,?,'refund_required',?,?)")
        .bind(OWNER, JSON.stringify({ paymentId: "in_1", version: 5 }), NOW),
    ]);
    const amounts = () => refundPosts().map((c) => Number(c.form.get("amount")));
    await sweep();
    await sweep();
    expect(amounts()).toEqual([4900]);
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE invoice_id='in_1'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE kind='refund_required' AND completed_at IS NOT NULL")).toBe(2);
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,paid_cents,target_cents,end_plan,detail,created_at,updated_at,payment_intent)
      VALUES ('duplicate:in_1','duplicate','home-1',?,'in_1',4900,4900,0,'{}',?,?,'pi_1')`).bind(OWNER, NOW, NOW).run();
    at(NOW + 2 * 3_600_000);
    await sweep();
    expect(amounts()).toEqual([4900]);
    expect(await env.DB.prepare("SELECT amount_cents AS a FROM refund_ops WHERE id='duplicate:in_1'").first()).toEqual({ a: 0 });
    expect(await env.DB.prepare("SELECT decided_cents AS d FROM refund_invoice_ledger WHERE invoice_id='in_1'").first()).toEqual({ d: 4900 });
  });

  it("Astra TAXCOUNTRY-8 P1-2: a late revoke of a line the home has left stops nothing (completed as skipped); the home's own line is still stopped", async () => {
    await paidUs();
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_homes SET payment_line='sub_new' WHERE id='home-1'"),
      env.DB.prepare("INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('rv-old','home-1',1,?,'external_revoke_required',?,?)")
        .bind(OWNER, JSON.stringify({ sessions: "export_and_billing_only", flux: true, connectedApps: true, paymentLine: "sub_test1" }), NOW),
    ]);
    await sweep();
    const r = await env.DB.prepare("SELECT completed_at IS NOT NULL AS c, receipt FROM cloud_outbox WHERE id='rv-old'").first<{ c: number; receipt: string }>();
    expect(r!.c).toBe(1);
    expect(JSON.parse(r!.receipt)).toMatchObject({ fluxStopped: false, skipped: "line_moved", paymentLine: "sub_test1", currentLine: "sub_new" });
    await env.DB.prepare("INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('rv-cur','home-1',1,?,'external_revoke_required',?,?)")
      .bind(OWNER, JSON.stringify({ flux: true, paymentLine: "sub_new" }), NOW).run();
    await sweep();
    const cur = await env.DB.prepare("SELECT receipt FROM cloud_outbox WHERE id='rv-cur'").first<{ receipt: string | null }>();
    expect(JSON.parse(cur!.receipt!)).toEqual({ fluxStopped: true });
  });

  it("#3 a retried old refund operation cancels its OWN subscription, never the replacement checkout's", async () => {
    await reserve(); expect((await checkout("starter")).status).toBe(200);
    await sessionCompleted(); await hook(stripeEvent("invoice.paid", invoice())); // paid; the lifecycle has not reconciled it yet
    cancelStuck = true; // the old subscription cannot be cancelled yet
    const first = await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin });
    expect(first.status).toBe(202);
    cancelStuck = false;
    await hook(subDeleted());
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "canceled" });
    await env.DB.prepare("UPDATE open_checkouts SET state='failed'").run();
    expect((await checkout("starter")).status).toBe(200); // replacement checkout
    const consentId = await latestConsentId("home-1");
    expect((await sessionCompleted({ id: "cs_new", subscription: "sub_new", invoice: "in_new", metadata: { home_id: "home-1", plan: "starter", consent_id: consentId } })).status).toBe(200);
    expect(await env.DB.prepare("SELECT subscription_id AS s, status FROM billing_subscriptions").first()).toEqual({ s: "sub_new", status: "active" });
    stripeCalls = []; at(NOW + 2 * 3_600_000); await sweep(); // retry the old operation
    expect(deletes()).not.toContain("/v1/subscriptions/sub_new");
    expect(await env.DB.prepare("SELECT subscription_id AS s, status FROM billing_subscriptions").first()).toEqual({ s: "sub_new", status: "active" });
  });

  it("#7 a required terms notice is never abandoned: after 20 failed sends and a restored mailbox it is delivered and acceptance is no longer notice_pending", async () => {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'").run();
    notifierFails = true;
    for (let k = 0; k < 30; k++) { at(NOW + k * 25 * 3_600_000); await sweep(); }
    const ob = await env.DB.prepare("SELECT attempts AS a, delivered_at AS d, dead_at IS NOT NULL AS dead FROM terms_notice_obligations").first<{ a: number; d: number | null; dead: number }>();
    expect(ob!.a).toBeGreaterThanOrEqual(20); expect(ob!.d).toBeNull(); expect(ob!.dead).toBe(1);
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='terms.notice_dead' LIMIT 1").first()).toEqual({ kind: "terms.notice_dead" });
    expect((await send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions: current() } })).status).toBe(409);
    notifierFails = false;
    at(NOW + 32 * 25 * 3_600_000); await sweep();
    expect(notices.filter((n) => n.kind === "terms_change")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT delivered_at IS NOT NULL AS d FROM terms_notice_obligations").first()).toEqual({ d: 1 });
    const res = await send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions: current() } });
    expect(res.status).toBe(200);
  });

  it("P2 the email date is the recorded effective date: a retry re-renders the notice from the moment of its actual send", async () => {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'").run();
    const sent: { text: string }[] = []; let mailDown = true;
    const withMail = () => baseEnv({ EMAIL: { async send(m: { text: string }) { if (mailDown) throw new Error("mail_down"); sent.push(m); return { messageId: "m" }; } } as never });
    const real: BillingDependencies = { stripeFetch, flux, accountUser: async () => null, stepUp: async () => true }; // the real notifier
    await sweepBilling(withMail(), real).catch(() => undefined); // first attempt fails and stores its rendering
    expect(await env.DB.prepare("SELECT delivered_at AS d FROM terms_notice_obligations").first()).toEqual({ d: null });
    mailDown = false; at(NOW + 3 * DAY);
    await sweepBilling(withMail(), real).catch(() => undefined);
    const rec = (await env.DB.prepare("SELECT notified_at AS n, effective_at AS e FROM terms_change_notices").first<{ n: number; e: number }>())!;
    expect(rec).toEqual({ n: NOW + 3 * DAY, e: NOW + 33 * DAY });
    const mail = sent.find((m) => m.text.includes("COPY OF THE NEW"))!;
    expect(mail.text).toContain(isoDate(rec.e)); expect(mail.text).not.toContain(isoDate(NOW + 30 * DAY));
  });
});

describe("Astra review of f693121ae: one test per reproduction", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const deletes = () => stripeCalls.filter((c) => c.method === "DELETE").map((c) => c.path);
  const tick = () => new Promise((r) => setTimeout(r, 60));
  const expireLease = () => env.DB.prepare("UPDATE billing_home_leases SET lease_until=0").run();
  const current = () => ({ cloudTerms: LEGAL_DOCS.cloudTerms.versionId, termsOfService: LEGAL_DOCS.termsOfService.versionId, privacyPolicy: LEGAL_DOCS.privacyPolicy.versionId });
  async function hookWith(event: unknown, d: BillingDependencies) {
    const raw = JSON.stringify(event);
    return send("/v1/billing/webhook", { raw, headers: { "stripe-signature": await signStripePayload(raw, WHSEC, Math.floor(Date.now() / 1000)) } }, d);
  }
  const subDeleted = (id = "sub_test1", created = NOW / 1000 + 5) => stripeEvent("customer.subscription.deleted", { object: "subscription", id, customer: "cus_test1", status: "canceled",
    items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }, created);
  const renewalPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_test1" && c.form.get("cancel_at_period_end") === "false");

  it("#1 a renewal request that outlives its lease and lands after a confirmed cancellation AND a sweep is corrected by the next sweep", async () => {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_end=?").bind(NOW + 60 * DAY).run();
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'").run();
    await sweep(); at(NOW + 30 * DAY); await sweep();
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
    let release!: () => void; holdSubPost = new Promise<void>((r) => { release = r; });
    const accepting = send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions: current() } });
    await tick();
    await expireLease();
    expect((await send("/v1/account/cancel-plan", { body: {} })).status).toBe(200);
    expect(await env.DB.prepare("SELECT cancel_terminal_sub AS t FROM billing_subscriptions").first()).toEqual({ t: "sub_test1" });
    await sweep(); // Astra: this sweep used to clear the re-verification mark while the old request was still unreleased
    release(); await accepting; holdSubPost = null;
    expect(subState.sub_test1.cancel_at_period_end).toBe(true); // round 7: the late request was settled by its own key first; it changes nothing
    await sweep();
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
    await sweep();
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
  });

  it("#1 once a customer cancellation is confirmed, re-accepting the terms never sends a renewal request for that subscription", async () => {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_end=?").bind(NOW + 60 * DAY).run();
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'").run();
    await sweep(); at(NOW + 30 * DAY); await sweep();
    expect((await send("/v1/account/cancel-plan", { body: {} })).status).toBe(200);
    stripeCalls = [];
    expect((await send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions: current() } })).status).toBe(200);
    await sweep();
    expect(renewalPosts()).toHaveLength(0);
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
  });

  it("#4 retrying a fenced invoice event for a subscription that was deleted meanwhile keeps it canceled and grants nothing", async () => {
    await paidUs();
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    const slowFlux: FluxEntitlementHooks = { ...flux, async grantMonthlyCredits(e, input) { await held; return flux.grantMonthlyCredits(e, input); } };
    const day30 = NOW / 1000 + 30 * 86400;
    const renewal = hookWith(stripeEvent("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: day30, end: day30 + 30 * 86400 } }] } }), day30), { ...deps(), flux: slowFlux });
    await tick();
    await expireLease();
    expect((await hook(subDeleted())).status).toBe(200);
    release();
    expect((await renewal).status).toBe(500);
    const grants = () => fluxLog.filter((l) => l.hook === "grant").length;
    const before = grants();
    at(NOW + 31 * DAY); await sweep(); // the same event is retried
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "canceled" });
    expect(grants()).toBe(before);
    expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL")).toBe(0);
  });

  it("#4 a retried checkout completion cannot bring an ended subscription back, and a late trialing update cannot step an active one back", async () => {
    await paidUs();
    expect((await hook(subDeleted())).status).toBe(200);
    expect((await sessionCompleted()).status).toBe(200); // a retried completion for the same, ended subscription
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "canceled" });
    await env.DB.prepare("UPDATE billing_subscriptions SET status='active'").run();
    const upd = (status: string) => stripeEvent("customer.subscription.updated", { object: "subscription", id: "sub_test1", customer: "cus_test1", status, cancel_at_period_end: false,
      items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } });
    expect((await hook(upd("trialing"))).status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "active" });
  });
});

describe("Astra review of 8f43de44d: one test per reproduction", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const tick = () => new Promise((r) => setTimeout(r, 60));
  const expireLease = () => env.DB.prepare("UPDATE billing_home_leases SET lease_until=0").run();
  const current = () => ({ cloudTerms: LEGAL_DOCS.cloudTerms.versionId, termsOfService: LEGAL_DOCS.termsOfService.versionId, privacyPolicy: LEGAL_DOCS.privacyPolicy.versionId });
  const subDeleted = (id = "sub_test1", created = NOW / 1000 + 5) => stripeEvent("customer.subscription.deleted", { object: "subscription", id, customer: "cus_test1", status: "canceled",
    items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }, created);

  it("#1 a confirmed cancellation stops renewal at Stripe at once: the old renewal request is settled before the cancel, with no sweep in between", async () => {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_end=?").bind(NOW + 60 * DAY).run();
    await env.DB.prepare("UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld'").run();
    await sweep(); at(NOW + 30 * DAY); await sweep();
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
    let release!: () => void; holdSubPost = new Promise<void>((r) => { release = r; });
    const accepting = send("/v1/account/terms/accept", { body: { termsAccepted: true, documentVersions: current() } });
    await tick();
    await expireLease();
    expect((await send("/v1/account/cancel-plan", { body: {} })).status).toBe(200);
    expect(subState.sub_test1.cancel_at_period_end).toBe(true); // true right after the response, no sweep
    release(); await accepting;
    expect(subState.sub_test1.cancel_at_period_end).toBe(true); // the old request, released late, changes nothing
    expect(await count("SELECT COUNT(*) AS n FROM sub_mutations WHERE state='pending'")).toBe(0);
  });

  it("#3 an old pending first-month refund refunds the ORIGINAL payment (pi_1), never the replacement's, and takes back only the original invoice's credits", async () => {
    await reserve(); expect((await checkout("starter")).status).toBe(200);
    await sessionCompleted(); await hook(stripeEvent("invoice.paid", invoice())); // sub_test1 paid in_1 with pi_1
    // The one-per-person check cannot finish for the request: the route's quote and the operation's decision both wait, so it stays pending.
    envOver = { DB: identityRace(async () => "pending") };
    expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin })).status).toBe(202);
    envOver = {};
    expect(await env.DB.prepare("SELECT invoice_id AS i, payment_intent AS p, decided_at AS d FROM refund_ops").first()).toEqual({ i: "in_1", p: "pi_1", d: null });
    await hook(subDeleted());
    await env.DB.prepare("UPDATE open_checkouts SET state='failed'").run();
    expect((await checkout("starter")).status).toBe(200);
    const consentId = await latestConsentId("home-1");
    expect((await sessionCompleted({ id: "cs_new", subscription: "sub_new", invoice: "in_new", metadata: { home_id: "home-1", plan: "starter", consent_id: consentId } })).status).toBe(200);
    expect((await hook(stripeEvent("invoice.paid", invoice({ id: "in_new", subscription: "sub_new", payment_intent: "pi_new" })))).status).toBe(200);
    await env.DB.prepare(`UPDATE credit_grants SET body_json='{"amount_microcents":49000000}' WHERE invoice_id='in_1'`).run(); // its frozen amount
    usedFailOn = null; stripeCalls = [];
    at(NOW + 2 * 3_600_000); await sweep(); // the old operation resumes
    expect(refundPosts().map((c) => [c.form.get("payment_intent"), c.form.get("amount")])).toEqual([["pi_1", "4900"]]);
    expect(await env.DB.prepare("SELECT invoice_id AS i, payment_intent AS p, done_at IS NOT NULL AS d FROM refund_ops").first()).toEqual({ i: "in_1", p: "pi_1", d: 1 });
    // Astra JOURNEY-A-5 #3: the operation was opened while sub_test1 kept the home; it resumes after sub_new took over, so it is
    // superseded: no home-wide Stop (that would stop the replacement), only the original invoice's own grant gets its target.
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
    expect(fluxLog.filter((l) => l.hook === "target").map((l) => (l.args as { grantId: string }).grantId)).toEqual(["in_1:period"]);
    expect(await env.DB.prepare("SELECT end_plan FROM refund_ops").first()).toEqual({ end_plan: 0 });
    // A refund event for another payment never touches the operation, even with its op id.
    expect((await hook(stripeEvent("refund.failed", { object: "refund", id: "re_1", status: "failed", payment_intent: "pi_new", metadata: { op_id: `firstmonth:${OWNER}` } }, (NOW + 3 * DAY) / 1000))).status).toBe(200);
    expect(await env.DB.prepare("SELECT done_at IS NOT NULL AS d FROM refund_ops").first()).toEqual({ d: 1 });
  });
});

describe("Astra review of 6f9e90c02 (round 9): one test per reproduction", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const tick = () => new Promise((r) => setTimeout(r, 60));
  const expireLease = () => env.DB.prepare("UPDATE billing_home_leases SET lease_until=0").run();
  const cancelPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_test1" && c.form.get("cancel_at_period_end") === "true")
    .map((c) => c.headers.get("idempotency-key"));
  const subDeleted = (created = NOW / 1000 + 5) => stripeEvent("customer.subscription.deleted", { object: "subscription", id: "sub_test1", customer: "cus_test1", status: "canceled",
    items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }, created);

  it("#1 a cached Stripe failure never yields a cancellation confirmation: processing until Stripe reads back cancel_at_period_end=true, then a FRESH key", async () => {
    await paidUs(); await hook(stripeEvent("invoice.paid", invoice())); signedIn = OWNER;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_end=?").bind(NOW + 30 * DAY).run();
    cancelFailNext = 1; // the cancellation request fails at Stripe, and Stripe caches that 500 against its key
    const res = await send("/v1/account/cancel-plan", { body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canceled: false, processing: true });
    expect(subState.sub_test1.cancel_at_period_end).toBe(false);
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(0); // no email promising "no renewal"
    // The retry (the portal asks again; the sweep does the same) replays the failed key once, records Stripe's cached answer, and sends a fresh key.
    expect(await (await send("/v1/account/cancel-plan", { body: {} })).json()).toMatchObject({ canceled: true });
    const keys = cancelPosts();
    expect(keys[0]).toBe(keys[1]); // the recorded request settled first, with its own key (Stripe replays the cached 500)
    expect(new Set(keys).size).toBe(2); // then one fresh key, which applied
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
    expect(JSON.parse((await env.DB.prepare("SELECT provider_error AS e FROM sub_mutations WHERE provider_error IS NOT NULL").first<{ e: string }>())!.e))
      .toMatchObject({ status: 500, replayed: true });
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(1); // confirmed once, after the read-back
    await sweep(); await sweep();
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM sub_mutations WHERE state='pending'")).toBe(0);
  });

  it("#1 the sweep alone also recovers from the cached failure and only then emails the confirmation", async () => {
    await paidUs(); await hook(stripeEvent("invoice.paid", invoice())); signedIn = OWNER;
    cancelFailNext = 1;
    expect(await (await send("/v1/account/cancel-plan", { body: {} })).json()).toEqual({ canceled: false, processing: true });
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(0);
    for (let i = 0; i < 3 && !subState.sub_test1.cancel_at_period_end; i++) { at(NOW + (i + 1) * 3_600_000); await sweep(); }
    expect(subState.sub_test1.cancel_at_period_end).toBe(true);
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(1);
  });

  it("#3 a withdrawal deducts only service supplied under ITS subscription: day 8 of a replacement keeps 22 days ($35.93 of $49)", async () => {
    await reserve(); expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    await sessionCompleted({ customer_details: { address: { country: "DE" } } });
    await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp(); signedIn = OWNER;
    expect(await env.DB.prepare("SELECT subscription_id AS s FROM service_intervals WHERE ended_at IS NULL").first()).toEqual({ s: "sub_test1" });
    // 30 days supplied under the predecessor contract, and an untagged legacy row: neither belongs to this contract.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO service_intervals (home_id,started_at,ended_at,subscription_id) VALUES ('home-1',?,?,'sub_old')").bind(NOW - 40 * DAY, NOW - 10 * DAY),
      env.DB.prepare("INSERT INTO service_intervals (home_id,started_at,ended_at,subscription_id) VALUES ('home-1',?,?,NULL)").bind(NOW - 9 * DAY, NOW - 1),
    ]);
    at(NOW + 8 * DAY);
    expect(await (await send("/v1/account/withdraw", { body: { confirm: true } })).json())
      .toMatchObject({ basis: "eu_uk_full_refund", daysSupplied: 8, deductedCents: 0, refundCents: 4900 });
  });

  it("#3 a replacement claimed while the home is served starts a new interval under the new subscription", async () => {
    await paidUs(); await hook(stripeEvent("invoice.paid", invoice()));
    await hook(subDeleted());
    // Still served under sub_test1 at the moment the replacement is claimed (the lifecycle has not stopped it yet).
    await env.DB.prepare("INSERT INTO service_intervals (home_id,started_at,subscription_id) VALUES ('home-1',?,'sub_test1')").bind(NOW - 60_000).run();
    await env.DB.prepare("UPDATE open_checkouts SET state='failed'").run();
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='payment_pending', entitlement='pending' WHERE id='home-1'").run(); // reopened for a new checkout
    const again = await checkout("starter");
    expect(again.status === 200 ? "ok" : JSON.stringify(await again.json())).toBe("ok");
    expect((await sessionCompleted({ id: "cs_new", subscription: "sub_new", invoice: "in_new", metadata: { home_id: "home-1", plan: "starter",
      consent_id: await latestConsentId("home-1") } })).status).toBe(200);
    expect((await env.DB.prepare("SELECT subscription_id AS s, ended_at IS NULL AS open FROM service_intervals ORDER BY started_at").all()).results)
      .toEqual([{ s: "sub_test1", open: 0 }, { s: "sub_new", open: 1 }]);
  });

  it("#4 a first-month refund reads the contract INSIDE the lease: a replacement cannot interleave, and the operation is one payment and its own subscription", async () => {
    await paidUs(); await hook(stripeEvent("invoice.paid", invoice())); // sub_test1 paid in_1 with pi_1
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    envOver = { DB: identityRace(async (n) => { if (n === 1) await held; }) }; // paused inside the lease, after the identity check
    const refunding = send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin });
    await tick();
    // A replacement's events arrive while the request is paused inside the lease: they are held off (the home is busy), never interleaved.
    await hook(subDeleted());
    expect(await env.DB.prepare("SELECT processed_at FROM stripe_events WHERE type='customer.subscription.deleted'").first()).toEqual({ processed_at: null });
    release(); expect((await refunding).status).toBe(200); envOver = {};
    expect(await env.DB.prepare("SELECT invoice_id AS i, payment_intent AS p, subscription_id AS s FROM refund_ops").first()).toEqual({ i: "in_1", p: "pi_1", s: "sub_test1" });
    expect(refundPosts().map((c) => c.form.get("payment_intent"))).toEqual(["pi_1"]);
    expect(stripeCalls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v1/subscriptions/sub_test1"]);
  });

  it("#4 a withdrawal is opened inside the lease with its own subscription, recorded explicitly", async () => {
    await reserve(); expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    await sessionCompleted({ customer_details: { address: { country: "DE" } } });
    await hook(stripeEvent("invoice.paid", invoice())); signedIn = OWNER; at(NOW + DAY);
    expect((await send("/v1/account/withdraw", { body: { confirm: true } })).status).toBe(201);
    expect(await env.DB.prepare("SELECT kind, subscription_id AS s, payment_intent AS p FROM refund_ops").first()).toEqual({ kind: "withdrawal", s: "sub_test1", p: "pi_1" });
  });
});

describe("seller split (Sean, 2026-10-10): Ferrox direct in the US, Link (Managed Payments) as merchant of record elsewhere", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  const managed = () => { envOver = { CLOUD_NONUS_SELLER: "managed_payments" } as Partial<Env>; };
  const sessionPost = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions").pop()!;
  const taxCalls = () => stripeCalls.filter((c) => c.path === "/v1/tax/calculations").length;
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const linkPaid = async (country = "DE") => {
    await reserve(); const q = await quoteFor("starter", country, "10115");
    expect((await checkout("starter", { billingCountry: country, earlyStart: true }, q)).status).toBe(200);
    // Stripe's Managed Payments session: Adaptive Pricing presented and charged it in EUR, Link added the VAT.
    expect((await sessionCompleted({ currency: "eur", amount_total: 5390, total_details: { amount_tax: 900 }, customer_details: { address: { country } } })).status).toBe(200);
    expect((await hook(stripeEvent("invoice.paid", invoice({ amount_paid: 5390, tax: 900 })))).status).toBe(200);
    return q;
  };

  it("US: our Checkout plus Stripe Tax, Ferrox Labs authorizes the charge, no managed_payments", async () => {
    managed(); await reserve(); taxFails = false;
    const q = await quoteFor("starter", "US", "94105");
    expect(q.source).toBe("stripe_tax");
    expect(buildDisclosure("starter", NOW, q)).toMatchObject({ seller: "ferrox", sellerLine: null, topupAvailable: true,
      wording: { authorization: "I authorize Ferrox Labs, LLC to charge my payment method for this monthly subscription until I cancel." } });
    expect((await checkout("starter", {}, q)).status).toBe(200);
    const f = sessionPost().form;
    expect(f.get("automatic_tax[enabled]")).toBe("true"); expect(f.get("tax_id_collection[enabled]")).toBe("true");
    expect(f.get("managed_payments[enabled]")).toBe("false"); expect(f.get("metadata[seller]")).toBe("ferrox");
  });

  it("outside the US: a Managed Payments session without any parameter Stripe forbids; Link named as merchant of record; no Stripe Tax call", async () => {
    managed(); await reserve(); taxFails = false;
    const q = await quoteFor("starter", "DE", "10115");
    expect(q).toMatchObject({ source: "managed_payments", tax_cents: null, total_cents: null });
    expect(taxCalls()).toBe(0);
    const d = buildDisclosure("starter", NOW, q);
    expect(d).toMatchObject({ seller: "link", topupAvailable: false,
      wording: { authorization: "I authorize Link (by Stripe), which takes payment for Ferrox Labs, to charge my payment method for this monthly subscription until I cancel." } });
    expect(d.sellerLine).toBe("Ferrox Labs sells and provides Murage Cloud. Outside the US, Link (by Stripe) takes your payment as merchant of record for us, adds local tax where it handles that tax, and sends your receipt. Murage provides the service and support.");
    // No total in a currency the customer will not see: the plan price in USD before tax, local currency and tax shown by Link.
    expect(d.variants.immediate.renewalText).toContain("Starter renews monthly at US$49 plus applicable tax, charged by Link (by Stripe), which takes payment for Ferrox Labs,");
    expect(d.variants.immediate.renewalText).toContain("Today's total, including tax and in the currency you pay in, is shown on Link's payment page before you pay. If you pay in another currency, renewal amounts may change with exchange rates.");
    expect(d.variants.immediate.renewalText).not.toContain("Total including tax: $");
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true }, q)).status).toBe(200);
    const f = sessionPost().form;
    expect(f.get("managed_payments[enabled]")).toBe("true"); expect(f.get("metadata[seller]")).toBe("link");
    for (const k of MANAGED_FORBIDDEN) expect([...f.keys()].filter((x) => x === k || x.startsWith(`${k}[`))).toEqual([]);
    expect(await env.DB.prepare("SELECT tax_source, quoted_total_cents AS t FROM checkout_consents").first()).toEqual({ tax_source: "managed_payments", t: null });
  });

  it("Link: automatic top-up is not offered (a Managed Payments subscription only authorizes Link to charge it)", async () => {
    managed(); await reserve();
    const q = await quoteFor("starter", "FR", "75001");
    const res = await checkout("starter", { billingCountry: "FR", earlyStart: true, topup: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } }, q);
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: "topup_not_available" });
  });

  it("Link outside Stripe's tax coverage, with no Ferrox tax registration there: no checkout (zero tax is never assumed); coverage is data", async () => {
    managed(); await reserve();
    expect(MANAGED_PAYMENTS_TAX_COVERAGE.countries).not.toContain("BR");
    const res = await send("/v1/legal/quote", { body: { plan: "starter", country: "BR", homeId: "home-1" }, headers: admin });
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: "tax_unavailable" });
    envOver = { CLOUD_NONUS_SELLER: "managed_payments", FERROX_TAX_COUNTRIES: "US,BR" } as Partial<Env>;
    expect((await quoteFor("starter", "BR")).source).toBe("managed_payments");
  });

  it("the later non-US switch (CLOUD_NONUS_SELLER=direct) moves NEW signups to Ferrox direct; a page priced for Link is stale", async () => {
    managed(); await reserve();
    const q = await quoteFor("starter", "DE", "10115");
    envOver = {}; taxFails = false; // direct (the test default)
    const res = await checkout("starter", { billingCountry: "DE", earlyStart: true }, q);
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: "disclosure_stale" });
    expect((await quoteFor("starter", "DE", "10115")).source).toBe("stripe_tax");
  });

  it("Link sale completes in the presented currency: the confirmation (with the terms copies) states what was charged, in EUR, and names Link", async () => {
    managed(); await linkPaid();
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE payload LIKE '%\"status\":\"paid\"%'")).toBeGreaterThan(0); // provisioned
    const t = (notices.find((n) => n.kind === "confirmation")!.data as { emailText: string }).emailText;
    expect(t).toContain("Charged at checkout: 53.90 EUR (tax 9.00 EUR), by Link (by Stripe).");
    expect(t).toContain("Link (by Stripe) takes your payments as merchant of record for Ferrox Labs");
    expect(t).toContain("COPY OF THE MURAGE CLOUD TERMS");
    expect(t).not.toContain("$53.90");
  });

  it("a refund Link makes on its own (within 60 days) is reconciled into our ledger: a later first-month refund pays only the rest", async () => {
    managed(); await linkPaid();
    refundsMade.push({ id: "re_link1", amount: 2000, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    expect((await hook(stripeEvent("charge.refunded", { object: "charge", id: "ch_1", customer: "cus_test1", invoice: "in_1", payment_intent: "pi_1",
      refunded: false, amount_refunded: 2000 }))).status).toBe(200);
    expect(await env.DB.prepare("SELECT kind, amount_cents AS a, stripe_refund_id AS r, done_at IS NOT NULL AS d FROM refund_ops").first())
      .toEqual({ kind: "external", a: 2000, r: "re_link1", d: 1 });
    expect(await env.DB.prepare("SELECT decided_cents AS d FROM refund_invoice_ledger WHERE invoice_id='in_1'").first()).toEqual({ d: 2000 });
    // The same event again records nothing new.
    await hook(stripeEvent("charge.refunded", { object: "charge", id: "ch_1", customer: "cus_test1", invoice: "in_1", payment_intent: "pi_1", refunded: false, amount_refunded: 2000 }));
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='external'")).toBe(1);
    stripeCalls = [];
    at(NOW + DAY);
    expect((await send("/v1/admin/refund-first-month", { body: { homeId: "home-1" }, headers: admin })).status).toBe(200);
    expect(refundPosts().map((c) => [c.form.get("payment_intent"), c.form.get("amount")])).toEqual([["pi_1", "3390"]]);
  });

  it("the EU withdrawal works for a Link sale too (Ferrox is the trader): refunded through the ledger on the same payment", async () => {
    managed(); await linkPaid(); signedIn = OWNER; stripeCalls = [];
    at(NOW + 2 * DAY);
    expect((await send("/v1/account/withdraw", { body: { confirm: true } })).status).toBe(201);
    expect(refundPosts().map((c) => c.form.get("payment_intent"))).toEqual(["pi_1"]);
    expect(await env.DB.prepare("SELECT kind, subscription_id AS s FROM refund_ops").first()).toEqual({ kind: "withdrawal", s: "sub_test1" });
  });

  it("the account page refuses to switch automatic top-up on for a Link customer (switching off stays allowed)", async () => {
    managed(); await linkPaid(); signedIn = OWNER;
    const on = await send("/v1/account/topup", { body: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } });
    expect(on.status).toBe(409); expect(await on.json()).toEqual({ error: "topup_not_available" });
    expect((await send("/v1/account/topup", { body: { enabled: false, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } })).status).toBe(200);
  });
});

describe("Astra review of ea25303b6 (round 10): one test per reproduction", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
  const tick = () => new Promise((r) => setTimeout(r, 60));
  const expireLease = () => env.DB.prepare("UPDATE billing_home_leases SET lease_until=0").run();
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const deletes = () => stripeCalls.filter((c) => c.method === "DELETE").map((c) => c.path);
  const managed = () => { envOver = { CLOUD_NONUS_SELLER: "managed_payments" } as Partial<Env>; };
  const subDeleted = (id = "sub_test1") => stripeEvent("customer.subscription.deleted", { object: "subscription", id, customer: "cus_test1", status: "canceled",
    items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }, NOW / 1000 + 5);
  /** The home is open for a new checkout after its subscription ended (the account page offers it again). */
  const reopen = async () => {
    await env.DB.prepare("UPDATE open_checkouts SET state='failed'").run();
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='payment_pending', entitlement='pending' WHERE id='home-1'").run();
  };
  const replacement = async (over: Record<string, unknown> = {}) => sessionCompleted({ id: "cs_new", subscription: "sub_new", invoice: "in_new",
    metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1") }, ...over });
  /** A Basil (2025-03-31.basil) invoice.paid payload: no payment_intent (it is in invoice.payments, not sent in the webhook), the
   *  subscription under parent.subscription_details, the price under pricing.price_details, the tax in total_taxes. */
  const basilInvoice = (over: Record<string, unknown> = {}) => ({ object: "invoice", id: "in_1", customer: "cus_test1", billing_reason: "subscription_create",
    status: "paid", amount_paid: 4900, total_taxes: [],
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_test1", metadata: { home_id: "home-1", plan: "starter" } } },
    lines: { data: [{ pricing: { type: "price_details", price_details: { price: PRICES.STRIPE_PRICE_STARTER, product: "prod_starter" } },
      parent: { type: "subscription_item_details", subscription_item_details: { subscription: "sub_test1", subscription_item: "si_1", proration: false } },
      period: { start: NOW / 1000, end: NOW / 1000 + 30 * 86400 } }] }, ...over });

  it("#1 Basil-shaped invoices on the ONE pinned version: the first payment and its intent are recorded, credits granted, and an EU withdrawal refunds it", async () => {
    basil = true;
    await reserve(); expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    expect((await sessionCompleted({ customer_details: { address: { country: "DE" } } })).status).toBe(200);
    expect((await hook(stripeEvent("invoice.paid", basilInvoice()))).status).toBe(200);
    expect(await env.DB.prepare("SELECT error FROM stripe_events WHERE type='invoice.paid'").first()).toEqual({ error: null });
    expect(await env.DB.prepare("SELECT first_invoice_id AS i, first_payment_intent AS p, first_invoice_cents AS c, first_invoice_tax_cents AS t FROM billing_subscriptions").first())
      .toEqual({ i: "in_1", p: "pi_1", c: 4900, t: 0 });
    expect(fluxLog.filter((l) => l.hook === "grant")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE payload LIKE '%\"status\":\"paid\"%'")).toBeGreaterThan(0);
    signedIn = OWNER; at(NOW + DAY); stripeCalls = [];
    expect((await send("/v1/account/withdraw", { body: { confirm: true } })).status).toBe(201);
    expect(refundPosts().map((c) => c.form.get("payment_intent"))).toEqual(["pi_1"]);
    expect(await env.DB.prepare("SELECT done_at IS NOT NULL AS d FROM refund_ops WHERE kind='withdrawal'").first()).toEqual({ d: 1 });
    // Every request on both seller paths carries the one pinned version Managed Payments requires.
    expect([...new Set(stripeCalls.map((c) => c.headers.get("stripe-version")))]).toEqual(["2025-03-31.basil"]);
    // An event rendered for another API version is never applied as delivered: ops is told (and it is reconciled, see R11 #1).
    const other = { ...stripeEvent("invoice.paid", basilInvoice({ id: "in_other" })), api_version: "2024-06-20" };
    await hook(other);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='billing.webhook_api_version'")).toBe(1);
  });

  it("#3 Link's full refund of the PREVIOUS contract's payment never cancels the replacement: it is recorded on the old contract only", async () => {
    managed(); await reserve();
    const q1 = await quoteFor("starter", "DE", "10115");
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true }, q1)).status).toBe(200);
    expect((await sessionCompleted({ currency: "eur", amount_total: 5390, total_details: { amount_tax: 900 }, customer_details: { address: { country: "DE" } } })).status).toBe(200);
    expect((await hook(stripeEvent("invoice.paid", invoice({ amount_paid: 5390, tax: 900 })))).status).toBe(200);
    expect((await hook(subDeleted())).status).toBe(200);
    await reopen();
    const q2 = await quoteFor("starter", "DE", "10115");
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true }, q2)).status).toBe(200);
    expect((await replacement({ currency: "eur", amount_total: 5390, total_details: { amount_tax: 900 }, customer_details: { address: { country: "DE" } } })).status).toBe(200);
    piInvoices = { pi_new: "in_new" }; invoiceSubs = { in_new: "sub_new" };
    expect((await hook(stripeEvent("invoice.paid", invoice({ id: "in_new", subscription: "sub_new", payment_intent: "pi_new", amount_paid: 5390, tax: 900 })))).status).toBe(200);
    stripeCalls = []; fluxLog = [];
    refundsMade.push({ id: "re_link_old", amount: 5390, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    // Basil: the charge no longer names its invoice; the payment's own invoice and contract are looked up.
    expect((await hook(stripeEvent("charge.refunded", { object: "charge", id: "ch_old", customer: "cus_test1", payment_intent: "pi_1", refunded: true,
      amount_refunded: 5390 }))).status).toBe(200);
    expect(await env.DB.prepare("SELECT kind, subscription_id AS s, invoice_id AS i, payment_intent AS p, amount_cents AS a FROM refund_ops").all().then((r) => r.results))
      .toEqual([{ kind: "external", s: "sub_test1", i: "in_1", p: "pi_1", a: 5390 }]);
    expect(deletes()).toEqual([]);
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
    expect(await env.DB.prepare("SELECT subscription_id AS s, status FROM billing_subscriptions").first()).toEqual({ s: "sub_new", status: "active" });
    expect(notices.filter((n) => n.kind === "refunded")).toHaveLength(0);
  });

  it("#4 a Link contract never keeps or reactivates automatic top-up: switched off when Link takes over, and refused on every path", async () => {
    await reserve();
    expect((await checkout("starter", { topup: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } })).status).toBe(200); // direct (US) with top-up
    expect((await sessionCompleted()).status).toBe(200);
    expect(await env.DB.prepare("SELECT enabled FROM topup_settings").first()).toEqual({ enabled: 1 });
    expect((await hook(subDeleted())).status).toBe(200);
    await reopen(); managed();
    const q = await quoteFor("starter", "DE", "10115");
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true }, q)).status).toBe(200);
    fluxLog = [];
    expect((await replacement({ currency: "eur", amount_total: 5390, total_details: { amount_tax: 900 }, customer_details: { address: { country: "DE" } } })).status).toBe(200);
    const autorecharge = () => fluxLog.filter((l) => l.hook === "autorecharge").map((l) => (l.args as { enabled: boolean }).enabled);
    expect(await env.DB.prepare("SELECT enabled, applied_revision=revision AS a FROM topup_settings").first()).toEqual({ enabled: 0, a: 1 });
    expect(autorecharge()).toEqual([false]);
    // A stored "on" written by any path (a racing write, a restored row) never reaches Flux as enabled: the leased apply switches it off.
    await env.DB.prepare("UPDATE topup_settings SET enabled=1, revision=revision+1").run();
    fluxLog = [];
    await sweep();
    expect(autorecharge()).toEqual([false]);
    expect(await env.DB.prepare("SELECT enabled FROM topup_settings").first()).toEqual({ enabled: 0 });
    signedIn = OWNER;
    const on = await send("/v1/account/topup", { body: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } });
    expect(on.status).toBe(409); expect(await on.json()).toEqual({ error: "topup_not_available" });
    expect((await (await send("/v1/account/cloud", { method: "GET" })).json() as { topup: unknown }).topup).toMatchObject({ available: false, enabled: false });
  });

  it("#6 the Link confirmation states what Stripe read back as charged (presentment_details: 51.00 EUR), never the integration total ($58.31)", async () => {
    managed(); await reserve();
    const q = await quoteFor("starter", "DE", "10115");
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true }, q)).status).toBe(200);
    expect((await sessionCompleted({ currency: "usd", amount_total: 5831, total_details: { amount_tax: 931 },
      presentment_details: { presentment_amount: 5100, presentment_currency: "eur" }, customer_details: { address: { country: "DE" } } })).status).toBe(200);
    const t = (notices.find((n) => n.kind === "confirmation")!.data as { emailText: string }).emailText;
    expect(t).toContain("Charged at checkout: 51.00 EUR including tax, by Link (by Stripe); Link's receipt itemizes the tax.");
    expect(t).not.toContain("58.31"); expect(t).not.toContain("9.31");
    // The integration amounts stay for refund accounting.
    expect(await env.DB.prepare("SELECT total_cents AS t, tax_cents AS x, charged_currency AS c, charged_total_cents AS ct, charged_tax_cents AS cx FROM checkout_consents").first())
      .toEqual({ t: 5831, x: 931, c: "eur", ct: 5100, cx: null });
  });

  it("PARTIAL lifecycle service intervals go through the billing lease: a transition while another worker holds it writes no interval; the sweep applies it under the lease", async () => {
    await paidUs();
    const other = (await acquireHomeLease(env, "home-1", "another-billing-worker"))!;
    await serviceUp();
    expect(await count("SELECT COUNT(*) AS n FROM service_intervals")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM service_interval_log WHERE applied_at IS NULL")).toBe(1);
    await releaseHomeLease(env, other);
    await sweep();
    expect((await env.DB.prepare("SELECT subscription_id AS s, ended_at IS NULL AS open FROM service_intervals").all()).results).toEqual([{ s: "sub_test1", open: 1 }]);
    expect(await count("SELECT COUNT(*) AS n FROM service_interval_log WHERE applied_at IS NULL")).toBe(0);
  });

  it("R11 #1 a paid checkout delivered in another API version is reconciled at the pinned version (webhook and sweep): confirmed and activated, never stranded", async () => {
    await reserve(); expect((await checkout("starter")).status).toBe(200);
    // The session as Stripe returns it in the pinned version.
    const session = await boundSession({ object: "checkout.session", id: "cs_test_1", mode: "subscription", payment_status: "paid", customer: "cus_test1", subscription: "sub_test1",
      invoice: "in_1", client_reference_id: "home-1", amount_total: 4900, currency: "usd", total_details: { amount_tax: 0 }, customer_details: { address: { country: "US" } },
      consent: { terms_of_service: "accepted" }, metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1") } }, {}, retrievable);
    retrievable["/v1/checkout/sessions/cs_test_1"] = session;
    // The same checkout from an endpoint on an older version: its stored payload can never be re-rendered.
    const oldCheckout = { ...stripeEvent("checkout.session.completed", session), api_version: "2024-06-20" };
    // Webhook path: reconciled at once.
    expect((await hook(oldCheckout)).status).toBe(200);
    expect(stripeCalls.find((c) => c.method === "GET" && c.path === "/v1/checkout/sessions/cs_test_1")?.headers.get("stripe-version")).toBe("2025-03-31.basil");
    expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='billing.webhook_api_version'")).toBe(1);
    expect(await env.DB.prepare("SELECT event_api_version AS v, pinned_api_version AS p, object_id AS o FROM stripe_event_reconciliations WHERE event_id=?")
      .bind(oldCheckout.id).first()).toEqual({ v: "2024-06-20", p: "2025-03-31.basil", o: "cs_test_1" });
    const stored = (await env.DB.prepare("SELECT payload FROM stripe_events WHERE id=?").bind(oldCheckout.id).first<{ payload: string }>())!;
    expect(JSON.parse(stored.payload).api_version).toBe("2024-06-20"); // the raw event is kept as received
    // Sweep path: the first invoice came in the old version too and was quarantined by the previous build (six attempts); the sweep recovers it.
    const oldInvoice = { ...stripeEvent("invoice.paid", { object: "invoice", id: "in_1", subscription: "sub_test1", amount_paid: 4900 }), api_version: "2024-06-20" };
    await env.DB.prepare("INSERT INTO stripe_events (id,type,payload,received_at,attempts,error,next_attempt_at) VALUES (?,?,?,?,6,'event_api_version_unsupported',?)")
      .bind(oldInvoice.id, oldInvoice.type, JSON.stringify(oldInvoice), NOW, NOW).run();
    retrievable["/v1/invoices/in_1"] = basilInvoice({ payments: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: "pi_1" } }] },
      status_transitions: { paid_at: NOW / 1000 } });
    at(NOW + 60_000); await sweep();
    expect(await env.DB.prepare("SELECT processed_at IS NOT NULL AS d FROM stripe_events WHERE id=?").bind(oldInvoice.id).first()).toEqual({ d: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM stripe_event_reconciliations")).toBe(2);
    expect(await env.DB.prepare("SELECT first_invoice_id AS i, first_payment_intent AS p FROM billing_subscriptions").first()).toEqual({ i: "in_1", p: "pi_1" });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE payload LIKE '%\"status\":\"paid\"%'")).toBeGreaterThan(0);
    // Idempotent: Stripe's resend of the old checkout changes nothing.
    expect(await (await hook(oldCheckout)).json()).toEqual({ received: true, duplicate: true });
    expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(1);
    expect(refundPosts()).toHaveLength(0);
  });

});

describe("Astra review of d3e987b9d (round 12): a version-mismatched event only triggers a sync of current state", () => {
  const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
  const deletes = () => stripeCalls.filter((c) => c.method === "DELETE").map((c) => c.path);
  const old = (type: string, object: Record<string, unknown>) => ({ ...stripeEvent(type, object), api_version: "2024-06-20" });
  const outcome = (id: string) => env.DB.prepare("SELECT e.processed_at IS NOT NULL AS p, e.error AS e, r.outcome AS r FROM stripe_events e LEFT JOIN stripe_event_reconciliations r ON r.event_id=e.id WHERE e.id=?").bind(id).first();
  const subStatus = async () => (await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id='home-1'").first<{ status: string }>())!.status;
  const paidInvoice = () => ({ ...invoice(), status: "paid", status_transitions: { paid_at: NOW / 1000 } });

  it("R12 #1a a dispute Stripe now reports won (or a closed inquiry) cancels nothing; one still open is applied", async () => {
    await paidUs();
    expect(await subStatus()).toBe("active");
    retrievable["/v1/disputes/dp_won"] = { object: "dispute", id: "dp_won", charge: "ch_1", status: "won", reason: "fraudulent" };
    const won = old("charge.dispute.created", { object: "dispute", id: "dp_won", charge: "ch_1", status: "needs_response", reason: "fraudulent" });
    expect((await hook(won)).status).toBe(200);
    expect(deletes()).toEqual([]);
    expect(await subStatus()).toBe("active");
    expect(fluxLog.filter((f) => f.hook === "stop")).toHaveLength(0);
    expect(notices.filter((n) => n.kind === "dispute_opened")).toHaveLength(0);
    expect(await outcome(won.id)).toEqual({ p: 1, e: "superseded_dispute_won", r: "superseded_dispute_won" });
    retrievable["/v1/disputes/dp_closed"] = { object: "dispute", id: "dp_closed", charge: "ch_1", status: "warning_closed", reason: "general" };
    const closed = old("charge.dispute.created", { object: "dispute", id: "dp_closed", charge: "ch_1", status: "warning_needs_response", reason: "general" });
    expect((await hook(closed)).status).toBe(200);
    expect(deletes()).toEqual([]);
    expect(await outcome(closed.id)).toEqual({ p: 1, e: "superseded_dispute_warning_closed", r: "superseded_dispute_warning_closed" });
    // A dispute that is still open is the current state: it is applied (cancelled, stopped, announced) as before.
    retrievable["/v1/disputes/dp_open"] = { object: "dispute", id: "dp_open", charge: "ch_1", status: "needs_response", reason: "fraudulent" };
    expect((await hook(old("charge.dispute.created", { object: "dispute", id: "dp_open", charge: "ch_1", status: "needs_response", reason: "fraudulent" }))).status).toBe(200);
    expect(deletes()).toEqual(["/v1/subscriptions/sub_test1"]);
    expect(await subStatus()).toBe("disputed");
    expect(notices.filter((n) => n.kind === "dispute_opened")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE json_extract(payload,'$.api_version')='2024-06-20'")).toBe(3); // raw events kept
  });

  it("R12 #1b an old invoice.payment_failed whose invoice is now paid, after the paid event completed: superseded, never overdue or dunned", async () => {
    await paidUs();
    expect(await subStatus()).toBe("active");
    retrievable["/v1/invoices/in_1"] = paidInvoice();
    const failed = old("invoice.payment_failed", { ...invoice(), status: "open", next_payment_attempt: NOW / 1000 + 86400 });
    expect((await hook(failed)).status).toBe(200);
    expect(await subStatus()).toBe("active");
    expect(notices.filter((n) => n.kind === "payment_failed")).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE payload LIKE '%payment_problem%'")).toBe(0);
    expect(fluxLog.filter((f) => f.hook === "grant")).toHaveLength(1); // the original paid event's only
    expect(await outcome(failed.id)).toEqual({ p: 1, e: "superseded_invoice_paid", r: "superseded_invoice_paid" });
  });

  it("R12 #1c an old invoice.payment_failed whose invoice is now paid, before any paid event: the paid path runs once; the old paid event is then superseded", async () => {
    await reserve(); expect((await checkout("starter")).status).toBe(200);
    expect((await sessionCompleted()).status).toBe(200);
    retrievable["/v1/invoices/in_1"] = paidInvoice();
    const failed = old("invoice.payment_failed", { ...invoice(), status: "open" });
    expect((await hook(failed)).status).toBe(200);
    expect(await subStatus()).toBe("active");
    expect(notices.filter((n) => n.kind === "payment_failed")).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE payload LIKE '%payment_problem%'")).toBe(0);
    expect(await env.DB.prepare("SELECT first_invoice_id AS i FROM billing_subscriptions").first()).toEqual({ i: "in_1" });
    expect(await outcome(failed.id)).toEqual({ p: 1, e: "paid_recovered", r: "paid_recovered" });
    expect(fluxLog.filter((f) => f.hook === "grant")).toHaveLength(1);
    // Stripe's invoice.paid from the same old-version endpoint: already applied, so it grants nothing again.
    const paid = old("invoice.paid", invoice());
    expect((await hook(paid)).status).toBe(200);
    expect(await outcome(paid.id)).toEqual({ p: 1, e: "superseded_invoice_paid", r: "superseded_invoice_paid" });
    expect(fluxLog.filter((f) => f.hook === "grant")).toHaveLength(1);
  });

  it("R12 #2 webhook/sweep race: a webhook holding a stale pre-lease snapshot cannot undo the sweep's completed reconciliation (no plan downgrade)", async () => {
    await paidUs();
    const sub = (price: string) => ({ object: "subscription", id: "sub_test1", customer: "cus_test1", status: "active", cancel_at_period_end: false,
      items: { data: [{ price: { id: price }, current_period_start: NOW / 1000, current_period_end: NOW / 1000 + 30 * 86400 }] } });
    retrievable["/v1/subscriptions/sub_test1"] = sub(PRICES.STRIPE_PRICE_STARTER);
    let reached!: () => void; const atRetrieve = new Promise<void>((r) => { reached = r; });
    let release!: () => void; holdRetrieve = { path: "/v1/subscriptions/sub_test1", reached, gate: new Promise<void>((r) => { release = r; }) };
    const upgrade = old("customer.subscription.updated", sub(PRICES.STRIPE_PRICE_PRO));
    const webhook = hook(upgrade);
    await atRetrieve; // the webhook took its Starter snapshot; its answer is delayed
    retrievable["/v1/subscriptions/sub_test1"] = sub(PRICES.STRIPE_PRICE_PRO); // Stripe: the customer is on Pro
    await sweep(); // the sweep reconciles the same stored event to completion
    expect(await env.DB.prepare("SELECT plan FROM billing_subscriptions").first()).toEqual({ plan: "pro" });
    expect((await outcome(upgrade.id))?.p).toBe(1);
    release(); expect((await webhook).status).toBe(200);
    expect(await env.DB.prepare("SELECT plan FROM billing_subscriptions").first()).toEqual({ plan: "pro" });
    expect(fluxLog.filter((f) => f.hook === "plan").map((f) => (f.args as { plan: string }).plan)).toEqual(["pro"]);
    expect(await count("SELECT COUNT(*) AS n FROM stripe_event_reconciliations WHERE event_id=?", upgrade.id)).toBe(1);
  });
});

describe("Astra review of 5982a7985: a recovered payment is dated by Stripe's paid_at, never by the triggering event", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
  const old = (type: string, object: Record<string, unknown>, created = NOW / 1000) => ({ ...stripeEvent(type, object, created), api_version: "2024-06-20" });
  const outcome = (id: string) => env.DB.prepare("SELECT e.processed_at IS NOT NULL AS p, e.error AS e, r.outcome AS r FROM stripe_events e LEFT JOIN stripe_event_reconciliations r ON r.event_id=e.id WHERE e.id=?").bind(id).first();
  const refundRoute = (body: Record<string, unknown>) => send("/v1/admin/refund-first-month", { body, headers: admin });
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds").map((c) => Number(c.form.get("amount")));
  /** The invoice as Stripe returns it now: paid, at `ms` by Stripe's clock. */
  const paidOn = (inv: Record<string, unknown>, ms: number) => ({ ...inv, status: "paid", status_transitions: { paid_at: ms / 1000 } });
  /** An event an earlier build left pending (stored, not yet due). */
  const storedPending = (e: { id: string; type: string }, receivedAt: number, dueAt: number) =>
    env.DB.prepare("INSERT INTO stripe_events (id,type,payload,received_at,attempts,error,next_attempt_at) VALUES (?,?,?,?,1,'event_api_version_unsupported',?)")
      .bind(e.id, e.type, JSON.stringify(e), receivedAt, dueAt).run();
  const renewal = (over: Record<string, unknown> = {}) => invoice({ id: "in_2", billing_reason: "subscription_cycle",
    lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 } }] }, ...over });

  it.each(["invoice.payment_failed"])("R13 #1 %s from day 0, paid on day 3, recovered: the first payment is day 3, so a refund asked on day 8 is granted (not window_expired)", async (type) => {
    await reserve(); expect((await checkout("starter")).status).toBe(200);
    expect((await sessionCompleted()).status).toBe(200);
    const trigger = old(type, { ...invoice(), status: type === "invoice.created" ? "draft" : "open" }); // created day 0
    await storedPending(trigger, NOW, NOW + 3 * DAY);
    retrievable["/v1/invoices/in_1"] = paidOn(invoice(), NOW + 3 * DAY); // Stripe collected it on day 3
    at(NOW + 3 * DAY); await sweep(); await reconcile();
    expect(await outcome(trigger.id)).toEqual({ p: 1, e: "paid_recovered", r: "paid_recovered" });
    at(NOW + 8 * DAY); stripeCalls = []; // five days after the payment
    const res = await refundRoute({ homeId: "home-1" });
    expect(await res.clone().json()).not.toMatchObject({ error: "window_expired" });
    expect(res.status).toBe(200);
    expect(refundPosts()).toEqual([4900]);
    expect(await env.DB.prepare("SELECT first_invoice_id AS i, first_paid_at AS t FROM billing_subscriptions").first()).toEqual({ i: "in_1", t: NOW + 3 * DAY });
    // The raw trigger is kept exactly as received.
    const stored = (await env.DB.prepare("SELECT payload FROM stripe_events WHERE id=?").bind(trigger.id).first<{ payload: string }>())!;
    expect(JSON.parse(stored.payload)).toEqual(trigger);
  });

  it("R13 #3 a paid invoice with no valid paid_at stays pending (never dated by the trigger); it is recovered once Stripe gives the time", async () => {
    await reserve(); expect((await checkout("starter")).status).toBe(200);
    expect((await sessionCompleted()).status).toBe(200);
    const failed = old("invoice.payment_failed", { ...invoice(), status: "open" });
    const paidQueued = () => count(`SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE payload LIKE '%"status":"paid"%'`);
    const queuedBefore = await paidQueued();
    for (const bad of [{ status: "paid" }, { status: "paid", status_transitions: { paid_at: null } }, { status: "paid", status_transitions: { paid_at: "1800000000" } },
      { status: "paid", status_transitions: { paid_at: NOW / 1000 + 86400 } }]) {
      retrievable["/v1/invoices/in_1"] = { ...invoice(), ...bad };
      if (await count("SELECT COUNT(*) AS n FROM stripe_events WHERE id=?", failed.id) === 0) await hook(failed); // the webhook stores and tries it
      else { await env.DB.prepare("UPDATE stripe_events SET next_attempt_at=0 WHERE id=?").bind(failed.id).run(); await sweep(); } // a sweep retries it
      expect(await outcome(failed.id)).toEqual({ p: 0, e: "invoice_paid_at_unavailable", r: null });
    }
    expect(await env.DB.prepare("SELECT first_invoice_id AS i, first_paid_at AS t FROM billing_subscriptions").first()).toEqual({ i: null, t: null });
    expect(await paidQueued()).toBe(queuedBefore);
    retrievable["/v1/invoices/in_1"] = paidOn(invoice(), NOW);
    await env.DB.prepare("UPDATE stripe_events SET next_attempt_at=0 WHERE id=?").bind(failed.id).run();
    await sweep();
    expect(await outcome(failed.id)).toEqual({ p: 1, e: "paid_recovered", r: "paid_recovered" });
    expect(await env.DB.prepare("SELECT first_invoice_id AS i, first_paid_at AS t FROM billing_subscriptions").first()).toEqual({ i: "in_1", t: NOW });
    expect(await paidQueued()).toBeGreaterThan(queuedBefore);
  });

  it("P3 the already-applied lookup uses the partial expression index on the payload's object id", async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT 1 AS x FROM stripe_events e WHERE e.id<>? AND e.processed_at IS NOT NULL AND json_extract(e.payload,'$.data.object.id')=?
      AND ((e.type='invoice.paid' AND e.error IS NULL) OR EXISTS (SELECT 1 FROM stripe_event_reconciliations r WHERE r.event_id=e.id AND r.outcome=?)) LIMIT 1`)
      .bind("evt_x", "in_1", "paid_recovered").all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join("\n")).toContain("stripe_events_processed_object");
  });
});

describe("trader identity with the LEGAL_PHONE secret (EU pre-contract information), signed-in surfaces only", () => {
  const FAKE_PHONE = "+1 555 0100"; // a fictional test number; the real one is only a Worker secret
  it("the signed-in quote, the account summary and the confirmation carry the phone; the public disclosure never does; unset leaves it out", async () => {
    envOver = { LEGAL_PHONE: FAKE_PHONE } as Partial<Env>;
    await paidUs(); signedIn = OWNER; taxFails = false;
    const quote = await (await send("/v1/legal/quote", { body: { plan: "starter", country: "US", homeId: "home-1" }, headers: admin })).json() as { trader: unknown };
    expect(quote.trader).toEqual({ name: "Ferrox Labs, LLC", address: "1000 Brickell Ave, Suite 715, Miami, Florida 33131, USA", email: "support@murage.ai", phone: FAKE_PHONE });
    const pub = await (await send("/v1/legal/disclosure?plan=starter", { method: "GET" })).text();
    expect(pub).not.toContain(FAKE_PHONE); expect(pub).not.toContain("trader");
    const t = (notices.find((n) => n.kind === "confirmation")!.data as { emailText: string }).emailText;
    expect(t).toContain(`WHO YOU CONTRACT WITH\nFerrox Labs, LLC (Murage), 1000 Brickell Ave, Suite 715, Miami, Florida 33131, USA\nSupport: support@murage.ai (we reply within 2 working days)\nPhone (legal and contract notices only, no support by phone): ${FAKE_PHONE}`);
    expect(await (await send("/v1/account/cloud", { method: "GET" })).json()).toMatchObject({ trader: { phone: FAKE_PHONE } });
    envOver = {};
    expect(await (await send("/v1/account/cloud", { method: "GET" })).json()).toMatchObject({ trader: { phone: null } });
  });
});


describe("Cloud checkout WP5: the three moments, the guard and the deadlines (plan r13c §1.1, §3.3, §4.1; Tests 3 and 4)", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  // Managed Payments outside the US, so the ledger refunds through POST /v1/refunds (the fake has no credit notes).
  const managed = () => { envOver = { CLOUD_NONUS_SELLER: "managed_payments" } as Partial<Env>; };
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const subDeletes = () => stripeCalls.filter((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_test1");
  const sessionObj = async (over: Record<string, unknown> = {}, status = "paid") => boundSession({ object: "checkout.session", id: "cs_test_1", mode: "subscription", payment_status: status,
    customer: "cus_test1", subscription: "sub_test1", invoice: "in_1", client_reference_id: "home-1", amount_total: 4900, total_details: { amount_tax: 0 },
    customer_details: { address: { country: "FR" } },
    metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1") } }, over, retrievable);
  const order = async (declared = "FR") => { managed(); await reserve(); expect((await checkout("starter", { billingCountry: declared, earlyStart: true })).status).toBe(200); };
  const consentRow = () => env.DB.prepare("SELECT * FROM checkout_consents ORDER BY created_at DESC, rowid DESC LIMIT 1").first<Record<string, unknown>>();
  const inbox = () => count("SELECT COUNT(*) AS n FROM cloud_payment_inbox");
  const sub = () => env.DB.prepare("SELECT status,service_start_at AS s FROM billing_subscriptions").first<{ status: string; s: number | null }>();
  // PII (Astra WP5-2 checklist): every notice (sent or recorded), every alert and every log line of a flow is free of the customer's contact,
  // account id, IP and user agent. Our own @murage.ai addresses (support, sender) are the trader's, not personal data.
  const captureLogs = () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); }));
    return { logs, restore: () => { for (const sp of spies) sp.mockRestore(); } };
  };
  const expectPiiFree = async (logs: string[]) => {
    const texts = [...notices.map((n) => JSON.stringify(n.data)),
      ...(await env.DB.prepare("SELECT payload AS t FROM billing_notices").all<{ t: string }>()).results.map((r) => r.t),
      ...(await env.DB.prepare("SELECT detail AS t FROM cloud_alerts").all<{ t: string | null }>()).results.map((r) => r.t ?? ""), ...logs];
    expect(texts.length).toBeGreaterThan(0);
    // Our own addresses and the reserved documentation domain are not leaks: the Cloud terms (regenerated from the site at
    // 1dccaff) explain "+tag" handling with name@example.com / name+shop@example.com (RFC 2606 reserved, never a real person).
    for (const t of texts) expect(t.replace(/[\w.+-]+@(?:murage\.ai|example\.com)/g, "")).not.toMatch(/@|legal-owner|203\.0\.113\.10|198\.51\.100\.5|ua-w|vitest-browser/);
  };
  const homesProvisioned = () => count("SELECT COUNT(*) AS n FROM cloud_fake_resources WHERE role='home' AND state<>'destroyed'");

  describe("Test 3: completed_at, paid_at and service_start_at apart; deadlines written once", () => {
    it("completed with payment pending: completed_at and statutory_withdraw_until, nothing provisioned, 'We got your order'", async () => {
      await order();
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")))).status).toBe(200);
      expect(await consentRow()).toMatchObject({ completed_at: NOW, paid_at: null, statutory_withdraw_until: aoeEnd(NOW, 14), guarantee_withdraw_until: null, refund7_until: null });
      expect(await inbox()).toBe(0);
      expect(await sub()).toMatchObject({ s: null });
      expect((await sub())!.status).not.toBe("active");
      const conf = notices.filter((n) => n.kind === "confirmation");
      expect(conf).toHaveLength(1);
      expect((conf[0].data as { emailText: string }).emailText).toContain("We got your order. Your server starts as soon as your payment clears.");
      expect(notices.some((n) => n.kind === "payment_received")).toBe(false);
    });
    it("async_payment_succeeded writes paid_at, service_start_at = paid_at, the guarantee and the 7-day refund from it, provisions, and says 'Payment received' after 'We got your order'", async () => {
      await order();
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      const paidAt = NOW + 2 * DAY; at(paidAt);
      expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({}, "paid"), paidAt / 1000))).status).toBe(200);
      expect(await consentRow()).toMatchObject({ completed_at: NOW, paid_at: paidAt, statutory_withdraw_until: aoeEnd(NOW, 14),
        guarantee_withdraw_until: aoeEnd(paidAt, 14), refund7_until: aoeEnd(paidAt, 7) });
      expect(await sub()).toEqual({ status: "active", s: paidAt });
      expect(await inbox()).toBe(1);
      expect(notices.map((n) => n.kind).filter((k) => k === "confirmation" || k === "payment_received")).toEqual(["confirmation", "payment_received"]);
      expect((notices.find((n) => n.kind === "payment_received")!.data as { emailText: string }).emailText).toContain("Payment received");
    });
    it("a replayed or later paid event never moves a deadline and sends no second 'Payment received'", async () => {
      await order();
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      const first = NOW + 2 * DAY;
      await hook(stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({}, "paid"), first / 1000));
      const before = await consentRow();
      const dup = stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({}, "paid"), (first + 3 * DAY) / 1000);
      at(first + 3 * DAY);
      expect((await hook(dup)).status).toBe(200);
      expect(await (await hook(dup)).json()).toEqual({ received: true, duplicate: true });
      const after = await consentRow();
      for (const k of ["paid_at", "statutory_withdraw_until", "guarantee_withdraw_until", "refund7_until"]) expect(after![k]).toBe(before![k]);
      expect((await sub())!.s).toBe(first);
      expect(notices.filter((n) => n.kind === "payment_received")).toHaveLength(1);
    });
    it("a session already paid at completion: both moments at once, one email, deadlines from the event time", async () => {
      await order();
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj()))).status).toBe(200);
      expect(await consentRow()).toMatchObject({ completed_at: NOW, paid_at: NOW, guarantee_withdraw_until: aoeEnd(NOW, 14), refund7_until: aoeEnd(NOW, 7) });
      expect(await inbox()).toBe(1);
      expect((notices.find((n) => n.kind === "confirmation")!.data as { emailText: string }).emailText).toContain("We got your order. Payment received: your server is starting.");
    });
    it("async_payment_failed: nothing provisioned, the subscription cancelled without proration, the checkout released and retryable, later events about it ignored", async () => {
      await order();
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      expect((await hook(stripeEvent("checkout.session.async_payment_failed", await sessionObj({}, "unpaid")))).status).toBe(200);
      expect(subDeletes()).toHaveLength(1);
      expect(subDeletes()[0].form.get("prorate")).toBe("false"); expect(subDeletes()[0].form.get("invoice_now")).toBe("false");
      expect(await consentRow()).toMatchObject({ paid_at: null });
      expect((await consentRow())!.payment_failed_at).toBe(NOW);
      expect(await inbox()).toBe(0);
      expect(await env.DB.prepare("SELECT state FROM open_checkouts").first()).toEqual({ state: "failed" });
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions WHERE subscription_id='sub_test1'")).toBe(1);
      expect(notices.some((n) => n.kind === "payment_cancelled")).toBe(true);
      expect(await (await hook(stripeEvent("invoice.paid", invoice()))).json()).toMatchObject({ received: true });
      expect(await inbox()).toBe(0);
      expect((await checkout("starter", { billingCountry: "FR", earlyStart: true })).status).toBe(200); // the customer can start again
    });
    it("a stale async_payment_failed after payment is ignored", async () => {
      await order();
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      expect((await hook(stripeEvent("checkout.session.async_payment_failed", await sessionObj({}, "unpaid")))).status).toBe(200);
      expect(subDeletes()).toHaveLength(0);
      expect((await consentRow())!.payment_failed_at).toBeNull();
    });
    it("checkout.session.expired releases the home's open checkout, and never touches a completed one", async () => {
      await order();
      expect(await env.DB.prepare("SELECT state FROM open_checkouts").first()).toEqual({ state: "open" });
      // Astra JOURNEY-A-2 A6: the session request is on record before Stripe is asked and settled once the session id is recorded.
      expect(await consentRow()).toMatchObject({ stripe_session_id: "cs_test_1", session_inflight_at: null, session_expired_at: null });
      expect((await hook(stripeEvent("checkout.session.expired", await sessionObj({}, "unpaid")))).status).toBe(200);
      expect(await env.DB.prepare("SELECT state FROM open_checkouts").first()).toEqual({ state: "expired" });
      // ...and Stripe's confirmed expiry is the consent's terminal evidence (a failed home's retirement waits for it, never for age).
      expect((await consentRow())!.session_expired_at).not.toBeNull();
      await reserve().catch(() => undefined);
      await env.DB.prepare("UPDATE open_checkouts SET state='completed'").run();
      await hook(stripeEvent("checkout.session.expired", await sessionObj({}, "unpaid")));
      expect(await env.DB.prepare("SELECT state FROM open_checkouts").first()).toEqual({ state: "completed" });
    });
    it("Astra JOURNEY-A-3 #2: an expiry settles only the session request it names (issuance id in metadata), never by timestamp", async () => {
      await order();
      const consentId = (await consentRow())!.id as string;
      // The request carried its issuance id (= its idempotency key) to Stripe; once recorded, the marker and its id are cleared together.
      const create = stripeCalls.find((c) => c.method === "POST" && c.path === "/v1/checkout/sessions")!;
      expect(create.form.get("metadata[issuance_id]")).toBe(`checkout:${consentId}`);
      expect(await consentRow()).toMatchObject({ session_inflight_at: null, session_issuance_id: null });
      // A newer request in flight (a resume whose answer was never recorded).
      await env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=?,session_issuance_id='resume:newer' WHERE id=?").bind(NOW, consentId).run();
      const expired = (id: string, issuance: string | undefined, createdS: number) => stripeEvent("checkout.session.expired", { object: "checkout.session", id,
        mode: "subscription", customer: "cus_test1", client_reference_id: "home-1", created: createdS,
        metadata: { home_id: "home-1", consent_id: consentId, ...(issuance ? { issuance_id: issuance } : {}) } });
      // The probe: an older, unrecorded session of the same consent expiring, Stripe-created AFTER the marker (the old 60 s allowance settled it).
      expect((await hook(expired("cs_older", `checkout:${consentId}`, NOW / 1000 + 5))).status).toBe(200);
      expect(await consentRow()).toMatchObject({ session_inflight_at: NOW, session_issuance_id: "resume:newer" });
      // ...nor does a session that names no issuance at all.
      expect((await hook(expired("cs_unnamed", undefined, NOW / 1000 + 5))).status).toBe(200);
      expect(await consentRow()).toMatchObject({ session_inflight_at: NOW, session_issuance_id: "resume:newer" });
      // The session of THAT request expiring settles it.
      expect((await hook(expired("cs_newer", "resume:newer", NOW / 1000 - 3600))).status).toBe(200);
      expect(await consentRow()).toMatchObject({ session_inflight_at: null, session_issuance_id: null });
    });
    it("Astra JOURNEY-A-3 #3: the sweep reconciles a lost session answer with Stripe by issuance id; one Stripe cannot resolve is alerted, never settled", async () => {
      await order();
      const consentId = (await consentRow())!.id as string;
      const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      const alerts = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='home.checkout_unresolved' AND resolved_at IS NULL");
      const marker = (iss: string, atMs: number) => env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=?,session_issuance_id=? WHERE id=?").bind(atMs, iss, consentId).run();
      // (a) Stripe created the session (open), the recording batch never ran: expired at Stripe by the sweep, then settled.
      sessions.unshift({ id: "cs_lost", status: "open", subscription: null, metadata: { home_id: "home-1", issuance_id: "resume:lost" } });
      await marker("resume:lost", NOW);
      at(NOW + 5 * 60_000); await sweep(); // too young: its own handler may still answer
      expect(sessions.find((x) => x.id === "cs_lost")!.status).toBe("open");
      at(NOW + 20 * 60_000); await sweep();
      expect(sessions.find((x) => x.id === "cs_lost")!.status).toBe("expired");
      expect(await consentRow()).toMatchObject({ session_inflight_at: null, session_issuance_id: null });
      // (b) Already expired at Stripe (the expiry webhook was lost): settled.
      sessions.unshift({ id: "cs_gone", status: "expired", subscription: null, metadata: { home_id: "home-1", issuance_id: "resume:gone" } });
      await marker("resume:gone", NOW); await sweep();
      expect(await consentRow()).toMatchObject({ session_inflight_at: null });
      // (c) Completed at Stripe, completion never recorded: a payment may be on its way, so it is NOT settled; alerted once old enough.
      sessions.unshift({ id: "cs_paid", status: "complete", subscription: "sub_x", metadata: { home_id: "home-1", issuance_id: "resume:paid" } });
      await marker("resume:paid", NOW); await sweep();
      expect(await consentRow()).toMatchObject({ session_inflight_at: NOW, session_issuance_id: "resume:paid" });
      expect(await alerts()).toBe(0);
      at(NOW + 7 * 3_600_000); await sweep();
      expect(await consentRow()).toMatchObject({ session_inflight_at: NOW });
      expect(await alerts()).toBe(1);
      // (d) No session of that issuance at Stripe (a definitively rejected creation): never settled on age, the alert names it.
      sessions.splice(0, sessions.length, ...sessions.filter((x) => x.id !== "cs_paid"));
      await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=1").run();
      await marker("resume:rejected", NOW); at(NOW + 30 * 3_600_000); await sweep(); await sweep();
      expect(await consentRow()).toMatchObject({ session_inflight_at: NOW, session_issuance_id: "resume:rejected" });
      const a = await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='home.checkout_unresolved' AND resolved_at IS NULL").all<{ detail: string }>();
      expect(a.results).toHaveLength(1);
      expect(JSON.parse(a.results[0].detail)).toMatchObject({ consentId, issuanceId: "resume:rejected", stripeStatus: "not_found" });
      // The expiry of that very session arriving late settles it, and the next sweep resolves the alert.
      sessions.unshift({ id: "cs_rej", status: "expired", subscription: null, metadata: { home_id: "home-1", issuance_id: "resume:rejected" } });
      at(NOW + 31 * 3_600_000); await sweep(); // (its backoff after the last attempt, Astra JOURNEY-A-4 #3)
      expect(await consentRow()).toMatchObject({ session_inflight_at: null });
      expect(await alerts()).toBe(0);
    });
    /** A copy of the home's consent under another id, with its own marker (another unresolved session request of the same home). */
    const cloneConsent = async (from: string, id: string, iss: string, atMs: number) => {
      const row = (await env.DB.prepare("SELECT * FROM checkout_consents WHERE id=?").bind(from).first<Record<string, unknown>>())!;
      const r: Record<string, unknown> = { ...row, id, stripe_session_id: null, stripe_subscription_id: null, session_inflight_at: atMs, session_issuance_id: iss };
      const k = Object.keys(r);
      await env.DB.prepare(`INSERT INTO checkout_consents (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).bind(...k.map((x) => r[x])).run();
    };
    const markerOf = (id: string) => env.DB.prepare(`SELECT c.session_inflight_at AS at,c.session_issuance_id AS iss,s.last_attempt_at AS last,s.next_attempt_at AS next
      FROM checkout_consents c LEFT JOIN checkout_marker_schedule s ON s.consent_id=c.id AND s.issuance_id=COALESCE(c.session_issuance_id,'') WHERE c.id=?`)
      .bind(id).first<{ at: number | null; iss: string | null; last: number | null; next: number | null }>();
    it("Astra JOURNEY-A-4 #3: twenty permanently missing sessions never starve a newer marker of its reconciliation or its 6-hour alert", async () => {
      await order();
      const consentId = (await consentRow())!.id as string;
      const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      for (let i = 0; i < 20; i++) await cloneConsent(consentId, `old-${i}`, `resume:missing-${i}`, NOW - DAY + i);
      // A newer request whose session Stripe shows expired (its webhook was lost).
      await cloneConsent(consentId, "newer", "resume:newer", NOW);
      sessions.unshift({ id: "cs_newer", status: "expired", subscription: null, metadata: { home_id: "home-1", issuance_id: "resume:newer" } });
      at(NOW + 20 * 60_000); await sweep();
      // The 20 oldest were tried (each stamped, with its backoff); the newer one waited this pass.
      expect(await markerOf("old-0")).toMatchObject({ iss: "resume:missing-0", last: NOW + 20 * 60_000, next: NOW + 25 * 60_000 });
      expect(await markerOf("newer")).toMatchObject({ iss: "resume:newer", last: null });
      at(NOW + 21 * 60_000); await sweep();
      // The old ones wait their backoff: the newer one is reconciled (it used to wait for ever behind them).
      expect(await markerOf("newer")).toMatchObject({ at: null, iss: null });
      // A later request Stripe cannot resolve still gets its 6-hour alert while the twenty keep failing.
      const lateAt = NOW + 21 * 60_000;
      await cloneConsent(consentId, "late", "resume:late", lateAt);
      for (const t of [lateAt + 20 * 60_000, lateAt + 6 * 3_600_000 + 60_000, lateAt + 6 * 3_600_000 + 2 * 60_000]) { at(t); await sweep(); }
      // (One open alert per home: the late request joins it.)
      const open = await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='home.checkout_unresolved' AND resolved_at IS NULL").all<{ detail: string }>();
      expect(open.results).toHaveLength(1);
      expect((JSON.parse(open.results[0].detail) as { issuances: string[] }).issuances).toContain("resume:late");
    });
    it("Astra JOURNEY-A-4 #5: every settlement reconciles the home's alert: kept while another request is unresolved, resolved with the last", async () => {
      await order();
      const consentId = (await consentRow())!.id as string;
      const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      const open = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='home.checkout_unresolved' AND resolved_at IS NULL");
      await env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=?,session_issuance_id='resume:a' WHERE id=?").bind(NOW, consentId).run();
      await cloneConsent(consentId, "other", "resume:b", NOW);
      const issuances = async () => (JSON.parse((await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='home.checkout_unresolved' AND resolved_at IS NULL").first<{ detail: string }>())!.detail) as { issuances: string[] }).issuances;
      at(NOW + 7 * 3_600_000); await sweep();
      expect(await open()).toBe(1); // the home's one open alert names both unresolved requests
      expect((await issuances()).sort()).toEqual(["resume:a", "resume:b"]);
      const expired = (id: string, consent: string, issuance: string) => stripeEvent("checkout.session.expired", { object: "checkout.session", id, mode: "subscription",
        customer: "cus_test1", client_reference_id: "home-1", created: NOW / 1000, metadata: { home_id: "home-1", consent_id: consent, issuance_id: issuance } });
      // The expiry webhook settles "a": "b" is still unresolved, so the home's alert stays.
      expect((await hook(expired("cs_a", consentId, "resume:a"))).status).toBe(200);
      expect(await markerOf(consentId)).toMatchObject({ at: null });
      expect(await open()).toBe(1);
      expect(await issuances()).toEqual(["resume:b"]);
      // The completion of "b" (recorded) settles the last one: the alert is resolved in that same transaction, no sweep needed.
      await env.DB.prepare("UPDATE checkout_consents SET contract_made_at=? WHERE id='other'").bind(NOW).run();
      expect((await hook(expired("cs_b", "other", "resume:b"))).status).toBe(200);
      expect(await markerOf("other")).toMatchObject({ at: NOW }); // a submitted checkout is never settled by an expiry
      await env.DB.prepare("UPDATE checkout_consents SET contract_made_at=NULL WHERE id='other'").run();
      expect((await hook(expired("cs_b", "other", "resume:b"))).status).toBe(200);
      expect(await markerOf("other")).toMatchObject({ at: null });
      expect(await open()).toBe(0);
    });
    it("Astra JOURNEY-A-4 #2: a pre-upgrade attempt is an explicit unresolved-legacy marker; it settles only once Stripe shows its sessions terminal", async () => {
      await order();
      const consentId = (await consentRow())!.id as string;
      const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      // Pre-upgrade shape: the session request's answer never recorded (no session id), no evidence columns, an attempt still 'creating'.
      await env.DB.prepare(`UPDATE checkout_consents SET stripe_session_id=NULL,session_inflight_at=NULL,session_issuance_id=NULL,session_expired_at=NULL WHERE id=?`).bind(consentId).run();
      await env.DB.prepare("UPDATE open_checkouts SET state='creating',session_id=NULL WHERE consent_id=?").bind(consentId).run();
      // Migration 0093's legacy statement marks it (never "never issued").
      const legacy = m0093.split(";").map((x) => x.replace(/^\s*(--[^\n]*\n\s*)*/g, "").trim()).find((x) => x.startsWith("UPDATE checkout_consents SET session_inflight_at=created_at"))!;
      expect(legacy).toBeTruthy();
      await env.DB.prepare(legacy).run();
      expect(await markerOf(consentId)).toMatchObject({ iss: `legacy:${consentId}` });
      expect(await env.DB.prepare(`SELECT ${CHECKOUT_MAY_SETTLE_SQL.replaceAll("cloud_homes.id", "'home-1'")} AS open`).first()).toEqual({ open: 1 });
      // At Stripe: an OPEN session of this consent with no issuance metadata (created before issuance ids), and an unrelated consent's session.
      sessions.splice(0, sessions.length,
        { id: "cs_legacy", status: "open", subscription: null, metadata: { home_id: "home-1", consent_id: consentId } },
        { id: "cs_unrelated", status: "complete", subscription: "sub_u", metadata: { home_id: "home-1", consent_id: "someone-else" } });
      // Its expiry webhook alone does not settle the legacy marker (no issuance id); it only makes the marker due for reconciliation.
      at(NOW + 20 * 60_000);
      expect((await hook(stripeEvent("checkout.session.expired", { object: "checkout.session", id: "cs_legacy_old", mode: "subscription", customer: "cus_test1",
        client_reference_id: "home-1", created: NOW / 1000, metadata: { home_id: "home-1", consent_id: consentId } }))).status).toBe(200);
      expect(await markerOf(consentId)).toMatchObject({ iss: `legacy:${consentId}`, next: 0 });
      // Reconciled: the open session is expired at Stripe first, then (every session of the consent terminal) the marker settles.
      at(NOW + 2 * 3_600_000); await sweep();
      expect(sessions.find((x) => x.id === "cs_legacy")!.status).toBe("expired");
      expect(await markerOf(consentId)).toMatchObject({ at: null, iss: null });
      expect(await env.DB.prepare(`SELECT ${CHECKOUT_MAY_SETTLE_SQL.replaceAll("cloud_homes.id", "'home-1'")} AS open`).first()).toEqual({ open: 0 });
      // A legacy marker whose consent's session completed but whose completion was never recorded stays unresolved (a payment may be coming).
      sessions.splice(0, sessions.length, { id: "cs_paid_legacy", status: "complete", subscription: "sub_l", metadata: { home_id: "home-1", consent_id: consentId } });
      await env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=?,session_issuance_id=? WHERE id=?").bind(NOW, `legacy:${consentId}`, consentId).run();
      at(NOW + 8 * 3_600_000); await sweep();
      expect(await markerOf(consentId)).toMatchObject({ at: NOW, iss: `legacy:${consentId}` });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='home.checkout_unresolved' AND resolved_at IS NULL")).toBe(1);
    });
    /** The A-4 #2 pre-upgrade shape: a legacy marker, no recorded session, an attempt still creating. */
    const legacyMarker = async (consentId: string) => {
      await env.DB.prepare(`UPDATE checkout_consents SET stripe_session_id=NULL,session_inflight_at=?,session_issuance_id=?,session_expired_at=NULL WHERE id=?`)
        .bind(NOW, `legacy:${consentId}`, consentId).run();
      await env.DB.prepare("UPDATE open_checkouts SET state='creating',session_id=NULL WHERE consent_id=?").bind(consentId).run();
    };
    const mayNotRetire = async () => (await env.DB.prepare(`SELECT ${CHECKOUT_MAY_SETTLE_SQL.replaceAll("cloud_homes.id", "'home-1'")} AS open`).first<{ open: number }>())!.open;
    const openAlert = async () => (await env.DB.prepare("SELECT id,detail,delivered_at FROM cloud_alerts WHERE kind='home.checkout_unresolved' AND resolved_at IS NULL")
      .all<{ id: string; detail: string; delivered_at: number | null }>()).results;
    it("Astra JOURNEY-A-5 #4: a lost customer row keeps a legacy marker unresolved (alerted); a stored attempt's session recovers it, then terminal evidence settles it", async () => {
      await order();
      const consentId = (await consentRow())!.id as string;
      const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      await legacyMarker(consentId);
      sessions.splice(0, sessions.length, { id: "cs_known", status: "open", subscription: null, metadata: { home_id: "home-1" } });
      // The home's billing row (its Stripe customer) is gone, and the consent names no subscription.
      await env.DB.prepare("DELETE FROM billing_subscriptions WHERE home_id='home-1'").run();
      await env.DB.prepare("UPDATE checkout_consents SET stripe_subscription_id=NULL WHERE id=?").bind(consentId).run();
      at(NOW + 20 * 60_000); await sweep();
      // Never "no customer, so no session": unresolved, the home may not retire, and ops is told at once.
      expect(await markerOf(consentId)).toMatchObject({ at: NOW, iss: `legacy:${consentId}` });
      expect(await mayNotRetire()).toBe(1);
      const [a] = await openAlert();
      expect(JSON.parse(a.detail)).toMatchObject({ consentId, stripeStatus: "customer_unrecoverable", legacy: true });
      // The attempt's durable session id recovers the customer; that session (no consent metadata, but recorded for this consent) is open:
      // it is expired at Stripe first, and only then does the marker settle.
      await env.DB.prepare("UPDATE open_checkouts SET session_id='cs_known' WHERE consent_id=?").bind(consentId).run();
      at(NOW + 2 * 3_600_000); await sweep();
      expect(sessions.find((x) => x.id === "cs_known")!.status).toBe("expired");
      expect(await markerOf(consentId)).toMatchObject({ at: null, iss: null });
      expect(await openAlert()).toEqual([]);
    });
    it("Astra JOURNEY-A-5 #4: an open session naming no consent keeps the legacy marker unresolved until it is terminal", async () => {
      await order();
      const consentId = (await consentRow())!.id as string;
      const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      await legacyMarker(consentId);
      // Uncorrelated: no consent_id, no issuance_id, not a session this consent is recorded with. It may be this consent's: never expired on a
      // guess, and never ignored.
      sessions.splice(0, sessions.length, { id: "cs_orphan", status: "open", subscription: null, metadata: { home_id: "home-1" } });
      at(NOW + 20 * 60_000); await sweep();
      expect(await markerOf(consentId)).toMatchObject({ at: NOW, iss: `legacy:${consentId}` });
      expect(sessions[0].status).toBe("open");
      expect(await mayNotRetire()).toBe(1);
      sessions[0].status = "expired";
      at(NOW + 2 * 3_600_000); await sweep();
      expect(await markerOf(consentId)).toMatchObject({ at: null, iss: null });
      expect(await mayNotRetire()).toBe(0);
    });
    it("Astra JOURNEY-A-6 #5: a consent's one recorded, paid checkout never makes an uncorrelated completed session terminal", async () => {
      await order();
      const consentId = (await consentRow())!.id as string;
      const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      await legacyMarker(consentId);
      // The consent's checkout was completed and paid, recorded for ITS session (cs_paid); another completed session names no consent.
      await env.DB.prepare("UPDATE checkout_consents SET stripe_session_id='cs_paid',contract_made_at=?,paid_at=? WHERE id=?").bind(NOW, NOW, consentId).run();
      sessions.splice(0, sessions.length,
        { id: "cs_paid", status: "complete", subscription: "sub_test1", metadata: { home_id: "home-1", consent_id: consentId } },
        { id: "cs_orphan_done", status: "complete", subscription: "sub_orphan", metadata: { home_id: "home-1" } });
      at(NOW + 20 * 60_000); await sweep();
      // The consent's single contract_made_at stands for cs_paid only: the uncorrelated completion has no evidence of its own, unresolved.
      expect(await markerOf(consentId)).toMatchObject({ at: NOW, iss: `legacy:${consentId}` });
      // Its own disposition recorded (its order refused for good, the subscription tombstoned for this home): every session is now terminal.
      await env.DB.prepare("INSERT INTO rejected_subscriptions (subscription_id,at,reason,home_id) VALUES ('sub_orphan',?,'duplicate','home-1')").bind(NOW).run();
      at(NOW + 2 * 3_600_000); await sweep();
      expect(await markerOf(consentId)).toMatchObject({ at: null, iss: null });
    });
    it("Astra JOURNEY-A-7 #4: a modern (issuance) marker settles only on its OWN session's disposition, never on the consent's contract_made_at", async () => {
      await order();
      const consentId = (await consentRow())!.id as string;
      const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      // The consent's checkout was completed and paid for ITS session (cs_paid); a later issuance of the same consent is still in flight.
      await env.DB.prepare("UPDATE checkout_consents SET stripe_session_id='cs_paid',contract_made_at=?,paid_at=?,session_inflight_at=?,session_issuance_id='iss_modern' WHERE id=?")
        .bind(NOW, NOW, NOW, consentId).run();
      // At Stripe, that issuance's session completed too, but nothing recorded its completion or payment.
      sessions.splice(0, sessions.length,
        { id: "cs_paid", status: "complete", subscription: "sub_test1", metadata: { home_id: "home-1", consent_id: consentId } },
        { id: "cs_other", status: "complete", subscription: "sub_other", metadata: { home_id: "home-1", consent_id: consentId, issuance_id: "iss_modern" } });
      at(NOW + 20 * 60_000); await sweep();
      // c.made alone is no evidence for cs_other: unresolved, and the home may not retire.
      expect(await markerOf(consentId)).toMatchObject({ at: NOW, iss: "iss_modern" });
      expect(await mayNotRetire()).toBe(1);
      // Its own disposition (the order refused for good, its subscription tombstoned for this home) settles it.
      await env.DB.prepare("INSERT INTO rejected_subscriptions (subscription_id,at,reason,home_id) VALUES ('sub_other',?,'duplicate','home-1')").bind(NOW).run();
      at(NOW + 2 * 3_600_000); await sweep();
      expect(await markerOf(consentId)).toMatchObject({ at: null, iss: null });
      // An issuance whose OWN session is the recorded, paid one settles on that evidence.
      await env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=?,session_issuance_id='iss_paid' WHERE id=?").bind(NOW, consentId).run();
      sessions.splice(0, sessions.length, { id: "cs_paid", status: "complete", subscription: "sub_test1", metadata: { home_id: "home-1", consent_id: consentId, issuance_id: "iss_paid" } });
      at(NOW + 4 * 3_600_000); await sweep();
      expect(await markerOf(consentId)).toMatchObject({ at: null, iss: null });
    });
    it("Astra JOURNEY-A-5 #5: a fetch rejection or a busy home still raises the six-hour alert", async () => {
      await order();
      const consentId = (await consentRow())!.id as string;
      const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      await env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=?,session_issuance_id='resume:lost' WHERE id=?").bind(NOW, consentId).run();
      // Stripe's listing rejects (a transport failure, not a Stripe error) on every attempt.
      sessionListThrows = true;
      at(NOW + 7 * 3_600_000); await sweep();
      expect((await openAlert()).map((x) => JSON.parse(x.detail) as { issuances: string[] }).map((d) => d.issuances)).toEqual([["resume:lost"]]);
      // Ops closes the incident while the request is still unresolved, and the home is busy (another worker holds its lease, so nothing is
      // reconciled): the escalation is evaluated all the same, and the incident is open again.
      await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE kind='home.checkout_unresolved'").bind(NOW + 7 * 3_600_000).run();
      const held = await acquireHomeLease(env, "home-1", "someone-else");
      expect(held).not.toBeNull();
      sessionListThrows = false;
      at(NOW + 9 * 3_600_000); await sweep();
      const reopened = await openAlert();
      expect(reopened).toHaveLength(1);
      expect(JSON.parse(reopened[0].detail)).toMatchObject({ consentId, issuances: ["resume:lost"] });
      expect(await markerOf(consentId)).toMatchObject({ at: NOW, iss: "resume:lost" });
      await releaseHomeLease(env, held!);
    });
    it("Astra JOURNEY-A-5 #6: settling the alerted request while a younger one remains lists the younger one (never []), and delivers again", async () => {
      await order();
      const consentId = (await consentRow())!.id as string;
      const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      await env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=?,session_issuance_id='resume:old' WHERE id=?").bind(NOW, consentId).run();
      at(NOW + 7 * 3_600_000); await sweep();
      // A younger request, not overdue, that was not part of the alert when it was raised.
      await cloneConsent(consentId, "young", "resume:young", NOW + 6 * 3_600_000);
      await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=? WHERE kind='home.checkout_unresolved'").bind(NOW + 7 * 3_600_000).run();
      const expired = stripeEvent("checkout.session.expired", { object: "checkout.session", id: "cs_old", mode: "subscription", customer: "cus_test1",
        client_reference_id: "home-1", created: NOW / 1000, metadata: { home_id: "home-1", consent_id: consentId, issuance_id: "resume:old" } });
      expect((await hook(expired)).status).toBe(200);
      expect(await markerOf(consentId)).toMatchObject({ at: null });
      const [a] = await openAlert();
      expect(JSON.parse(a.detail)).toMatchObject({ issuances: ["resume:young"] });
      expect(a.delivered_at).toBeNull(); // membership changed: notification requeued
    });
  });

  describe("Test 4: the guard, the switch and the dropdown", () => {
    it("two mismatch rejections on one home: both refunded, ONE open alert naming both orders (Astra WP5-7 #5)", async () => {
      await order("DE");
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj({ customer_details: { address: { country: "AT" } } })))).status).toBe(200);
      const firstConsent = (await consentRow())!.id as string;
      invoiceSubs = { in_two: "sub_two" };
      expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200); // the home is already reserved
      const secondConsent = (await consentRow())!.id as string;
      expect(secondConsent).not.toBe(firstConsent);
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj({ id: "cs_two", subscription: "sub_two", invoice: "in_two",
        customer_details: { address: { country: "AT" } } })))).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='mismatch'")).toBe(2);
      const rows = (await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='checkout.mismatch' AND resolved_at IS NULL").all<{ detail: string }>()).results;
      expect(rows).toHaveLength(1);
      const d = JSON.parse(rows[0].detail) as { consentIds: string[]; items: { opId: string }[]; revision: number };
      expect([...d.consentIds].sort()).toEqual([firstConsent, secondConsent].sort());
      expect(d.items.map((x) => x.opId).sort()).toEqual(["mismatch:in_1", "mismatch:in_two"]);
      expect(d.revision).toBe(1);
    });
    it("declared DE but billed AT: a mismatch refund through the ledger, the subscription cancelled, the retry route and the email; nothing provisioned", async () => {
      await order("DE");
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj({ customer_details: { address: { country: "AT" } } })))).status).toBe(200);
      expect(await env.DB.prepare("SELECT kind,amount_cents AS a FROM refund_ops").first()).toMatchObject({ kind: "mismatch", a: 4900 });
      expect(refundPosts().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(subDeletes()).toHaveLength(1);
      expect(subDeletes()[0].form.get("prorate")).toBe("false"); expect(subDeletes()[0].form.get("invoice_now")).toBe("false");
      expect(await inbox()).toBe(0);
      expect(await consentRow()).toMatchObject({ rejected_reason: "mismatch", paid_at: null });
      expect(await env.DB.prepare("SELECT collected_country AS c, reason AS r, seller FROM checkout_retry_routes").first()).toEqual({ c: "AT", r: "mismatch", seller: "link" });
      const mail = notices.find((n) => n.kind === "order_rejected")!.data as { emailText: string };
      // WP5 r1-8: the email never says "we refunded" before the ledger does: it says the refund is under way and where it stands.
      expect(mail.emailText).toContain("Die eingegebene Rechnungsadresse (Österreich) passt nicht zu dem Land, das Sie gewählt haben (Deutschland). Deshalb wurde Ihre Bestellung storniert. Wir erstatten Ihre Zahlung vollständig. Ihre Erstattung:");
      expect(mail.emailText).not.toContain("We refunded");
      // The account page route: the next reserve pre-fills the country line with Stripe's country.
      signedIn = OWNER;
      expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ retryCountry: "AT" });
      // Later events of the cancelled subscription change nothing.
      expect(await (await hook(stripeEvent("invoice.paid", invoice()))).json()).toMatchObject({ received: true });
      expect(await inbox()).toBe(0);
      expect((await checkout("starter", { billingCountry: "AT", earlyStart: true })).status).toBe(200); // the retry is possible
    });
    it("a missing billing country, and a path that does not cover the billing country, are mismatches too", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({ customer_details: { address: { country: null } } })));
      expect(await env.DB.prepare("SELECT kind FROM refund_ops").first()).toEqual({ kind: "mismatch" });
      expect(await count("SELECT COUNT(*) AS n FROM checkout_retry_routes")).toBe(0);
    });
    it("a country paused after the session was created: country_paused refund for a new purchase", async () => {
      await order("FR");
      await env.DB.prepare("INSERT INTO checkout_country_switch (country,state,updated_at) VALUES ('FR','paused',?)").bind(NOW).run();
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      expect(await env.DB.prepare("SELECT kind,amount_cents AS a FROM refund_ops").first()).toEqual({ kind: "country_paused", a: 4900 });
      expect(subDeletes()).toHaveLength(1);
      expect(await inbox()).toBe(0);
      expect((notices.find((n) => n.kind === "order_rejected")!.data as { emailText: string }).emailText).toContain("We can't take orders from FR right now");
    });
    it("a renewal is never blocked by the switch: a running subscription in a paused country renews, nothing cancelled, voided or refunded", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      await hook(stripeEvent("invoice.paid", invoice()));
      await env.DB.prepare("INSERT INTO checkout_country_switch (country,state,updated_at) VALUES ('FR','paused',?)").bind(NOW).run();
      at(NOW + 30 * DAY);
      const renewal = invoice({ id: "in_2", billing_reason: "subscription_cycle",
        lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 } }] } });
      expect((await hook(stripeEvent("invoice.paid", renewal, (NOW + 30 * DAY) / 1000))).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(subDeletes()).toHaveLength(0);
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions")).toBe(0);
      expect(await env.DB.prepare("SELECT error FROM stripe_events WHERE type='invoice.paid' ORDER BY received_at DESC LIMIT 1").first()).toEqual({ error: null });
    });
    it("the renewal dropdown untouched: no completion is accepted. Subscription deleted (no proration), rejected_consent refund, consent rejected, tombstone, no provisioning, alert", async () => {
      await order("FR");
      for (const fields of [[], [{ key: "renewalconsent", type: "dropdown", dropdown: { value: null } }]]) {
        await env.DB.prepare("DELETE FROM refund_ops").run(); await env.DB.prepare("DELETE FROM refund_invoice_ledger").run(); await env.DB.prepare("DELETE FROM rejected_subscriptions").run();
        await env.DB.prepare("UPDATE checkout_consents SET rejected_at=NULL, rejected_reason=NULL").run(); stripeCalls = [];
        expect((await hook(stripeEvent("checkout.session.completed", await sessionObj({ custom_fields: fields })))).status).toBe(200);
        expect(await env.DB.prepare("SELECT kind,amount_cents AS a FROM refund_ops").first()).toEqual({ kind: "rejected_consent", a: 4900 });
        expect(subDeletes()).toHaveLength(1);
        expect(subDeletes()[0].form.get("prorate")).toBe("false"); expect(subDeletes()[0].form.get("invoice_now")).toBe("false");
        expect(await consentRow()).toMatchObject({ rejected_reason: "rejected_consent", paid_at: null });
        expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions WHERE subscription_id='sub_test1'")).toBe(1);
        expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.rejected_consent'")).toBeGreaterThan(0);
        expect(await inbox()).toBe(0);
      }
      // The tombstone ignores everything that follows.
      for (const ev of [stripeEvent("invoice.paid", invoice()), stripeEvent("customer.subscription.updated", { object: "subscription", id: "sub_test1", customer: "cus_test1", status: "active", items: { data: [] } })]) {
        expect(await (await hook(ev)).json()).toMatchObject({ received: true });
      }
      expect(await inbox()).toBe(0);
      expect(refundPosts().length).toBeLessThanOrEqual(1); // the second pass is settled by the payment's existing refund, never paid twice
    });
    it("a payment that clears after the order was rejected is refunded in full, once", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({ custom_fields: [] }, "unpaid")));
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0); // nothing was paid yet
      expect(subDeletes()).toHaveLength(1);
      await hook(stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({ custom_fields: [] }, "paid")));
      expect(await env.DB.prepare("SELECT kind,amount_cents AS a FROM refund_ops").first()).toEqual({ kind: "rejected_consent", a: 4900 });
      expect(await inbox()).toBe(0);
    });
    it("a retried completion of an order the guard already turned away stays rejected, whatever the switch says now", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({ custom_fields: [] })));
      const retry = stripeEvent("checkout.session.completed", await sessionObj({ custom_fields: RENEWAL_YES }));
      await hook(retry);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(1);
      expect(await inbox()).toBe(0);
    });
    it("an accepted order is never re-judged by a retried event after its country is paused", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      await env.DB.prepare("INSERT INTO checkout_country_switch (country,state,updated_at) VALUES ('FR','paused',?)").bind(NOW).run();
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj()))).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect((await consentRow())!.rejected_at).toBeNull();
      expect(await inbox()).toBeGreaterThanOrEqual(1);
    });
    it("with every switch open no order is refused for where the customer lives (DE, AT, FR, IS, NO, GB)", async () => {
      managed(); await reserve();
      for (const c of ["DE", "AT", "FR", "IS", "NO", "GB"]) {
        await env.DB.prepare("DELETE FROM open_checkouts").run(); await env.DB.prepare("DELETE FROM rejected_subscriptions").run();
        await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id=NULL, status='canceled'").run();
        expect((await checkout("starter", { billingCountry: c, earlyStart: true })).status).toBe(200);
        await hook(stripeEvent("checkout.session.completed", await sessionObj({ customer_details: { address: { country: c } } }, "unpaid")));
        expect((await consentRow())!.rejected_at).toBeNull();
      }
    });
  });

  describe("renewal disclosure on Stripe's page (owner decision 2026-10-14, plan §3.2, option 1): the webhook requires the journaled consent record", () => {
    // The session exactly as our checkout created it: its metadata from the Stripe request we sent, the Managed Payments dropdown answered
    // (FR goes to Link here), Stripe's creation second no earlier than the consent's, and the REAL line item Stripe reports for it.
    const sentSession = () => [...stripeCalls].reverse().find((c) => c.method === "POST" && c.path === "/v1/checkout/sessions")!;
    const lineItem = (over: Record<string, unknown> = {}) => ({ object: "item", quantity: 1,
      price: { id: PRICES.STRIPE_PRICE_STARTER, currency: "usd", unit_amount: 4900, recurring: { interval: "month", interval_count: 1 }, ...over } });
    const newSession = async (meta: Record<string, unknown> = {}, over: Record<string, unknown> = {}, status = "paid") => {
      const f = sentSession().form;
      const consent = (await consentRow())!;
      retrievable["/v1/checkout/sessions/cs_test_1/line_items"] ??= { object: "list", data: [lineItem()], has_more: false };
      return { ...(await sessionObj({}, status)), custom_fields: f.get("metadata[seller]") === "link" ? RENEWAL_YES : undefined,
        created: Math.floor(Number(consent.created_at) / 1000),
        metadata: { home_id: f.get("metadata[home_id]"), plan: f.get("metadata[plan]"), price_id: f.get("metadata[price_id]"), seller: f.get("metadata[seller]"),
          consent_id: f.get("metadata[consent_id]"), renewal_sha256: f.get("metadata[renewal_sha256]"), ...meta }, ...over };
    };
    const refusedWithTombstone = async () => {
      expect(await env.DB.prepare("SELECT kind,amount_cents AS a FROM refund_ops").first()).toEqual({ kind: "rejected_consent", a: 4900 });
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions WHERE subscription_id='sub_test1'")).toBe(1);
      expect(subDeletes()).toHaveLength(1);
      expect(await inbox()).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.rejected_consent'")).toBeGreaterThan(0);
    };
    it("direct: no custom_fields, the renewal sentence + links in custom_text; Managed Payments: the dropdown, no custom_text; both name consent, hash, plan and price", async () => {
      for (const declared of ["FR", "US"]) {
        await env.DB.prepare("DELETE FROM open_checkouts").run();
        if (declared === "FR") await order("FR"); else expect((await checkout("starter", { billingCountry: "US" })).status).toBe(200);
        const f = sentSession().form;
        const direct = declared === "US";
        expect(f.get("metadata[seller]")).toBe(direct ? "ferrox" : "link");
        const c = (await consentRow())!;
        expect(f.get("metadata[consent_id]")).toBe(c.id);
        expect(f.get("metadata[renewal_sha256]")).toBe(renewalSha256(c.renewal_text as string));
        expect(f.get("metadata[plan]")).toBe("starter"); expect(f.get("metadata[price_id]")).toBe(PRICES.STRIPE_PRICE_STARTER);
        expect(c.recurring_authorized).toBe(1);
        const fields = [...f.keys()].filter((k) => k.startsWith("custom_fields"));
        if (direct) {
          expect(fields).toEqual([]);
          expect(f.get("custom_text[submit][message]")).toMatch(/^Renews each month at US\$49 \+ tax until you cancel in your account\. By submitting your order you agree to the \[Murage Cloud terms\]\(/);
          expect(JSON.parse(c.disclosure as string)).toMatchObject({ stripePage: { variant: "direct_text", version: STRIPE_PAGE_VERSION, renewalDropdown: false,
            submitMessage: expect.stringMatching(/^Renews each month at US\$49 \+ tax/), authorization: "clickwrap_consent_record" } });
        } else {
          expect(f.get("custom_text[submit][message]")).toBeNull();
          expect(f.get("custom_fields[0][label][custom]")).toBe("Your plan renews each month at the total shown until you cancel in your account.");
          expect(f.get("custom_fields[0][dropdown][options][0][label]")).toBe("OK, renew monthly until I cancel (in my currency with tax; exchange rates can change the amount)");
          expect(fields.some((k) => k.includes("default_value"))).toBe(false);
          expect(JSON.parse(c.disclosure as string)).toMatchObject({ stripePage: { variant: "mp_dropdown", version: STRIPE_PAGE_VERSION, renewalDropdown: true,
            dropdownLabel: "Your plan renews each month at the total shown until you cancel in your account.", dropdownDefault: null } });
        }
      }
    });
    it("a matching consent record (and, on Managed Payments, the answered dropdown): the order proceeds, judged on Stripe's real line items", async () => {
      await order("FR");
      expect((await hook(stripeEvent("checkout.session.completed", await newSession()))).status).toBe(200);
      expect(stripeCalls.some((c) => c.method === "GET" && c.path === "/v1/checkout/sessions/cs_test_1/line_items")).toBe(true);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions")).toBe(0);
      expect((await consentRow())!).toMatchObject({ rejected_at: null, stripe_session_id: "cs_test_1", stripe_subscription_id: "sub_test1" });
      expect(await inbox()).toBeGreaterThanOrEqual(1);
    });
    it("direct (US): a matching consent record without any dropdown: the order proceeds", async () => {
      await reserve(); expect((await checkout("starter", { billingCountry: "US" })).status).toBe(200);
      const s = await newSession({}, { customer_details: { address: { country: "US" } } });
      expect(s.custom_fields).toBeUndefined();
      expect((await hook(stripeEvent("checkout.session.completed", s))).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions")).toBe(0);
      expect((await consentRow())!.rejected_at).toBeNull();
    });
    const cases: [string, () => Promise<{ meta?: Record<string, unknown>; over?: Record<string, unknown> }>][] = [
      ["no consent id in the metadata (judged against the consent bound to the session)", async () => ({ meta: { consent_id: undefined } })],
      ["an unknown consent id", async () => ({ meta: { consent_id: "consent-nope" } })],
      ["no renewalText hash (and no dropdown: not a legacy session)", async () => ({ meta: { renewal_sha256: undefined }, over: { custom_fields: undefined } })],
      ["a hash of other words", async () => ({ meta: { renewal_sha256: renewalSha256("Something else") } })],
      ["another plan", async () => ({ meta: { plan: "max" } })],
      ["another price", async () => ({ meta: { price_id: PRICES.STRIPE_PRICE_MAX } })],
      ["another seller path", async () => ({ meta: { seller: "ferrox" } })],
      ["a consent written after the session", async () => ({ over: { created: Math.floor(Number((await consentRow())!.created_at) / 1000) - 60 } })],
      ["Managed Payments without the dropdown answered", async () => ({ over: { custom_fields: [{ key: "renewalconsent", type: "dropdown", dropdown: { value: null } }] } })],
      ["Managed Payments without the dropdown at all", async () => ({ over: { custom_fields: undefined } })],
      ["the real line item is another price, whatever the metadata says", async () => {
        retrievable["/v1/checkout/sessions/cs_test_1/line_items"] = { object: "list", data: [lineItem({ id: PRICES.STRIPE_PRICE_MAX, unit_amount: 14900 })], has_more: false };
        return {};
      }],
      ["the real line item is yearly", async () => {
        retrievable["/v1/checkout/sessions/cs_test_1/line_items"] = { object: "list", data: [lineItem({ recurring: { interval: "year", interval_count: 1 } })], has_more: false };
        return {};
      }],
    ];
    for (const [why, mk] of cases) {
      it(`refused with tombstone and no entitlement: ${why}`, async () => {
        await order("FR");
        const { meta, over } = await mk();
        expect((await hook(stripeEvent("checkout.session.completed", await newSession(meta ?? {}, over ?? {})))).status).toBe(200);
        await refusedWithTombstone();
        // judged BEFORE anything was attached (Astra NO-DROPDOWN-1 (3)): no completion, no acceptance, the session binding untouched
        expect(await consentRow()).toMatchObject({ rejected_reason: "rejected_consent", paid_at: null, completed_at: null, stripe_session_id: "cs_test_1" });
        expect(await count("SELECT COUNT(*) AS n FROM terms_acceptances WHERE source='checkout' AND consent_id=?", (await consentRow())!.id)).toBeLessThanOrEqual(1);
      });
    }
    for (const [why, sql] of [["not authorized for recurring payment", "UPDATE checkout_consents SET recurring_authorized=0"],
      ["made by another account", "UPDATE checkout_consents SET user_id='someone-else'"],
      ["bound to another session", "UPDATE checkout_consents SET stripe_session_id='cs_other'"]] as const) {
      it(`refused with tombstone and no entitlement: the consent row is ${why}`, async () => {
        await order("FR");
        const s = await newSession();
        await env.DB.prepare(sql).run();
        expect((await hook(stripeEvent("checkout.session.completed", s))).status).toBe(200);
        await refusedWithTombstone();
      });
    }
    it("refused: the metadata names another home's consent (the session's own record is tombstoned and refunded)", async () => {
      await order("FR");
      const own = await newSession();
      const mine = (await consentRow())!.id as string;
      // a copy of the consent under another home, as if the metadata pointed at it
      const row: Record<string, unknown> = { ...(await env.DB.prepare("SELECT * FROM checkout_consents WHERE id=?").bind(mine).first<Record<string, unknown>>())!,
        id: "consent-foreign", home_id: "home-other", stripe_session_id: null };
      const cols = Object.keys(row);
      await env.DB.prepare(`INSERT INTO checkout_consents (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((k) => row[k] ?? null)).run();
      // the session is bound to this home's own consent (stripe_session_id written at creation)
      expect(await env.DB.prepare("SELECT stripe_session_id AS s FROM checkout_consents WHERE id=?").bind(mine).first()).toEqual({ s: "cs_test_1" });
      expect((await hook(stripeEvent("checkout.session.completed", { ...own, metadata: { ...own.metadata, consent_id: "consent-foreign" } }))).status).toBe(200);
      await refusedWithTombstone();
      expect(await env.DB.prepare("SELECT rejected_reason AS r FROM checkout_consents WHERE id=?").bind(mine).first()).toEqual({ r: "rejected_consent" });
      expect(await env.DB.prepare("SELECT rejected_reason AS r FROM checkout_consents WHERE id='consent-foreign'").first()).toEqual({ r: null });
    });
    it("refused: no consent at all names or is bound to the session (never a live subscription; tombstoned, refunded, alerted, no throw)", async () => {
      await order("FR");
      const s = await newSession({ consent_id: "consent-nope" }, { id: "cs_foreign" });
      expect((await hook(stripeEvent("checkout.session.completed", s))).status).toBe(200);
      await refusedWithTombstone();
      expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_voids WHERE payment_id IN ('in_1','cs_foreign')")).toBe(2);
      // the home's own consent is untouched
      expect(await consentRow()).toMatchObject({ rejected_at: null, completed_at: null });
    });
    for (const order2 of ["completed, then async_payment_succeeded", "async_payment_succeeded first (retried), then completed", "completed, then invoice.paid"] as const) {
      it(`Astra DROPDOWN-DIRECT-1 (3), ${order2}: an unbound Managed Payments refusal is refunded on the MP route (the seller path persisted with it), never the direct credit note`, async () => {
        await order("FR"); // Managed Payments
        creditNotesOn = true; // a credit note would be made (and seen) if the direct route were taken
        const s = { ...(await newSession({ consent_id: "consent-nope" }, {}, "unpaid")), id: "cs_foreign" };
        expect(s.metadata.seller).toBe("link");
        const completed = () => hook(stripeEvent("checkout.session.completed", s));
        const succeeded = stripeEvent("checkout.session.async_payment_succeeded", { ...s, payment_status: "paid" });
        if (order2.startsWith("async")) {
          expect((await hook(succeeded)).status).toBe(500); // no consent and no refusal yet: kept and retried
          expect((await completed()).status).toBe(200);
          at(NOW + 10 * 60_000); await sweepBilling(baseEnv(), deps()).catch(() => undefined);
        } else {
          expect((await completed()).status).toBe(200);
          expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0); // nothing paid yet: cancelled only
          expect(await env.DB.prepare("SELECT reason FROM rejected_subscriptions WHERE subscription_id='sub_test1'").first()).toEqual({ reason: "rejected_consent@mp" });
          if (order2.endsWith("invoice.paid")) expect((await hook(stripeEvent("invoice.paid", invoice()))).status).toBe(200);
          else expect((await hook(succeeded)).status).toBe(200);
        }
        const ops = (await env.DB.prepare("SELECT kind,amount_cents AS a,detail FROM refund_ops").all<{ kind: string; a: number; detail: string }>()).results;
        expect(ops.map((o) => [o.a, JSON.parse(o.detail).path])).toEqual([[4900, "mp"]]);
        expect(refundPosts()).toHaveLength(1);
        expect(stripeCalls.filter((c) => c.path === "/v1/credit_notes" && c.method === "POST")).toHaveLength(0);
        // the home's own consent is untouched
        expect(await consentRow()).toMatchObject({ rejected_at: null });
      });
    }
    for (const paid of [true, false]) {
      it(`Astra DROPDOWN-DIRECT-1 (5): an unbound refusal (${paid ? "paid" : "unpaid"}) journals a neutral rejection notice to the home's account with the true money status`, async () => {
        await order("FR");
        const s = { ...(await newSession({ consent_id: "consent-nope" }, {}, paid ? "paid" : "unpaid")), id: "cs_foreign" };
        expect((await hook(stripeEvent("checkout.session.completed", s))).status).toBe(200);
        // journaled with the refusal (the outbox sends it to the account's contact address), and handed to the notifier
        const row = await env.DB.prepare("SELECT kind,payload FROM billing_notices WHERE kind='order_rejected'").first<{ kind: string; payload: string }>();
        expect(row).not.toBeNull();
        const sent = notices.filter((n) => n.kind === "order_rejected");
        expect(sent).toHaveLength(1);
        const { emailText, emailSubject } = sent[0].data as { emailText: string; emailSubject: string };
        expect(emailSubject).toBe("Murage Cloud: your order was cancelled");
        expect(emailText).toMatch(/^We could not finish your order on our side, so it was cancelled\. /);
        if (paid) expect(emailText).toContain("We are refunding your payment in full.");
        else expect(emailText).toContain("Your payment had not gone through, so nothing was charged. If it still goes through, we refund it in full.");
        expect(emailText).not.toMatch(/renewal|payment page|did not confirm/);
        // the home's own consent is untouched
        expect(await consentRow()).toMatchObject({ rejected_at: null });
      });
    }
    // Astra DROPDOWN-DIRECT-2 (1): paid=true and 4,900 cents, with Stripe's invoice expanded to its object, or not named on the session at all
    // (read back from Stripe, or not there yet): the refund obligation exists and the notice says the money is being refunded.
    for (const shape of ["an expanded invoice object", "no invoice (read back from Stripe)", "no invoice (Stripe has none yet: recovered by the sweep)"] as const) {
      it(`Astra DROPDOWN-DIRECT-2 (1), ${shape}: a paid unbound refusal keeps its refund obligation and never says nothing was charged`, async () => {
        await order("FR");
        const s = { ...(await newSession({ consent_id: "consent-nope" }, {}, "paid")), id: "cs_foreign",
          invoice: shape.startsWith("an expanded") ? { id: "in_1", object: "invoice", amount_paid: 4900 } : null } as Record<string, unknown>;
        expect(s.payment_status).toBe("paid"); expect(s.amount_total).toBe(4900);
        const onStripe = { id: "cs_foreign", object: "checkout.session", invoice: { id: "in_1", object: "invoice" } };
        if (shape.includes("read back")) retrievable["/v1/checkout/sessions/cs_foreign"] = onStripe;
        expect((await hook(stripeEvent("checkout.session.completed", s))).status).toBe(200);
        const op = () => env.DB.prepare("SELECT kind,paid_cents AS p,invoice_id AS i,done_at FROM refund_ops").all<{ kind: string; p: number; i: string | null }>().then((r) => r.results);
        expect((await op()).map((o) => [o.kind, o.p])).toEqual([["rejected_consent", 4900]]);
        const text = (notices.find((n) => n.kind === "order_rejected")!.data as { emailText: string }).emailText;
        expect(text).toContain("We are refunding your payment in full.");
        expect(text).not.toContain("nothing was charged");
        expect(await env.DB.prepare("SELECT cancel_pending AS c FROM rejected_subscriptions WHERE subscription_id='sub_test1'").first()).toEqual({ c: 0 });
        if (shape.includes("none yet")) {
          expect((await op())[0].i).toBeNull(); // the obligation stands without its invoice
          expect(refundPosts()).toHaveLength(0);
          retrievable["/v1/checkout/sessions/cs_foreign"] = onStripe; // Stripe now has it
          at(NOW + 10 * 60_000); await sweepBilling(baseEnv(), deps()).catch(() => undefined);
        }
        expect((await op())[0].i).toBe("in_1");
        expect(refundPosts().map((c) => Number(c.form.get("amount")))).toEqual([4900]);
        // a later invoice.paid for the same payment is covered by this operation, never refunded twice
        expect((await hook(stripeEvent("invoice.paid", invoice()))).status).toBe(200);
        expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(1);
        expect(refundPosts()).toHaveLength(1);
      });
    }
    it("Astra DROPDOWN-DIRECT-2 (1): a paid refusal through its consent with an expanded invoice object is refunded on that invoice and says so", async () => {
      await order("FR");
      const s = await newSession({ renewal_sha256: renewalSha256("other words") }, { invoice: { id: "in_1", object: "invoice" } });
      expect((await hook(stripeEvent("checkout.session.completed", s))).status).toBe(200);
      expect(await env.DB.prepare("SELECT kind,paid_cents AS p,invoice_id AS i FROM refund_ops").all().then((r) => r.results)).toEqual([{ kind: "rejected_consent", p: 4900, i: "in_1" }]);
      expect(refundPosts().map((c) => Number(c.form.get("amount")))).toEqual([4900]);
      const text = (notices.find((n) => n.kind === "order_rejected")!.data as { emailText: string }).emailText;
      expect(text).toContain("We are refunding your payment in full.");
      expect(text).not.toContain("nothing was charged");
    });
    it("direct refusal: the email never blames an unanswered payment-page confirmation (there is none on the direct page)", async () => {
      await reserve(); expect((await checkout("starter", { billingCountry: "US" })).status).toBe(200);
      const s = await newSession({ renewal_sha256: renewalSha256("other words") }, { customer_details: { address: { country: "US" } } });
      expect((await hook(stripeEvent("checkout.session.completed", s))).status).toBe(200);
      expect((await consentRow())!.rejected_reason).toBe("rejected_consent");
      const text = (notices.find((n) => n.kind === "order_rejected")!.data as { emailText: string }).emailText;
      expect(text).toContain("We could not confirm your monthly renewal for this order, so it was cancelled.");
      expect(text).not.toMatch(/payment page|did not confirm/);
    });
    it("one successful subscription per consent: a second subscription for an accepted consent is refunded as a duplicate, the first untouched", async () => {
      await order("FR");
      const s = await newSession();
      expect((await hook(stripeEvent("checkout.session.completed", s))).status).toBe(200);
      expect((await consentRow())!).toMatchObject({ stripe_subscription_id: "sub_test1", rejected_at: null });
      expect((await hook(stripeEvent("checkout.session.completed", { ...s, subscription: "sub_test2", invoice: "in_2" }))).status).toBe(200);
      expect(await env.DB.prepare("SELECT kind,cancel_subscription_id AS c FROM refund_ops").all().then((r) => r.results)).toEqual([{ kind: "duplicate", c: "sub_test2" }]);
      expect((await consentRow())!).toMatchObject({ stripe_subscription_id: "sub_test1", rejected_at: null });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.duplicate_subscription'")).toBe(1);
    });
    for (const aFirst of [true, false]) {
      it(`Astra DROPDOWN-DIRECT-1 (2), ${aFirst ? "A completes unpaid first" : "B completes first"}: B from another session is refused on its own, the shared consent is never rejected, A's later payment proceeds`, async () => {
        await order("FR");
        const a = await newSession({}, {}, "unpaid"); // the session bound to the consent (cs_test_1, sub_test1), payment still pending
        const b = { ...a, id: "cs_second", subscription: "sub_b", invoice: "in_b", payment_status: "paid" }; // another session naming the same consent
        const complete = (x: Record<string, unknown>) => hook(stripeEvent("checkout.session.completed", x));
        for (const x of aFirst ? [a, b] : [b, a]) expect((await complete(x)).status).toBe(200);
        // B: tombstoned, cancelled and refunded in full on its own (a duplicate when A already holds the consent's subscription)
        expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions WHERE subscription_id='sub_b'")).toBe(1);
        expect(await env.DB.prepare("SELECT kind,cancel_subscription_id AS c,amount_cents AS a FROM refund_ops").all().then((r) => r.results))
          .toEqual([{ kind: aFirst ? "duplicate" : "rejected_consent", c: "sub_b", a: 4900 }]);
        // the shared consent: never rejected, still bound to A's session, holding A's subscription
        expect(await consentRow()).toMatchObject({ rejected_at: null, rejected_reason: null, stripe_session_id: "cs_test_1", stripe_subscription_id: "sub_test1" });
        expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions WHERE subscription_id='sub_test1'")).toBe(0);
        // A's payment clears later: accepted and provisioned, A never cancelled or refunded
        expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", { ...a, payment_status: "paid" }))).status).toBe(200);
        expect((await consentRow())!.paid_at).not.toBeNull();
        expect(subDeletes()).toHaveLength(0);
        expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE cancel_subscription_id='sub_test1'")).toBe(0);
        expect(await inbox()).toBe(1);
        expect(await sub()).toMatchObject({ status: "active" });
      });
    }
    // Astra DROPDOWN-DIRECT-2 (2): on the direct path every refusal refund of B (rejected_consent, duplicate, and the late_payment of a duplicate
    // whose payment clears later) is ONE credit note with refund_amount, never POST /v1/refunds, whichever order the webhooks arrive in.
    for (const aFirst of [true, false]) for (const bPaidLater of [false, true]) {
      it(`Astra DROPDOWN-DIRECT-2 (2), direct, ${aFirst ? "A first" : "B first"}, B ${bPaidLater ? "paid later" : "paid at completion"}: B is refunded through one credit note`, async () => {
        await reserve(); expect((await checkout("starter", { billingCountry: "US" })).status).toBe(200);
        creditNotesOn = true;
        const a = await newSession({}, { customer_details: { address: { country: "US" } } }, "unpaid");
        expect(a.metadata.seller).toBe("ferrox");
        const b = { ...a, id: "cs_second", subscription: "sub_b", invoice: "in_b", payment_status: bPaidLater ? "unpaid" : "paid" };
        for (const x of aFirst ? [a, b] : [b, a]) expect((await hook(stripeEvent("checkout.session.completed", x))).status).toBe(200);
        if (bPaidLater) {
          expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0); // nothing paid yet: B cancelled only
          expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", { ...b, payment_status: "paid" }))).status).toBe(200);
        }
        const ops = (await env.DB.prepare("SELECT kind,invoice_id AS i,amount_cents AS a,detail,credit_note_id AS cn FROM refund_ops").all<{ kind: string; i: string; a: number; detail: string; cn: string | null }>()).results;
        const kind = aFirst ? (bPaidLater ? "late_payment" : "duplicate") : "rejected_consent";
        expect(ops.map((o) => [o.kind, o.i, o.a, JSON.parse(o.detail).path])).toEqual([[kind, "in_b", 4900, "direct"]]);
        expect(ops[0].cn).toMatch(/^cn_/);
        const notes = stripeCalls.filter((c) => c.path === "/v1/credit_notes" && c.method === "POST");
        expect(notes.map((c) => [c.form.get("invoice"), Number(c.form.get("refund_amount"))])).toEqual([["in_b", 4900]]);
        expect(refundPosts()).toHaveLength(0);
        // A is never touched
        expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE cancel_subscription_id='sub_test1'")).toBe(0);
      });
    }
    // A pre-change session exactly as the old code issued it: the dropdown, metadata naming home, plan and consent only, created before the
    // cutoff; and its consent as the old code wrote it (no Stripe-page provenance in the archive).
    const preChange = async (answer: string | null, created = LEGACY_SESSION_CUTOFF_S - 3600) => {
      await env.DB.prepare("UPDATE checkout_consents SET disclosure=json_remove(disclosure,'$.stripePage')").run();
      return { ...(await sessionObj()), created, custom_fields: [{ key: "renewalconsent", type: "dropdown", dropdown: { value: answer } }],
        metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1") } };
    };
    it("TRANSITION: a session created before the change (dropdown answered, no hash, no price) is still accepted by the old rule", async () => {
      await order("FR");
      expect((await hook(stripeEvent("checkout.session.completed", await preChange("renewalyes")))).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect((await consentRow())!.rejected_at).toBeNull();
      // the old rule reads no line items
      expect(stripeCalls.some((c) => c.path.endsWith("/line_items"))).toBe(false);
    });
    it("TRANSITION: a session created before the change whose dropdown was not answered is still refused by the old rule", async () => {
      await order("FR");
      expect((await hook(stripeEvent("checkout.session.completed", await preChange(null)))).status).toBe(200);
      await refusedWithTombstone();
    });
    it("TRANSITION: the same pre-change shape created at or after the deployment cutoff is judged by the record and refused", async () => {
      await order("FR");
      expect((await hook(stripeEvent("checkout.session.completed", await preChange("renewalyes", LEGACY_SESSION_CUTOFF_S)))).status).toBe(200);
      await refusedWithTombstone();
    });
    it("Astra DROPDOWN-DIRECT-2 (3): a pre-change shape whose consent archive holds a stripePage WITHOUT its version is refused, never legacy", async () => {
      await order("FR");
      const s = await preChange("renewalyes");
      await env.DB.prepare("UPDATE checkout_consents SET disclosure=json_set(disclosure,'$.stripePage',json('{\"variant\":\"mp_dropdown\"}'))").run();
      expect((await hook(stripeEvent("checkout.session.completed", s))).status).toBe(200);
      await refusedWithTombstone();
      expect(stripeCalls.some((c) => c.path.endsWith("/line_items"))).toBe(false); // refused on the provenance, before any Stripe read
    });
    it("Astra DROPDOWN-DIRECT-1 (1): a NEW Managed Payments session with no hash, wrong owner, recurring_authorized=0 and quantity 2 is refused, never accepted as legacy", async () => {
      await order("FR");
      // issued by the current code: its consent archives the Stripe page (provenance); Stripe reports two of the price
      expect(JSON.parse((await consentRow())!.disclosure as string).stripePage).toMatchObject({ variant: "mp_dropdown", version: STRIPE_PAGE_VERSION });
      retrievable["/v1/checkout/sessions/cs_test_1/line_items"] = { object: "list", data: [{ ...lineItem(), quantity: 2 }], has_more: false };
      const s = await newSession({ renewal_sha256: undefined }, { created: LEGACY_SESSION_CUTOFF_S - 3600 });
      expect(s.custom_fields).toEqual(RENEWAL_YES); // the Managed Payments dropdown, answered
      await env.DB.prepare("UPDATE checkout_consents SET user_id='someone-else', recurring_authorized=0").run();
      expect((await hook(stripeEvent("checkout.session.completed", s))).status).toBe(200);
      await refusedWithTombstone();
      expect(await consentRow()).toMatchObject({ rejected_reason: "rejected_consent", paid_at: null, completed_at: null });
      expect(await consentRow()).toMatchObject({ stripe_session_id: "cs_test_1" });
    });
  });

  describe("Test 4: withdrawal clock (plan §4.1)", () => {
    it("completed with payment pending: statutory_withdraw_until is from completed_at, the account page offers withdrawal, and withdrawing refunds nothing and cancels", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      signedIn = OWNER;
      expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ withdrawal: { available: true, endsAt: aoeEnd(NOW, 14) } });
      const res = await send("/v1/account/withdraw", { body: { confirm: true } });
      expect(res.status).toBe(201);
      expect(refundPosts()).toHaveLength(0);
      expect(subDeletes()).toHaveLength(1);
    });
    it("paid but not yet started (before provisioning): withdrawal is refunded in full", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      await hook(stripeEvent("invoice.paid", invoice()));
      signedIn = OWNER; at(NOW + 1000);
      const res = await send("/v1/account/withdraw", { body: { confirm: true } });
      expect(await res.json()).toMatchObject({ withdrawn: true, refundCents: 4900 });
      expect(refundPosts().map((c) => c.form.get("amount"))).toEqual(["4900"]);
    });
    it("day 14 after the start: still open until the end of that day (AoE) and refunded in full, with no deduction; one second later it is closed", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      await hook(stripeEvent("invoice.paid", invoice()));
      await reconcile(); await serviceUp();
      signedIn = OWNER;
      at(aoeEnd(NOW, 14) + 1000);
      expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ withdrawal: { available: false } });
      at(aoeEnd(NOW, 14));
      expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ withdrawal: { available: true, endsAt: aoeEnd(NOW, 14) } });
      const res = await send("/v1/account/withdraw", { body: { confirm: true } });
      expect(await res.json()).toMatchObject({ withdrawn: true, refundCents: 4900, deductedCents: 0 });
    });
  });

  it("the second moment also arrives with the first invoice: paid_at is written once even if the session event never says paid", async () => {
    await order("FR");
    await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
    at(NOW + DAY);
    await hook(stripeEvent("invoice.paid", invoice(), (NOW + DAY) / 1000));
    expect(await consentRow()).toMatchObject({ paid_at: NOW + DAY, guarantee_withdraw_until: aoeEnd(NOW + DAY, 14) });
  });

  describe("Astra WP5-1 (round 1): one test per finding and per untested rule", () => {
    const refundOps = () => env.DB.prepare("SELECT id,kind,amount_cents AS a,invoice_id AS i FROM refund_ops ORDER BY created_at, id").all<{ id: string; kind: string; a: number | null; i: string | null }>().then((r) => r.results);
    const events = () => env.DB.prepare("SELECT type,processed_at AS p,error AS e FROM stripe_events ORDER BY received_at, rowid").all<{ type: string; p: number | null; e: string | null }>().then((r) => r.results);
    const offer = (body: Record<string, unknown>) => send("/v1/admin/refund-first-month", { body, headers: admin });
    const withdrawPending = async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      signedIn = OWNER;
      expect((await send("/v1/account/withdraw", { body: { confirm: true } })).status).toBe(201);
      expect(await env.DB.prepare("SELECT basis,amount_cents AS a FROM refund_ops WHERE kind='withdrawal'").first()).toEqual({ basis: "nothing_charged", a: 0 });
    };

    it("r1-1 a payment that settles after a pending-payment withdrawal is refunded in full (async success), once", async () => {
      await withdrawPending();
      at(NOW + DAY);
      expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({}, "paid"), (NOW + DAY) / 1000))).status).toBe(200);
      expect((await refundOps()).filter((o) => o.kind === "late_payment")).toEqual([{ id: "late_payment:in_1", kind: "late_payment", a: 4900, i: "in_1" }]);
      expect(refundPosts().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      // the invoice of the same payment, delivered afterwards, never pays it twice
      expect((await hook(stripeEvent("invoice.paid", invoice(), (NOW + DAY) / 1000))).status).toBe(200);
      expect(refundPosts()).toHaveLength(1);
      expect(await inbox()).toBe(0);
    });
    it("r1-1 the same late settlement delivered as invoice.paid only (no session event) is refunded in full", async () => {
      await withdrawPending();
      expect((await hook(stripeEvent("invoice.paid", invoice(), (NOW + DAY) / 1000))).status).toBe(200);
      expect((await refundOps()).filter((o) => o.kind === "late_payment").map((o) => o.a)).toEqual([4900]);
      expect(refundPosts().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(await inbox()).toBe(0);
    });

    it("r1-2 an async success whose completion has not finished waits (retried), and is applied once the completion has run", async () => {
      await order("FR");
      // the completion crashed after completed_at was written, before the guard and the claim
      await env.DB.prepare("UPDATE checkout_consents SET completed_at=?, stripe_subscription_id='sub_test1' WHERE id=?").bind(NOW, await latestConsentId("home-1")).run();
      const success = stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({}, "paid"), (NOW + DAY) / 1000);
      await hook(success);
      expect((await events()).find((e) => e.type === "checkout.session.async_payment_succeeded")).toMatchObject({ p: null, e: "completion_pending" });
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      at(NOW + DAY);
      expect((await hook(success)).status).toBe(200);
      expect(await consentRow()).toMatchObject({ paid_at: NOW + DAY });
      expect(await inbox()).toBe(1);
      expect((await events()).find((e) => e.type === "checkout.session.async_payment_succeeded")!.e).toBeNull();
    });
    it("r1-2 an unpaid rejection followed by invoice.paid: the tombstone refunds the payment in full before it ignores the event, once", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({ custom_fields: [] }, "unpaid")));
      expect(await refundOps()).toEqual([]);
      expect(await (await hook(stripeEvent("invoice.paid", invoice()))).json()).toMatchObject({ received: true });
      expect((await refundOps()).map((o) => [o.kind, o.a])).toEqual([["rejected_consent", 4900]]);
      await hook(stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({ custom_fields: [] }, "paid")));
      await hook(stripeEvent("invoice.paid", invoice()));
      expect(refundPosts().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(await inbox()).toBe(0);
    });
    it("r1-2 mixed delivery (invoice first, completion, async success, invoice again): one paid moment, one email, one grant, no refund", async () => {
      await order("FR");
      const inv = stripeEvent("invoice.paid", invoice(), (NOW + DAY) / 1000);
      await hook(inv); // before the completion: retried
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      at(NOW + DAY);
      await hook(inv);
      await hook(stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({}, "paid"), (NOW + DAY + 60_000) / 1000));
      await hook(inv);
      expect(await consentRow()).toMatchObject({ paid_at: NOW + DAY, refund7_until: aoeEnd(NOW + DAY, 7) });
      expect(notices.filter((n) => n.kind === "payment_received")).toHaveLength(1);
      expect(fluxLog.filter((f) => f.hook === "grant")).toHaveLength(1);
      expect(await refundOps()).toEqual([]);
    });

    it("r1-3 an interrupted first-invoice write is repaired: the consent's clocks come from the recorded first payment", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      // the old two-step write stopped after the first payment's record
      await env.DB.prepare("UPDATE billing_subscriptions SET first_invoice_id='in_1', first_paid_at=?, first_invoice_cents=4900, first_invoice_tax_cents=0").bind(NOW + DAY).run();
      at(NOW + 2 * DAY);
      expect((await hook(stripeEvent("invoice.paid", invoice(), (NOW + 2 * DAY) / 1000))).status).toBe(200);
      expect(await consentRow()).toMatchObject({ paid_at: NOW + DAY, guarantee_withdraw_until: aoeEnd(NOW + DAY, 14), refund7_until: aoeEnd(NOW + DAY, 7) });
      expect(notices.filter((n) => n.kind === "payment_received")).toHaveLength(1);
    });

    it("r1-4 a failed delayed payment after an 'active' subscription update: cancelled for good, and the customer can check out again", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      await hook(stripeEvent("customer.subscription.updated", { object: "subscription", id: "sub_test1", customer: "cus_test1", status: "active",
        items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }));
      expect((await sub())!.status).toBe("active");
      expect((await hook(stripeEvent("checkout.session.async_payment_failed", await sessionObj({}, "unpaid")))).status).toBe(200);
      expect((await sub())!.status).toBe("canceled");
      expect(subDeletes()).toHaveLength(1);
      await hook(stripeEvent("customer.subscription.updated", { object: "subscription", id: "sub_test1", customer: "cus_test1", status: "active", items: { data: [] } }));
      expect((await sub())!.status).toBe("canceled");
      expect((await checkout("starter", { billingCountry: "FR", earlyStart: true })).status).toBe(200);
    });
    it("r1-4 a stale failure after the first payment was recorded by invoice.paid is ignored (verified payment, not the status)", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      await hook(stripeEvent("invoice.paid", invoice()));
      expect(await (await hook(stripeEvent("checkout.session.async_payment_failed", await sessionObj({}, "unpaid")))).json()).toMatchObject({ received: true });
      expect(subDeletes()).toHaveLength(0);
      expect((await consentRow())!.payment_failed_at).toBeNull();
    });

    it("r2-2 failed payment, then a NEW checkout, then the OLD async success: refunded in full by that handler alone (no invoice event), never stuck as completion_pending", async () => {
      await order("FR");
      const oldConsent = await latestConsentId("home-1");
      const oldSession = await sessionObj({}, "unpaid");
      await hook(stripeEvent("checkout.session.completed", oldSession));
      await hook(stripeEvent("checkout.session.async_payment_failed", oldSession));
      // the customer starts again: a new consent, and its subscription takes the home's claim (consent_id moves on)
      expect((await checkout("starter", { billingCountry: "FR", earlyStart: true })).status).toBe(200);
      const fresh = await sessionObj({ id: "cs_test_2", subscription: "sub_test2", invoice: "in_2" }, "unpaid");
      expect((fresh.metadata as { consent_id: string }).consent_id).not.toBe(oldConsent);
      await hook(stripeEvent("checkout.session.completed", fresh));
      expect(await env.DB.prepare("SELECT subscription_id AS s FROM billing_subscriptions").first()).toEqual({ s: "sub_test2" });
      // the old payment clears after all; Stripe sends no invoice.paid for it here
      expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", { ...oldSession, payment_status: "paid" }))).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='late_payment' AND invoice_id='in_1' AND target_cents=4900")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE type='checkout.session.async_payment_succeeded' AND processed_at IS NOT NULL AND error='late_payment_refunded'")).toBe(1);
      expect(await inbox()).toBe(0); // nothing provisioned for the old order
      expect((await consentRow())!.paid_at).toBeNull(); // the new order's consent is untouched
    });
    it("r1-5 the 7-day offer and the EU/UK full refund use the consent's frozen deadlines, in the preview and the request", async () => {
      managed(); await reserve();
      expect((await checkout("starter", { billingCountry: "US" })).status).toBe(200);
      await hook(stripeEvent("checkout.session.completed", await sessionObj({ customer_details: { address: { country: "US" } } })));
      await hook(stripeEvent("invoice.paid", invoice()));
      // B3: a server ready well before the frozen dates, so the frozen deadline is the one that decides here.
      await env.DB.prepare("UPDATE cloud_homes SET ready_at=? WHERE id='home-1'").bind(NOW - 10 * DAY).run();
      const id = await latestConsentId("home-1");
      // Astra JOURNEY-B-1 #8: a frozen value EARLIER than the payment's own AoE rule never shortens the window (always the maximum).
      await env.DB.prepare("UPDATE checkout_consents SET refund7_until=? WHERE id=?").bind(NOW + 3 * DAY, id).run();
      at(NOW + 3 * DAY + 1);
      expect(await (await offer({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true, windowEndsAt: 1800705599000 } });
      at(1800705599000 + 1);
      expect(await (await offer({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false, reason: "window_expired", windowEndsAt: 1800705599000 } });
      expect(await (await offer({ homeId: "home-1" })).json()).toMatchObject({ error: "window_expired" });
      await env.DB.prepare("UPDATE checkout_consents SET refund7_until=? WHERE id=?").bind(NOW + 9 * DAY, id).run();
      at(NOW + 8 * DAY);
      expect(await (await offer({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: true, windowEndsAt: NOW + 9 * DAY } });
    });
    it("r1-5 an EU/UK full refund is due until the later frozen deadline (not 336 hours from payment)", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      await hook(stripeEvent("invoice.paid", invoice()));
      await env.DB.prepare("UPDATE checkout_consents SET guarantee_withdraw_until=? WHERE id=?").bind(NOW + 20 * DAY, await latestConsentId("home-1")).run();
      at(NOW + 18 * DAY);
      expect(await (await offer({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ basis: "eu_uk_full_refund", quote: { eligible: true, windowEndsAt: NOW + 20 * DAY } });
    });

    it("r1-6 completed_at and the acceptance are Stripe's submission time, however late the event is processed or retried", async () => {
      await order("FR");
      const submitted = NOW - 3 * 3_600_000;
      at(NOW + 5 * 3_600_000);
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid"), submitted / 1000));
      const id = await latestConsentId("home-1");
      expect(await consentRow()).toMatchObject({ completed_at: submitted, statutory_withdraw_until: aoeEnd(submitted, 14) });
      expect(await env.DB.prepare("SELECT accepted_at AS a FROM terms_acceptances WHERE consent_id=?").bind(id).first()).toEqual({ a: submitted });
      // a crash between completed_at and the acceptance: the retry records the PERSISTED moment, never its own clock
      await env.DB.prepare("DELETE FROM terms_acceptances WHERE consent_id=?").bind(id).run();
      at(NOW + DAY);
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid"), (NOW + DAY) / 1000));
      expect(await env.DB.prepare("SELECT accepted_at AS a FROM terms_acceptances WHERE consent_id=?").bind(id).first()).toEqual({ a: submitted });
      expect((await consentRow())!.completed_at).toBe(submitted);
    });
    it("WP4 closing pass: a missing acceptance line parks the consent once (one alert), never invents an acceptance, and is replayed after repair", async () => {
      await order("FR");
      const id = await latestConsentId("home-1");
      const good = await env.DB.prepare("SELECT wording,disclosure FROM checkout_consents WHERE id=?").bind(id).first<{ wording: string; disclosure: string }>();
      await env.DB.prepare("UPDATE checkout_consents SET wording='{}', disclosure=NULL WHERE id=?").bind(id).run();
      for (let n = 0; n < 2; n++) expect((await hook(stripeEvent("checkout.session.completed", await sessionObj()))).status).toBe(200);
      expect((await consentRow())!.acceptance_parked_at).toBe(NOW);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.acceptance_line_missing'")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM terms_acceptances WHERE consent_id=?", id)).toBe(0);
      expect(await inbox()).toBe(0);
      expect((await events()).filter((e) => e.e === "acceptance_parked").length).toBe(2);
      const { releaseParkedAcceptance } = await import("../src/b5-billing");
      expect(await releaseParkedAcceptance(baseEnv(envOver), id, { now: () => NOW })).toBe(false); // still missing: a replay would only park again
      await env.DB.prepare("UPDATE checkout_consents SET wording=?, disclosure=? WHERE id=?").bind(good!.wording, good!.disclosure, id).run();
      expect(await releaseParkedAcceptance(baseEnv(envOver), id, { now: () => NOW })).toBe(true);
      expect((await consentRow())!.acceptance_parked_at).toBeNull();
      expect((await events()).filter((e) => e.e === "acceptance_parked")).toEqual([]);
      expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL")).toBe(2);
    });
    it("r2-1 POST /v1/admin/orders/{consentId}/release-parked replays for real: the parked completion and the payment that waited on it run now, one provisioning", async () => {
      const cap = captureLogs();
      await order("FR");
      const id = await latestConsentId("home-1");
      const good = (await env.DB.prepare("SELECT wording,disclosure FROM checkout_consents WHERE id=?").bind(id).first<{ wording: string; disclosure: string }>())!;
      await env.DB.prepare("UPDATE checkout_consents SET wording='{}', disclosure=NULL WHERE id=?").bind(id).run();
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      at(NOW + 60_000);
      await hook(stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({}, "paid"), (NOW + 60_000) / 1000));
      expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL AND error='acceptance_parked'")).toBe(1); // the payment waits
      const release = (headers: Record<string, string> = admin) => send(`/v1/admin/orders/${id}/release-parked`, { body: {}, headers });
      expect([401, 403]).toContain((await release({})).status); // operator only
      expect((await release()).status).toBe(409); // the line is still missing: a replay would only park again
      await env.DB.prepare("UPDATE checkout_consents SET wording=?, disclosure=? WHERE id=?").bind(good.wording, good.disclosure, id).run();
      const res = await release();
      expect(res.status).toBe(200);
      const body = await res.json() as { released: boolean; replayed: { eventId: string; outcome: string | null }[] };
      expect(body.released).toBe(true);
      expect(body.replayed).toHaveLength(2);
      for (const r of body.replayed) expect(r.outcome).not.toMatch(/^pending:/);
      expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM terms_acceptances WHERE consent_id=?", id)).toBe(1);
      expect(await consentRow()).toMatchObject({ acceptance_parked_at: null, paid_at: NOW + 60_000, rejected_at: null });
      expect(await inbox()).toBe(1);
      await reconcile(); await reconcile();
      expect(await homesProvisioned()).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.acceptance_line_missing' AND resolved_at IS NULL")).toBe(0);
      expect((await release()).status).toBe(409); // nothing parked any more
      await expectPiiFree(cap.logs); cap.restore();
    });
    it("r2-1 an acceptance not recovered within 24 h: the sweep cancels the order and refunds it in full through the ledger (rejected_consent)", async () => {
      const cap = captureLogs();
      await order("FR");
      const id = await latestConsentId("home-1");
      await env.DB.prepare("UPDATE checkout_consents SET wording='{}', disclosure=NULL WHERE id=?").bind(id).run();
      await hook(stripeEvent("checkout.session.completed", await sessionObj())); // paid at completion
      expect((await consentRow())!.acceptance_parked_at).toBe(NOW);
      const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      at(NOW + 23 * 3_600_000); await sweep();
      expect((await consentRow())!.rejected_at).toBeNull();
      expect(refundPosts()).toHaveLength(0);
      at(NOW + 24 * 3_600_000); await sweep();
      expect(await consentRow()).toMatchObject({ rejected_reason: "rejected_consent", rejected_at: NOW + 24 * 3_600_000 });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='rejected_consent' AND invoice_id='in_1' AND target_cents=4900")).toBe(1);
      expect(refundPosts()).toHaveLength(1);
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions WHERE subscription_id='sub_test1'")).toBe(1);
      expect(await inbox()).toBe(0);
      expect(await env.DB.prepare("SELECT state FROM open_checkouts").first()).toEqual({ state: "failed" }); // the customer can start again
      const text = (notices.find((n) => n.kind === "order_rejected")!.data as { emailText: string }).emailText;
      expect(text).toContain("We could not finish your order on our side");
      expect(text).toContain("We are refunding your payment in full.");
      expect(text).not.toContain("did not confirm the monthly renewal");
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.acceptance_line_missing' AND resolved_at IS NULL")).toBe(0);
      // settled once: a later sweep refunds nothing more, and the repair route refuses a refunded order
      at(NOW + 48 * 3_600_000); await sweep();
      expect(refundPosts()).toHaveLength(1);
      expect((await send(`/v1/admin/orders/${id}/release-parked`, { body: {}, headers: admin })).status).toBe(409);
      await expectPiiFree(cap.logs); cap.restore();
    });
    it("r2 checklist: an asynchronous payment after a FAILED confirmation waits for the completion, then provisions exactly once", async () => {
      const cap = captureLogs();
      await order("FR");
      notifierFails = true;
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      expect((await consentRow())!.confirmation_sent_at).toBeNull();
      at(NOW + DAY);
      await hook(stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({}, "paid"), (NOW + DAY) / 1000));
      expect(await inbox()).toBe(0); // never decided before the completion has finished
      expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL")).toBe(2);
      notifierFails = false; at(NOW + 2 * DAY);
      await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL")).toBe(0);
      expect(await consentRow()).toMatchObject({ paid_at: NOW + DAY, refund7_until: aoeEnd(NOW + DAY, 7) });
      expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(1);
      expect(notices.filter((n) => n.kind === "payment_received")).toHaveLength(1);
      expect(await inbox()).toBe(1);
      await reconcile(); await reconcile();
      expect(await homesProvisioned()).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      await expectPiiFree(cap.logs); cap.restore();
    });
    it("r2 checklist: mixed delivery (invoice first, completion, async success, the invoice redelivered) provisions exactly ONE server", async () => {
      const cap = captureLogs();
      await order("FR");
      const inv = stripeEvent("invoice.paid", invoice(), (NOW + DAY) / 1000);
      await hook(inv);
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      at(NOW + DAY);
      await hook(inv); await reconcile();
      await hook(stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({}, "paid"), (NOW + DAY + 60_000) / 1000));
      await reconcile();
      await hook(inv); // Stripe redelivers the same event (same id)
      await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
      await reconcile(); await reconcile();
      expect(await homesProvisioned()).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_fake_resources WHERE role='home'")).toBe(1); // never a second one created and destroyed
      expect(fluxLog.filter((f) => f.hook === "grant")).toHaveLength(1);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      await expectPiiFree(cap.logs); cap.restore();
    });
    it("r2 checklist: migration 0061 run IN FULL on a populated database (every statement, then the backfill), and the app runs on the result", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      const id = await latestConsentId("home-1");
      await env.DB.prepare("UPDATE billing_subscriptions SET first_invoice_id='in_1', first_paid_at=?").bind(NOW + DAY).run();
      const before = (await env.DB.prepare("SELECT id,completed_at,wording,stripe_subscription_id FROM checkout_consents WHERE id=?").bind(id).first())!;
      // back to the pre-0061 schema, keeping the populated rows. WP6's view (0071) reads rejected_subscriptions and checkout_consents.paid_at, and
      // SQLite checks every view when a column is dropped: it is dropped here and created again with the later migrations below.
      await env.DB.prepare("DROP VIEW replacement_payment_events").run();
      await env.DB.prepare("DROP TABLE rejected_subscriptions").run();
      await env.DB.prepare("DROP TABLE checkout_retry_routes").run();
      for (const c of ["paid_at", "statutory_withdraw_until", "guarantee_withdraw_until", "refund7_until", "payment_failed_at", "rejected_at", "rejected_reason", "acceptance_parked_at"]) {
        await env.DB.prepare(`ALTER TABLE checkout_consents DROP COLUMN ${c}`).run();
      }
      await env.DB.prepare("ALTER TABLE terms_acceptances DROP COLUMN normalised_at").run();
      // the whole file, statement by statement, as the migration runner applies it
      const statements = m0061.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").split(";").map((t) => t.trim()).filter(Boolean);
      expect(statements.length).toBeGreaterThanOrEqual(12);
      for (const st of statements) await env.DB.prepare(st).run();
      // then every later migration that changes these tables (0073: the cancellation journal), so the app below runs on today's schema
      const later = m0073.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").split(";").map((t) => t.trim()).filter(Boolean);
      for (const st of later) await env.DB.prepare(st).run();
      // and 0071's view over these tables, as that migration created it
      const view = m0071.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).find((x) => x.startsWith("CREATE VIEW IF NOT EXISTS replacement_payment_events"))!;
      await env.DB.prepare(view).run();
      expect(await env.DB.prepare("SELECT id,completed_at,wording,stripe_subscription_id FROM checkout_consents WHERE id=?").bind(id).first()).toEqual(before);
      expect(await consentRow()).toMatchObject({ paid_at: NOW + DAY, statutory_withdraw_until: null, guarantee_withdraw_until: null, refund7_until: null,
        rejected_at: null, acceptance_parked_at: null });
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM checkout_retry_routes")).toBe(0);
      // the upgraded database serves the order: a pre-0061 consent gets the AoE fallback from its backfilled paid_at
      signedIn = OWNER;
      at(NOW + 14 * DAY + 1000);
      expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ withdrawal: { endsAt: aoeEnd(NOW + DAY, 14) } });
    });
    it("WP4 closing pass P3: a pre-r1 acceptance is normalised once, even when the completion time equals created_at; a replay never rewrites it", async () => {
      await order("FR");
      const id = await latestConsentId("home-1");
      const c = await env.DB.prepare("SELECT created_at AS t,user_id AS u FROM checkout_consents WHERE id=?").bind(id).first<{ t: number; u: string }>();
      await env.DB.prepare(`INSERT INTO terms_acceptances (id,user_id,cloud_terms_version,tos_version,privacy_version,source,consent_id,wording,accepted_at,client_meta)
        VALUES ('pre-r1',?,'c','t','p','checkout',?,'old checkbox words',?,'{}')`).bind(c!.u, id, c!.t).run();
      await recordAcceptanceAtCompletion(env, id, c!.t);
      const once = await env.DB.prepare("SELECT accepted_at AS a,wording AS w,normalised_at AS n FROM terms_acceptances WHERE consent_id=?").bind(id).first<{ a: number; w: string; n: number }>();
      expect(once).toMatchObject({ a: c!.t, n: c!.t });
      expect(once!.w).not.toBe("old checkbox words");
      await env.DB.prepare("UPDATE terms_acceptances SET wording='edited by ops' WHERE consent_id=?").bind(id).run();
      await recordAcceptanceAtCompletion(env, id, c!.t + DAY);
      expect(await env.DB.prepare("SELECT accepted_at AS a,wording AS w FROM terms_acceptances WHERE consent_id=?").bind(id).first()).toEqual({ a: c!.t, w: "edited by ops" });
    });

    it("r1-7 'Payment received' is a recorded obligation with the stored deadlines; an invoice-first payment sends it too, once", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      at(NOW + DAY);
      await hook(stripeEvent("invoice.paid", invoice(), (NOW + DAY) / 1000));
      const rec = await env.DB.prepare("SELECT payload FROM billing_notices WHERE kind='payment_received'").all<{ payload: string }>();
      expect(rec.results).toHaveLength(1);
      const text = (JSON.parse(rec.results[0].payload) as { emailText: string }).emailText;
      const row = (await consentRow())!;
      expect(text).toContain(`until the end of ${new Date((row.guarantee_withdraw_until as number) - 12 * 3_600_000).toISOString().slice(0, 10)}`);
      expect(text).toContain(`7-day refund until the end of ${new Date((row.refund7_until as number) - 12 * 3_600_000).toISOString().slice(0, 10)}`);
      expect(text).toContain(`Your plan renews on ${new Date((NOW / 1000 + 30 * 86400) * 1000).toISOString().slice(0, 10)}`);
      await hook(stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({}, "paid"), (NOW + DAY) / 1000));
      expect(notices.filter((n) => n.kind === "payment_received")).toHaveLength(1);
      // PII: the notice and its alert-free path carry no email address, card or address data
      expect(text).not.toMatch(/@|cus_|pi_|card|FR\b/);
    });
    it("r1-7 the confirmation of an order paid at completion states the stored deadlines, and no renewal date we computed ourselves", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      const text = (notices.find((n) => n.kind === "confirmation")!.data as { emailText: string }).emailText;
      expect(text).toContain(`You can ask for the 7-day refund until the end of ${new Date(aoeEnd(NOW, 7) - 12 * 3_600_000).toISOString().slice(0, 10)}`);
      expect(text).not.toContain(`Next renewal after that: ${isoDate(addMonthUtc(NOW))}`);
    });
    it("r1-8 an unpaid rejection says nothing was charged, never that a refund happened", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({ custom_fields: [] }, "unpaid")));
      const text = (notices.find((n) => n.kind === "order_rejected")!.data as { emailText: string }).emailText;
      expect(text).toContain("nothing was charged");
      expect(text).not.toMatch(/refunded|refunding|Your refund/);
    });
    it("r1-8 a paid rejection reports the refund as the WP3 ledger has it, and the alert carries no personal data", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({ custom_fields: [] })));
      const text = (notices.find((n) => n.kind === "order_rejected")!.data as { emailText: string }).emailText;
      expect(text).toMatch(/We are refunding your payment in full\. Your refund: (processed on|sent)/);
      const alerts = await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind LIKE 'checkout.%'").all<{ detail: string }>();
      for (const a of alerts.results) expect(a.detail).not.toMatch(/@|legal-owner|198\.51|vitest-browser/);
    });
    it("r2-4 a rejection email sent through the REAL notifier states the ledger's refund status at each send, retries included", async () => {
      await order("FR");
      const mails: { subject: string; text: string; html?: string }[] = []; let mailDown = true;
      envOver = { ...envOver, EMAIL: { async send(m: { subject: string; text: string; html?: string }) { if (mailDown) throw new Error("mail_down"); mails.push(m); } } } as unknown as Partial<Env>;
      const real: BillingDependencies = { ...deps(), notifier: undefined };
      const raw = JSON.stringify(stripeEvent("checkout.session.completed", await sessionObj({ custom_fields: [] })));
      expect((await send("/v1/billing/webhook", { raw, headers: { "stripe-signature": await signStripePayload(raw, WHSEC, Math.floor(Date.now() / 1000)) } }, real)).status).toBe(200);
      expect(await env.DB.prepare("SELECT sent_at AS s FROM billing_notices WHERE kind='order_rejected'").first()).toEqual({ s: null });
      // the refund completes after the first (failed) send; the retry must say so, not repeat what was stored earlier
      const op = (await env.DB.prepare("SELECT id FROM refund_ops WHERE kind='rejected_consent'").first<{ id: string }>())!;
      await env.DB.prepare("UPDATE refund_ops SET stripe_refund_status='succeeded',refunded_at=? WHERE id=?").bind(NOW + DAY, op.id).run();
      mailDown = false; at(NOW + DAY);
      await sweepBilling(baseEnv(envOver), real).catch(() => undefined);
      const mail = mails.find((m) => m.subject === "Murage Cloud: your order was cancelled")!;
      expect(mail.text).toContain(`processed on ${new Date(NOW + DAY).toISOString().slice(0, 10)} (UTC)`);
      expect(mail.text).not.toContain("being prepared");
      const stored = JSON.parse((await env.DB.prepare("SELECT payload FROM billing_notices WHERE kind='order_rejected'").first<{ payload: string }>())!.payload) as { emailText: string };
      expect(stored.emailText).toBe(mail.text); // what went out is what is on record
      // PII: no address, customer, payment or card data in what was sent
      for (const t of [mail.text, mail.html ?? ""]) expect(t).not.toMatch(/@|cus_|pi_|card|legal-owner|198\.51/);
    });
    it("r1-9 a retried rejection touches only its own order: a newer checkout stays open and the retry route is not rewritten", async () => {
      await order("DE");
      const rejected = stripeEvent("checkout.session.completed", await sessionObj({ customer_details: { address: { country: "AT" } } }));
      await hook(rejected);
      const route = await env.DB.prepare("SELECT * FROM checkout_retry_routes").first();
      at(NOW + 60_000);
      expect((await checkout("starter", { billingCountry: "AT", earlyStart: true })).status).toBe(200);
      expect(await env.DB.prepare("SELECT state FROM open_checkouts").first()).toEqual({ state: "open" });
      await hook({ ...rejected, id: "evt_legalredeliveryabcd" });
      expect(await env.DB.prepare("SELECT state FROM open_checkouts").first()).toEqual({ state: "open" });
      expect(await env.DB.prepare("SELECT * FROM checkout_retry_routes").first()).toEqual(route);
    });
    it("r1-10 /v1/account/order reads the order's paid moment and the subscription-bound server start", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      signedIn = OWNER;
      const before = await (await get("/v1/account/order?home=home-1")).json() as Record<string, unknown>;
      expect(before).toMatchObject({ startsAt: null });
      expect(before.status).not.toBe("paid");
      at(NOW + DAY);
      await hook(stripeEvent("checkout.session.async_payment_succeeded", await sessionObj({}, "paid"), (NOW + DAY) / 1000));
      expect(await (await get("/v1/account/order?home=home-1")).json()).toMatchObject({ status: "paid", charged: true, startsAt: NOW + DAY });
    });

    it("migration 0061 on a populated database: paid_at is backfilled once from the subscription-matched first payment only", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, "unpaid")));
      const id = await latestConsentId("home-1");
      await env.DB.prepare("UPDATE billing_subscriptions SET first_invoice_id='in_1', first_paid_at=?").bind(NOW + DAY).run();
      // a second, older consent of the same home whose subscription is NOT the one that was paid stays unpaid
      const cols = (await env.DB.prepare("PRAGMA table_info(checkout_consents)").all<{ name: string }>()).results.map((c) => c.name);
      const pick = cols.map((c) => c === "id" ? "'old-consent'" : c === "created_at" ? "created_at-1" : c === "stripe_subscription_id" ? "'sub_other'" : c);
      await env.DB.prepare(`INSERT INTO checkout_consents (${cols.join(",")}) SELECT ${pick.join(",")} FROM checkout_consents WHERE id=?`).bind(id).run();
      await env.DB.prepare("UPDATE checkout_consents SET paid_at=NULL").run();
      const backfill = m0061.slice(m0061.lastIndexOf("UPDATE checkout_consents SET paid_at="));
      for (let n = 0; n < 2; n++) await env.DB.prepare(backfill).run(); // idempotent
      expect(await env.DB.prepare("SELECT id,paid_at AS p FROM checkout_consents ORDER BY id").all().then((r) => r.results)).toEqual(
        [{ id, p: NOW + DAY }, { id: "old-consent", p: null }].sort((a, b) => a.id.localeCompare(b.id)));
      expect((await consentRow())!.refund7_until).toBeNull(); // deadlines are never backfilled
    });
    it("refund paths: a mismatch on a Link (Managed Payments) order refunds through POST /v1/refunds; on a direct order through a credit note", async () => {
      await order("DE");
      await hook(stripeEvent("checkout.session.completed", await sessionObj({ customer_details: { address: { country: "AT" } } })));
      expect(JSON.parse((await env.DB.prepare("SELECT detail FROM refund_ops").first<{ detail: string }>())!.detail)).toMatchObject({ path: "mp" });
      expect(refundPosts()).toHaveLength(1);
      await env.DB.prepare("DELETE FROM refund_ops").run(); await env.DB.prepare("DELETE FROM refund_invoice_ledger").run(); await env.DB.prepare("DELETE FROM rejected_subscriptions").run();
      await env.DB.prepare("DELETE FROM checkout_consents").run(); await env.DB.prepare("DELETE FROM open_checkouts").run(); await env.DB.prepare("DELETE FROM billing_subscriptions").run();
      stripeCalls = [];
      envOver = { CLOUD_NONUS_SELLER: "direct", FERROX_TAX_COUNTRIES: "US,DE,FR,GB,NL" } as Partial<Env>;
      expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
      // billed in a country the direct path does not cover (no Ferrox registration there): a mismatch, refunded on the DIRECT path
      await hook(stripeEvent("checkout.session.completed", await sessionObj({ customer_details: { address: { country: "AT" } } })));
      expect(await env.DB.prepare("SELECT kind FROM refund_ops").first()).toEqual({ kind: "mismatch" });
      expect(JSON.parse((await env.DB.prepare("SELECT detail FROM refund_ops").first<{ detail: string }>())!.detail)).toMatchObject({ path: "direct" });
      expect(refundPosts()).toHaveLength(0); // never POST /v1/refunds on the direct path: a credit note carries it
      expect(stripeCalls.some((c) => c.path.startsWith("/v1/credit_notes"))).toBe(true);
    });
  });

  describe("Astra WP5-3 (round 3): one test per finding", () => {
    const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    const HOUR = 3_600_000;
    /** A paid order parked for a missing acceptance line; returns the consent id and its good wording for the repair. */
    const parkedOrder = async (status = "paid") => {
      await order("FR");
      const id = await latestConsentId("home-1");
      const good = (await env.DB.prepare("SELECT wording,disclosure FROM checkout_consents WHERE id=?").bind(id).first<{ wording: string; disclosure: string }>())!;
      await env.DB.prepare("UPDATE checkout_consents SET wording='{}', disclosure=NULL WHERE id=?").bind(id).run();
      await hook(stripeEvent("checkout.session.completed", await sessionObj({}, status)));
      expect((await consentRow())!.acceptance_parked_at).toBe(NOW);
      const repair = () => env.DB.prepare("UPDATE checkout_consents SET wording=?, disclosure=? WHERE id=?").bind(good.wording, good.disclosure, id).run();
      return { id, repair };
    };

    it("r3-1 repair, then a DISTINCT completion event at 23 h 59: accepted, the parking released, and nothing refunded at 24 h", async () => {
      const { repair } = await parkedOrder();
      await repair();
      at(NOW + 24 * HOUR - 60_000);
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj()))).status).toBe(200); // a new event id, the same session
      expect(await consentRow()).toMatchObject({ acceptance_parked_at: null, rejected_at: null });
      expect(await inbox()).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.acceptance_line_missing' AND resolved_at IS NULL")).toBe(0);
      at(NOW + 24 * HOUR); await sweep();
      at(NOW + 48 * HOUR); await sweep();
      expect(await consentRow()).toMatchObject({ rejected_at: null, rejected_reason: null });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(refundPosts()).toHaveLength(0);
      expect(subDeletes()).toHaveLength(0);
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions")).toBe(0);
    });
    it("r3-1 the automatic rejection re-checks under the lease: an order accepted meanwhile (parking left behind) is released, not refunded", async () => {
      const { id, repair } = await parkedOrder();
      await repair();
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      // a parking mark left behind (written before this rule, or by a racing worker): the sweep must not refund an accepted order
      await env.DB.prepare("UPDATE checkout_consents SET acceptance_parked_at=? WHERE id=?").bind(NOW, id).run();
      at(NOW + 24 * HOUR); await sweep();
      expect(await consentRow()).toMatchObject({ acceptance_parked_at: null, rejected_at: null });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(refundPosts()).toHaveLength(0);
      expect(subDeletes()).toHaveLength(0);
    });
    it("r3-1 an order already provisioned that must be rejected has its service ended: plan ended, credits revoked, the lifecycle told", async () => {
      const { id } = await parkedOrder();
      // its payment reached the lifecycle (provisioned) although the completion never finished; provisioning happens only after the claim,
      // so the home's current subscription is this order's (the only case in which its service may be ended: Astra WP5-4 #1)
      await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,consent_id,created_at,updated_at)
        VALUES ('home-1','cus_test1','sub_test1','starter','active',?,?,?) ON CONFLICT(home_id) DO UPDATE SET subscription_id='sub_test1',consent_id=excluded.consent_id,status='active'`)
        .bind(id, NOW, NOW).run();
      const payload = { eventId: "evt_prov", homeId: "home-1", version: NOW, status: "paid", paymentId: "in_1" };
      await env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)").bind("evt_prov", "home-1", NOW, JSON.stringify(payload), NOW).run();
      at(NOW + 24 * HOUR); await sweep();
      expect(await consentRow()).toMatchObject({ rejected_reason: "rejected_consent" });
      const op = (await env.DB.prepare("SELECT * FROM refund_ops WHERE kind='rejected_consent'").first<Record<string, unknown>>())!;
      expect(op).toMatchObject({ end_plan: 1, subscription_id: "sub_test1", amount_cents: 4900 });
      expect(op.credits_revoked_at).not.toBeNull();
      expect(op.done_at).not.toBeNull();
      expect(JSON.parse(op.detail as string)).toMatchObject({ revoke: true, path: "mp" });
      // A service-only Stop (Astra JOURNEY-A-6 #1): the order's credit is adjusted by its payment's own reversal target.
      expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([{ hook: "stop", args: { homeId: "home-1", invoiceId: "in_1", keepGrants: true } }]);
      expect(subDeletes()).toHaveLength(1);
      expect(subDeletes()[0].form.get("prorate")).toBe("false");
      expect(refundPosts()).toHaveLength(1);
      const stopped = await env.DB.prepare("SELECT payload FROM cloud_payment_inbox WHERE id LIKE 'reject:%'").first<{ payload: string }>();
      expect(JSON.parse(stopped!.payload)).toMatchObject({ homeId: "home-1", status: "canceled", paymentId: "in_1" });
    });
    it("r3-2 the automatic rejection's cancellation throws: journaled before it was tried, the next sweep retries it until Stripe confirms", async () => {
      await parkedOrder("unpaid");
      cancelStuck = true;
      at(NOW + 24 * HOUR); await sweep();
      expect(await consentRow()).toMatchObject({ rejected_reason: "rejected_consent" });
      expect(subDeletes()).toHaveLength(2); // tried by the rejection, refused; asked again by the same sweep's journal pass, refused
      expect(await env.DB.prepare("SELECT home_id AS h,cancel_pending AS p,cancel_confirmed_at AS c FROM rejected_subscriptions WHERE subscription_id='sub_test1'").first())
        .toEqual({ h: "home-1", p: 1, c: null });
      at(NOW + 25 * HOUR); await sweep(); // still refused: still pending, asked again
      expect(subDeletes()).toHaveLength(3);
      cancelStuck = false;
      at(NOW + 26 * HOUR); await sweep();
      expect(subDeletes()).toHaveLength(4);
      expect(subDeletes()[3].form.get("prorate")).toBe("false");
      expect(await env.DB.prepare("SELECT cancel_pending AS p,cancel_confirmed_at AS c FROM rejected_subscriptions WHERE subscription_id='sub_test1'").first())
        .toEqual({ p: 0, c: NOW + 26 * HOUR });
      at(NOW + 27 * HOUR); await sweep();
      expect(subDeletes()).toHaveLength(4); // confirmed: never asked again
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0); // nothing was charged
    });
    it("r3-2 the same for a guard rejection of an unpaid order at the webhook: the event completes, the journal carries the cancellation", async () => {
      await order("DE");
      cancelStuck = true;
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj({ customer_details: { address: { country: "AT" } } }, "unpaid")))).status).toBe(200);
      expect(await consentRow()).toMatchObject({ rejected_reason: "mismatch" });
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions WHERE cancel_pending=1")).toBe(1);
      cancelStuck = false;
      at(NOW + HOUR); await sweep();
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions WHERE cancel_pending=1")).toBe(0);
      expect(subDeletes()).toHaveLength(2);
    });
    it("r3-3 two distinct events for one invoice grant the month once; a replay after the grant was recorded grants nothing", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      // Stripe may send distinct Event objects for one invoice: two ids, one invoice
      for (let n = 0; n < 2; n++) expect((await hook(stripeEvent("invoice.paid", invoice()))).status).toBe(200);
      expect(fluxLog.filter((l) => l.hook === "grant")).toHaveLength(1);
      expect(await env.DB.prepare("SELECT kind,home_id AS h,granted_at AS g FROM credit_grants WHERE invoice_id='in_1'").first()).toEqual({ kind: "period", h: "home-1", g: NOW });
      // an interruption after the grant was recorded (the event never marked done): the retry grants nothing
      await env.DB.prepare("UPDATE stripe_events SET processed_at=NULL,next_attempt_at=NULL WHERE type='invoice.paid'").run();
      at(NOW + HOUR); await sweep();
      expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL")).toBe(0);
      expect(fluxLog.filter((l) => l.hook === "grant")).toHaveLength(1);
      expect(await env.DB.prepare("SELECT current_period_end AS e FROM billing_subscriptions").first()).toEqual({ e: NOW + 30 * DAY });
    });
    it("r3-3 an interruption between B4's grant and its record asks again under the same invoice and kind (B4 applies it once); never a third time", async () => {
      await order("FR");
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      await hook(stripeEvent("invoice.paid", invoice()));
      const applied = new Map<string, number>(); let asked = 0;
      vi.spyOn(flux, "grantMonthlyCredits").mockImplementation(async (_e, input) => {
        asked++;
        const key = `${input.invoiceId}:${input.kind ?? "period"}`;
        if (!applied.has(key)) applied.set(key, input.periodEnd); // B4: at most once per (invoice, kind)
        if (asked === 1) throw new FluxHookRetry("b4_answer_lost"); // applied, the answer lost
      });
      at(NOW + 30 * DAY);
      const renewal = () => invoice({ id: "in_2", billing_reason: "subscription_cycle",
        lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 } }] } });
      await hook(stripeEvent("invoice.paid", renewal(), (NOW + 30 * DAY) / 1000));
      expect(await env.DB.prepare("SELECT granted_at AS g FROM credit_grants WHERE invoice_id='in_2'").first()).toEqual({ g: null }); // claimed, outcome unknown
      at(NOW + 31 * DAY); await sweep();
      expect(asked).toBe(2);
      expect([...applied.entries()].filter(([k]) => k.startsWith("in_2:"))).toEqual([["in_2:period", NOW + 60 * DAY]]);
      expect(await env.DB.prepare("SELECT granted_at AS g FROM credit_grants WHERE invoice_id='in_2'").first()).toEqual({ g: NOW + 31 * DAY });
      await hook(stripeEvent("invoice.paid", renewal(), (NOW + 30 * DAY) / 1000)); // a third, distinct event for the same invoice
      expect(asked).toBe(2);
      expect(await env.DB.prepare("SELECT current_period_end AS e FROM billing_subscriptions").first()).toEqual({ e: NOW + 60 * DAY });
    });
    describe("stub grant fails closed (credit.grant_pending)", () => {
      const grantRow = () => env.DB.prepare("SELECT granted_at AS g,attempts AS a,last_error AS err,period_start AS ps,period_end AS pe FROM credit_grants WHERE invoice_id='in_1' AND kind='period'").first();
      const grantAlert = () => env.DB.prepare(`SELECT id,kind,severity,detail,resolved_at AS r,delivered_at AS dl FROM cloud_alerts WHERE home_id='home-1' AND kind='credit.grant_pending'
        ORDER BY raised_at DESC,rowid DESC LIMIT 1`).first<{ id: string; kind: string; severity: string; detail: string; r: number | null; dl: number | null }>();
      const alertDetail = async () => JSON.parse((await grantAlert())!.detail) as { grantIds: string[]; grants: { invoiceId: string; kind: string; error: string }[]; revision?: number };
      const openGrantAlerts = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE home_id='home-1' AND kind='credit.grant_pending' AND resolved_at IS NULL");
      const stubLogRows = () => count("SELECT COUNT(*) AS n FROM flux_hook_stub_log WHERE hook='grantMonthlyCredits'");
      const grants = () => fluxLog.filter((l) => l.hook === "grant");
      const stubbedPaidMonth = async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        const spy = vi.spyOn(flux, "grantMonthlyCredits").mockImplementation(stubGrantMonthlyCredits);
        expect((await hook(stripeEvent("invoice.paid", invoice()))).status).toBe(200);
        return spy;
      };
      /** env.DB as the route sees it (no D1 session, so every query goes through `prepare`/`batch` here). */
      const dbProxy = (prepare: (sql: string) => void, afterBatch: () => Promise<void> = async () => undefined): D1Database =>
        new Proxy(env.DB, { get(t, k) {
          if (k === "withSession") return undefined;
          if (k === "prepare") return (sql: string) => { prepare(sql); return t.prepare(sql); };
          if (k === "batch") return async (stmts: D1PreparedStatement[]) => { const r = await t.batch(stmts); await afterBatch(); return r; };
          const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
        } });
      it("a: the stub's throw leaves the grant claimed and NOT granted, raises the alert, completes the event and keeps the activation", async () => {
        await stubbedPaidMonth();
        expect(await grantRow()).toEqual({ g: null, a: 1, err: "flux_not_wired", ps: NOW, pe: NOW + 30 * DAY });
        expect(await stubLogRows()).toBe(1);
        const alert = (await grantAlert())!;
        expect({ ...alert, id: undefined, detail: JSON.parse(alert.detail) }).toEqual({ id: undefined, kind: "credit.grant_pending", severity: "high", r: null, dl: null,
          detail: { grantIds: ["in_1:period"], grants: [{ invoiceId: "in_1", kind: "period", error: "flux_not_wired" }] } });
        // the event is done (Stripe is answered 2xx); the paid entry is queued and the period moved: service active, credits pending
        expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL")).toBe(0);
        expect(await count(`SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE home_id='home-1' AND json_extract(payload,'$.status')='paid'
          AND json_extract(payload,'$.eventId')=(SELECT id FROM stripe_events WHERE type='invoice.paid')`)).toBe(1);
        expect(await env.DB.prepare("SELECT current_period_end AS e,status AS s FROM billing_subscriptions").first()).toEqual({ e: NOW + 30 * DAY, s: "active" });
        // the grant stays retriable: every sweep asks again, and still records nothing while the hook fails; the alert is not rewritten
        at(NOW + HOUR); await sweep();
        expect(await grantRow()).toMatchObject({ g: null, a: 2, err: "flux_not_wired" });
        expect((await grantAlert())!.id).toBe(alert.id);
        expect((await alertDetail()).revision).toBeUndefined();
      });
      it("b: once the hook resolves, the sweep grants exactly once with the original input and resolves the alert", async () => {
        const spy = await stubbedPaidMonth();
        spy.mockRestore();
        at(NOW + HOUR); await sweep();
        expect(grants()).toEqual([{ hook: "grant",
          args: { homeId: "home-1", plan: "starter", invoiceId: "in_1", periodStart: NOW, periodEnd: NOW + 30 * DAY, kind: "period" } }]);
        expect(await grantRow()).toMatchObject({ g: NOW + HOUR, err: null });
        expect((await grantAlert())!.r).toBe(NOW + HOUR);
        at(NOW + 2 * HOUR); await sweep();
        await hook(stripeEvent("invoice.paid", invoice())); // a distinct event for the same invoice
        expect(grants()).toHaveLength(1);
      });
      it("c: a pending grant whose reversal was journaled is never asked again; the confirmed reversal closes its alert", async () => {
        const spy = await stubbedPaidMonth();
        await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_1','period','home-1','refund',NULL,?)").bind(NOW + 1).run();
        spy.mockRestore();
        at(NOW + HOUR); await sweep();
        at(NOW + 2 * HOUR); await sweep();
        expect(grants()).toHaveLength(0);
        expect(await stubLogRows()).toBe(1);
        expect(await grantRow()).toMatchObject({ g: null, a: 1 });
        expect(fluxLog.filter((l) => l.hook === "revoke")).toHaveLength(1);
        expect((await grantAlert())!.r).toBe(NOW + HOUR);
        await hook(stripeEvent("invoice.paid", invoice())); // a replay of the invoice asks nothing either
        expect(grants()).toHaveLength(0);
      });
      it("STUB-1 #1: a D1 failure at the fence is not a grant attempt: it propagates, the event is NOT processed, nothing is recorded; the retry grants", async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        const subBefore = await env.DB.prepare("SELECT current_period_start AS s,current_period_end AS e,status FROM billing_subscriptions").first();
        let armed = false, failed = 0;
        const keep = envOver;
        envOver = { ...keep, DB: dbProxy((sql) => {
          if (sql.includes("INSERT INTO credit_grants")) armed = true;
          else if (armed && sql.startsWith("UPDATE billing_home_leases SET lease_until")) { armed = false; failed++; throw new Error("D1_ERROR: Network connection lost."); }
        }) };
        await hook(stripeEvent("invoice.paid", invoice()));
        envOver = keep;
        expect(failed).toBe(1);
        expect(grants()).toHaveLength(0);
        expect(await env.DB.prepare("SELECT granted_at AS g,attempts AS a,last_error AS err FROM credit_grants WHERE invoice_id='in_1'").first()).toEqual({ g: null, a: 0, err: null });
        expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE type='invoice.paid' AND processed_at IS NULL")).toBe(1);
        expect(await env.DB.prepare("SELECT current_period_start AS s,current_period_end AS e,status FROM billing_subscriptions").first()).toEqual(subBefore);
        expect(await openGrantAlerts()).toBe(0);
        // the stored event is retried (after its backoff) and grants once
        at(NOW + DAY); await sweep();
        expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL")).toBe(0);
        expect(grants()).toHaveLength(1);
        expect(await grantRow()).toMatchObject({ g: NOW + DAY, a: 0 });
      });
      it("STUB-1 #1: the stub's own log failure is not a grant attempt either", async () => {
        await stubbedPaidMonth();
        await env.DB.prepare("ALTER TABLE flux_hook_stub_log RENAME TO flux_hook_stub_log_away").run();
        try { at(NOW + HOUR); await sweep(); } finally { await env.DB.prepare("ALTER TABLE flux_hook_stub_log_away RENAME TO flux_hook_stub_log").run(); }
        expect(await grantRow()).toMatchObject({ g: null, a: 1, err: "flux_not_wired" });
        // not an attempt, but the claim's scheduling stamp moved (written before B4 is asked, Astra STUB-2 #2)
        expect(await env.DB.prepare("SELECT last_attempt_at AS t FROM credit_grants WHERE invoice_id='in_1'").first()).toEqual({ t: NOW + HOUR });
        at(NOW + 2 * HOUR); await sweep();
        expect(await grantRow()).toMatchObject({ g: null, a: 2 });
      });
      it("STUB-1 #2: a re-subscription never receives an ended contract's pending grant: the claim is suppressed and listed with why", async () => {
        const spy = await stubbedPaidMonth();
        expect(await env.DB.prepare("SELECT subscription_id AS s FROM credit_grants WHERE invoice_id='in_1'").first()).toEqual({ s: "sub_test1" });
        // the contract ended and the customer subscribed again: a new, active subscription owns the home
        await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='sub_new',status='active' WHERE home_id='home-1'").run();
        spy.mockRestore();
        at(NOW + HOUR); await sweep();
        at(NOW + 2 * HOUR); await sweep();
        expect(grants()).toHaveLength(0);
        expect(await env.DB.prepare("SELECT granted_at AS g,suppressed_at AS at,suppressed_reason AS why FROM credit_grants WHERE invoice_id='in_1'").first())
          .toEqual({ g: null, at: NOW + HOUR, why: "subscription_ended" });
        expect(await openGrantAlerts()).toBe(1);
        expect(await alertDetail()).toEqual({ grantIds: ["in_1:period"], grants: [{ invoiceId: "in_1", kind: "period", error: "subscription_ended" }], revision: 1 });
      });
      it("STUB-1 #3: 25 stale claims of a home (failing, or with no input) never block a newer one; a claim with no input is looked at once", async () => {
        const spy = await stubbedPaidMonth();
        spy.mockImplementation(async (_e, input) => { if (input.invoiceId.startsWith("in_old")) throw new FluxHookRetry("b4_down"); fluxLog.push({ hook: "grant", args: input }); });
        for (let n = 0; n < 25; n++) {
          const id = String(n).padStart(2, "0");
          await env.DB.prepare("INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at) VALUES (?,'period','home-1','starter',?)").bind(`in_legacy${id}`, NOW - 2 * DAY + n).run();
          await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,subscription_id,attempts,last_error)
            VALUES (?,'period','home-1','starter',?,?,?,'sub_test1',3,'b4_down')`).bind(`in_old${id}`, NOW - DAY + n, NOW - DAY, NOW + 29 * DAY).run();
        }
        for (let k = 1; k <= 3; k++) { at(NOW + k * HOUR); await sweep(); }
        expect(grants().map((g) => (g.args as { invoiceId: string }).invoiceId)).toEqual(["in_1"]);
        expect(await grantRow()).toMatchObject({ g: NOW + 3 * HOUR });
        expect(await count("SELECT COUNT(*) AS n FROM credit_grants WHERE invoice_id LIKE 'in_legacy%' AND suppressed_reason='grant_input_missing'")).toBe(25);
        expect(spy.mock.calls.filter(([, i]) => i.invoiceId.startsWith("in_legacy"))).toHaveLength(0);
        expect(await count("SELECT COUNT(*) AS n FROM credit_grants WHERE invoice_id LIKE 'in_old%' AND attempts>=4")).toBe(25); // each asked at least once
        const d = await alertDetail();
        expect(d.grantIds).toHaveLength(50);
        expect(d.grantIds).not.toContain("in_1:period");
      });
      it("STUB-1 #3: 55 other homes whose claims keep failing never keep a home's newer claim out of the sweep", async () => {
        const spy = await stubbedPaidMonth();
        spy.mockImplementation(async (_e, input) => { if (input.homeId !== "home-1") throw new FluxHookRetry("b4_down"); fluxLog.push({ hook: "grant", args: input }); });
        for (let n = 0; n < 55; n++) {
          const h = `h_${String(n).padStart(2, "0")}`;
          await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at) VALUES (?,?,?,'starter','active',?,?)")
            .bind(h, `cus_${h}`, `sub_${h}`, NOW - DAY, NOW - DAY).run();
          await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,subscription_id)
            VALUES (?,'period',?,'starter',?,?,?,?)`).bind(`in_${h}`, h, NOW - DAY, NOW - DAY, NOW + 29 * DAY, `sub_${h}`).run();
        }
        at(NOW + HOUR); await sweep();
        at(NOW + 2 * HOUR); await sweep();
        expect(grants().map((g) => (g.args as { invoiceId: string }).invoiceId)).toEqual(["in_1"]);
        expect(await grantRow()).toMatchObject({ g: NOW + 2 * HOUR });
      });
      it("STUB-1 #4: two pending grants of a home: ONE alert listing both, resolved only when both have landed", async () => {
        const spy = await stubbedPaidMonth();
        at(NOW + 30 * DAY);
        const renewal = invoice({ id: "in_2", billing_reason: "subscription_cycle",
          lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 } }] } });
        expect((await hook(stripeEvent("invoice.paid", renewal, (NOW + 30 * DAY) / 1000))).status).toBe(200);
        expect(await openGrantAlerts()).toBe(1);
        const first = (await grantAlert())!;
        expect(await alertDetail()).toEqual({ grantIds: ["in_1:period", "in_2:period"], revision: 1, grants: [
          { invoiceId: "in_1", kind: "period", error: "flux_not_wired" }, { invoiceId: "in_2", kind: "period", error: "flux_not_wired" }] });
        // the alert was sent; then in_1 lands and in_2 still fails: the same alert, now listing in_2 only, to be sent again
        await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=? WHERE id=?").bind(NOW + 30 * DAY, first.id).run();
        spy.mockImplementation(async (_e, input) => { if (input.invoiceId === "in_2") throw new FluxHookRetry("flux_not_wired"); fluxLog.push({ hook: "grant", args: input }); });
        at(NOW + 30 * DAY + HOUR); await sweep();
        expect(grants().map((g) => (g.args as { invoiceId: string }).invoiceId)).toEqual(["in_1"]);
        expect(await openGrantAlerts()).toBe(1);
        expect((await grantAlert())!).toMatchObject({ id: first.id, r: null, dl: null });
        expect(await alertDetail()).toEqual({ grantIds: ["in_2:period"], grants: [{ invoiceId: "in_2", kind: "period", error: "flux_not_wired" }], revision: 2 });
        spy.mockRestore();
        at(NOW + 30 * DAY + 2 * HOUR); await sweep();
        expect(await openGrantAlerts()).toBe(0);
        expect((await grantAlert())!).toMatchObject({ id: first.id, r: NOW + 30 * DAY + 2 * HOUR });
      });
      it("STUB-1 #5: a worker whose lease is taken over right after its failure batch can never leave a stale alert behind", async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        vi.spyOn(flux, "grantMonthlyCredits").mockImplementation(stubGrantMonthlyCredits);
        let steal = false, stolen = 0;
        const keep = envOver;
        envOver = { ...keep, DB: dbProxy((sql) => { if (sql.includes("attempts=attempts+1")) steal = true; }, async () => {
          if (!steal) return;
          steal = false; stolen++;
          // another worker takes the expired lease, gets B4's grant and records it, closing the home's grant alert
          await env.DB.prepare("UPDATE billing_home_leases SET holder='worker-2',generation=generation+1,lease_until=? WHERE home_id='home-1'").bind(9e15).run();
          await env.DB.prepare("UPDATE credit_grants SET granted_at=?,last_error=NULL WHERE invoice_id='in_1'").bind(NOW + 1).run();
          await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE home_id='home-1' AND kind='credit.grant_pending' AND resolved_at IS NULL").bind(NOW + 1).run();
        }) };
        await hook(stripeEvent("invoice.paid", invoice()));
        envOver = keep;
        expect(stolen).toBe(1);
        expect(await grantRow()).toMatchObject({ g: NOW + 1 });
        expect(await openGrantAlerts()).toBe(0);
      });
      it("STUB-1 #6: the stub's log keeps one row per grant however often it is asked; attempts keep counting", async () => {
        await stubbedPaidMonth();
        for (let k = 1; k <= 5; k++) { at(NOW + k * HOUR); await sweep(); }
        expect(await stubLogRows()).toBe(1);
        const row = (await env.DB.prepare("SELECT payload,at FROM flux_hook_stub_log WHERE hook='grantMonthlyCredits'").first<{ payload: string; at: number }>())!;
        expect(JSON.parse(row.payload)).toMatchObject({ invoiceId: "in_1", grantId: "in_1:period", count: 6 });
        expect(row.at).toBe(NOW + 5 * HOUR);
        expect(await grantRow()).toMatchObject({ g: null, a: 6 });
      });

      const d1Fail = (e: Env) => e.DB.prepare("SELECT x FROM flux_no_such_table").first(); // a real D1 error, unwrapped
      const askedIds = (prefix: string) => grants().map((g) => (g.args as { invoiceId: string }).invoiceId).filter((i) => i.startsWith(prefix));
      it("STUB-2 #1: a REAL hook's own D1 error is not a grant attempt: it propagates, the event is NOT processed, nothing is recorded; the retry grants", async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        const subBefore = await env.DB.prepare("SELECT current_period_start AS s,current_period_end AS e,status FROM billing_subscriptions").first();
        // not the stub: a B4 implementation whose own D1 read fails, and which does NOT wrap that error
        const spy = vi.spyOn(flux, "grantMonthlyCredits").mockImplementation(async (e) => { await d1Fail(e); });
        await hook(stripeEvent("invoice.paid", invoice()));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await grantRow()).toMatchObject({ g: null, a: 0, err: null });
        expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE type='invoice.paid' AND processed_at IS NULL")).toBe(1);
        expect(await env.DB.prepare("SELECT current_period_start AS s,current_period_end AS e,status FROM billing_subscriptions").first()).toEqual(subBefore);
        expect(await openGrantAlerts()).toBe(0);
        spy.mockRestore();
        at(NOW + DAY); await sweep();
        expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL")).toBe(0);
        expect(grants()).toHaveLength(1);
        expect(await grantRow()).toMatchObject({ g: NOW + DAY, a: 0 });
      });
      it("STUB-2 #1: a reversal follows the same contract: a raw error records nothing, only FluxHookRetry is an attempt", async () => {
        await stubbedPaidMonth();
        await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_1','period','home-1','refund',NULL,?)").bind(NOW + 1).run();
        const reversal = () => env.DB.prepare("SELECT attempts AS a,last_error AS err,reversed_at AS r FROM credit_reversals WHERE invoice_id='in_1'").first();
        const spy = vi.spyOn(flux, "revokeCredits").mockImplementation(async (e) => { await d1Fail(e); });
        at(NOW + HOUR); await sweep();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await reversal()).toEqual({ a: 0, err: null, r: null });
        expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.reversal_pending'")).toBe(0);
        spy.mockImplementation(async () => { throw new FluxHookRetry("b4_down"); });
        at(NOW + 2 * HOUR); await sweep();
        expect(await reversal()).toEqual({ a: 1, err: "b4_down", r: null });
      });
      it("STUB-2 #2: an infrastructure failure on a home's first claim never pins it first: the next sweep asks claims 2..20", async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        const ids = Array.from({ length: 20 }, (_, n) => `in_c${String(n + 1).padStart(2, "0")}`);
        for (const [n, id] of ids.entries()) {
          await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,subscription_id)
            VALUES (?,'period','home-1','starter',?,?,?,'sub_test1')`).bind(id, NOW - DAY + n, NOW - DAY, NOW + 29 * DAY).run();
        }
        vi.spyOn(flux, "grantMonthlyCredits").mockImplementation(async (e, input) => {
          if (input.invoiceId === "in_c01") await d1Fail(e);
          fluxLog.push({ hook: "grant", args: input });
        });
        at(NOW + HOUR); await sweep();
        expect(askedIds("in_c")).toEqual([]); // the pass ended at claim 1
        expect(await env.DB.prepare("SELECT attempts AS a,last_error AS err,last_attempt_at AS t FROM credit_grants WHERE invoice_id='in_c01'").first())
          .toEqual({ a: 0, err: null, t: NOW + HOUR });
        at(NOW + 2 * HOUR); await sweep();
        expect(askedIds("in_c")).toEqual(ids.slice(1));
        expect(await count("SELECT COUNT(*) AS n FROM credit_grants WHERE invoice_id LIKE 'in_c%' AND granted_at IS NOT NULL")).toBe(19);
        expect(await env.DB.prepare("SELECT granted_at AS g,attempts AS a FROM credit_grants WHERE invoice_id='in_c01'").first()).toEqual({ g: null, a: 0 });
      });
      it("STUB-2 #2: 50 homes whose claims fail on infrastructure never keep a 51st home out of the next sweep", async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,subscription_id)
          VALUES ('in_mine','period','home-1','starter',?,?,?,'sub_test1')`).bind(NOW - DAY, NOW - DAY, NOW + 29 * DAY).run();
        for (let n = 0; n < 50; n++) {
          const h = `h_${String(n).padStart(2, "0")}`; // sorts before home-1: with equal stamps these 50 fill the pass
          await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at) VALUES (?,?,?,'starter','active',?,?)")
            .bind(h, `cus_${h}`, `sub_${h}`, NOW - DAY, NOW - DAY).run();
          await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,subscription_id)
            VALUES (?,'period',?,'starter',?,?,?,?)`).bind(`in_${h}`, h, NOW - DAY, NOW - DAY, NOW + 29 * DAY, `sub_${h}`).run();
        }
        const spy = vi.spyOn(flux, "grantMonthlyCredits").mockImplementation(async (e, input) => {
          if (input.homeId !== "home-1") await d1Fail(e);
          fluxLog.push({ hook: "grant", args: input });
        });
        at(NOW + HOUR); await sweep();
        expect(askedIds("in_mine")).toEqual([]);
        expect(spy).toHaveBeenCalledTimes(50);
        at(NOW + 2 * HOUR); await sweep();
        expect(askedIds("in_mine")).toEqual(["in_mine"]);
        expect(await env.DB.prepare("SELECT granted_at AS g FROM credit_grants WHERE invoice_id='in_mine'").first()).toEqual({ g: NOW + 2 * HOUR });
      });
      it("STUB-2 #3: an escalated claim stays in the alert when a later attempt fails for another reason, until it is granted", async () => {
        const spy = await stubbedPaidMonth(); // flux_not_wired: escalated
        expect(await openGrantAlerts()).toBe(1);
        spy.mockImplementation(async () => { throw new FluxHookRetry("b4_busy"); });
        at(NOW + HOUR); await sweep();
        expect(await grantRow()).toMatchObject({ g: null, a: 2, err: "b4_busy" });
        expect(await openGrantAlerts()).toBe(1);
        expect(await alertDetail()).toMatchObject({ grantIds: ["in_1:period"], grants: [{ invoiceId: "in_1", kind: "period", error: "b4_busy" }] });
        spy.mockRestore();
        at(NOW + 2 * HOUR); await sweep();
        expect(await grantRow()).toMatchObject({ g: NOW + 2 * HOUR });
        expect(await openGrantAlerts()).toBe(0);
      });
      it("STUB-2 #4: a journaled but unconfirmed reversal keeps its claim in the alert; another grant landing never resolves it", async () => {
        const spy = await stubbedPaidMonth();
        at(NOW + 30 * DAY);
        const renewal = invoice({ id: "in_2", billing_reason: "subscription_cycle",
          lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 } }] } });
        expect((await hook(stripeEvent("invoice.paid", renewal, (NOW + 30 * DAY) / 1000))).status).toBe(200);
        expect((await alertDetail()).grantIds).toEqual(["in_1:period", "in_2:period"]);
        // in_1's invoice was refunded: its reversal is journaled, and B4 cannot apply it yet
        await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_1','period','home-1','refund',NULL,?)").bind(NOW + 30 * DAY).run();
        revokeFails = 100;
        spy.mockRestore(); // in_2 lands
        at(NOW + 30 * DAY + HOUR); await sweep();
        expect(grants().map((g) => (g.args as { invoiceId: string }).invoiceId)).toEqual(["in_2"]); // in_1 is never asked again
        expect(await env.DB.prepare("SELECT reversed_at AS r FROM credit_reversals WHERE invoice_id='in_1'").first()).toEqual({ r: null });
        expect(await openGrantAlerts()).toBe(1);
        expect((await alertDetail()).grantIds).toEqual(["in_1:period"]);
        revokeFails = 0; // B4 confirms the reversal: only now does the claim leave the alert
        at(NOW + 30 * DAY + 2 * HOUR); await sweep();
        expect(await env.DB.prepare("SELECT reversed_at AS r FROM credit_reversals WHERE invoice_id='in_1'").first()).toEqual({ r: NOW + 30 * DAY + 2 * HOUR });
        expect(await openGrantAlerts()).toBe(0);
      });
      it("STUB-2 #5: the stub's grant log stays ONE row when a successor writes it right after the first worker's write (lease takeover)", async () => {
        const input = { homeId: "home-1", plan: "starter", invoiceId: "in_1", periodStart: NOW, periodEnd: NOW + 30 * DAY, kind: "period" as const };
        let successor: Promise<unknown> | null = null;
        const db = new Proxy(env.DB, { get(t, k) {
          if (k === "prepare") return (sql: string) => {
            const st = t.prepare(sql);
            if (successor || !sql.includes("flux_hook_stub_log")) return st;
            return { bind: (...a: unknown[]) => { const b = st.bind(...a); return { run: async () => {
              const r = await b.run();
              // the first worker stalls right after its first log statement; its lease expires and a successor asks for the same grant
              successor = stubGrantMonthlyCredits(env, input).catch((e: unknown) => e);
              await successor;
              return r;
            } }; } };
          };
          const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
        } });
        await expect(stubGrantMonthlyCredits({ ...env, DB: db } as unknown as Env, input)).rejects.toBeInstanceOf(FluxHookRetry);
        expect(await successor).toBeInstanceOf(FluxHookRetry);
        expect(await stubLogRows()).toBe(1);
        const row = (await env.DB.prepare("SELECT grant_id AS g,payload FROM flux_hook_stub_log WHERE hook='grantMonthlyCredits'").first<{ g: string; payload: string }>())!;
        expect(row.g).toBe("in_1:period");
        expect(JSON.parse(row.payload)).toMatchObject({ grantId: "in_1:period", count: 2 });
        // the unique key itself refuses a second row for the grant
        await expect(env.DB.prepare("INSERT INTO flux_hook_stub_log (hook,grant_id,payload,at) VALUES ('grantMonthlyCredits','in_1:period','{}',0)").run()).rejects.toThrow();
      });
      it("STUB-3 #1: a raw error on a home's oldest reversal never blocks its sibling, and 50 failing homes never keep a 51st home out", async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        const rev = (inv: string, h: string, t: number) => env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES (?,'period',?,'refund',NULL,?)")
          .bind(inv, h, t).run();
        await rev("in_r1", "home-1", NOW); await rev("in_r2", "home-1", NOW + 1);
        for (let n = 0; n < 50; n++) { const h = `h_${String(n).padStart(2, "0")}`; await rev(`in_${h}`, h, NOW); } // sort before home-1
        const revoked: string[] = [];
        const spy = vi.spyOn(flux, "revokeCredits").mockImplementation(async (e, input) => { if (input.invoiceId !== "in_r2") await d1Fail(e); revoked.push(input.invoiceId); });
        const step = HOUR / 6;
        at(NOW + step); await sweep();
        expect(spy).toHaveBeenCalledTimes(50); // the 50 failing homes filled the pass
        expect(spy.mock.calls.some(([, i]) => i.homeId === "home-1")).toBe(false);
        spy.mockClear();
        at(NOW + 2 * step); await sweep();
        // home-1, never tried, goes first: its oldest reversal fails raw and ends the home's pass before in_r2
        expect(spy.mock.calls[0][1]).toMatchObject({ homeId: "home-1", invoiceId: "in_r1" });
        expect(revoked).toEqual([]);
        expect(await env.DB.prepare("SELECT tries AS t,attempts AS a,last_attempt_at AS l FROM credit_reversals WHERE invoice_id='in_r1'").first())
          .toEqual({ t: 1, a: 0, l: NOW + 2 * step });
        spy.mockClear();
        at(NOW + 3 * step); await sweep();
        // the next sweep takes the untried sibling first: it is reversed although in_r1 still fails raw
        expect(spy.mock.calls.filter(([, i]) => i.homeId === "home-1").map(([, i]) => i.invoiceId)).toEqual(["in_r2", "in_r1"]);
        expect(revoked).toEqual(["in_r2"]);
        expect(await env.DB.prepare("SELECT reversed_at AS r FROM credit_reversals WHERE invoice_id='in_r2'").first()).toEqual({ r: NOW + 3 * step });
        expect(await env.DB.prepare("SELECT reversed_at AS r,attempts AS a FROM credit_reversals WHERE invoice_id='in_r1'").first()).toEqual({ r: null, a: 0 });
        // h_00 has now failed raw 3 times: its next ask tells ops (STUB-3 #2), and the error still propagates
        at(NOW + 4 * step); await sweep();
        const ra = await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE id='alert:credit_reversal:in_h_00:period' AND resolved_at IS NULL").first<{ detail: string }>();
        expect(JSON.parse(ra!.detail)).toMatchObject({ invoiceId: "in_h_00", error: "infra_failing" });
        expect(await env.DB.prepare("SELECT attempts AS a,reversed_at AS r FROM credit_reversals WHERE invoice_id='in_h_00'").first()).toEqual({ a: 0, r: null });
      });
      it("STUB-3 #2: a claim whose retries keep failing RAW after one FluxHookRetry completed its event reaches ops (infra_failing)", async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        const spy = vi.spyOn(flux, "grantMonthlyCredits").mockImplementation(async () => { throw new FluxHookRetry("b4_busy"); });
        expect((await hook(stripeEvent("invoice.paid", invoice()))).status).toBe(200);
        expect(await count("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL")).toBe(0); // event_stuck can never fire
        expect(await grantRow()).toMatchObject({ g: null, a: 1, err: "b4_busy" });
        expect(await openGrantAlerts()).toBe(0);
        spy.mockImplementation(async (e) => { await d1Fail(e); });
        const step = HOUR / 6;
        for (let n = 1; n <= 3; n++) { at(NOW + n * step); await sweep(); }
        expect(await openGrantAlerts()).toBe(0);
        at(NOW + 4 * step); await sweep(); // three raw failures behind it: this ask's stamp escalates the claim
        expect(spy).toHaveBeenCalledTimes(5);
        expect(await grantRow()).toMatchObject({ g: null, a: 1 });
        expect(await openGrantAlerts()).toBe(1);
        expect(await alertDetail()).toMatchObject({ grantIds: ["in_1:period"], grants: [{ invoiceId: "in_1", kind: "period", error: "infra_failing" }] });
        spy.mockRestore(); vi.spyOn(flux, "grantMonthlyCredits").mockImplementation(async (_e, input) => { fluxLog.push({ hook: "grant", args: input }); });
        at(NOW + 5 * step); await sweep();
        expect(await grantRow()).toMatchObject({ g: NOW + 5 * step });
        expect(await openGrantAlerts()).toBe(0);
      });
      it("STUB-3 #2: a claim or reversal still pending 2 hours after it was made reaches ops (pending_too_long)", async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,subscription_id)
          VALUES ('in_1','period','home-1','starter',?,?,?,'sub_test1')`).bind(NOW, NOW, NOW + 30 * DAY).run();
        await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_9','period','home-1','refund',NULL,?)").bind(NOW).run();
        vi.spyOn(flux, "grantMonthlyCredits").mockImplementation(async (e) => { await d1Fail(e); });
        vi.spyOn(flux, "revokeCredits").mockImplementation(async (e) => { await d1Fail(e); });
        const reversalAlerts = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.reversal_pending' AND resolved_at IS NULL");
        at(NOW + HOUR); await sweep();
        expect(await openGrantAlerts()).toBe(0);
        expect(await reversalAlerts()).toBe(0);
        at(NOW + 2 * HOUR); await sweep();
        expect(await openGrantAlerts()).toBe(1);
        expect(await alertDetail()).toMatchObject({ grantIds: ["in_1:period"], grants: [{ invoiceId: "in_1", error: "pending_too_long" }] });
        const ra = await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE id='alert:credit_reversal:in_9:period'").first<{ detail: string }>();
        expect(JSON.parse(ra!.detail)).toMatchObject({ invoiceId: "in_9", error: "pending_too_long" });
        expect(await grantRow()).toMatchObject({ g: null, a: 0 });
      });
      it("STUB-3 #3: an ops clearance holds through later rebuilds until a NEW failed ask after it, which lists the claim again", async () => {
        const spy = await stubbedPaidMonth(); // flux_not_wired: escalated
        expect(await openGrantAlerts()).toBe(1);
        await env.DB.prepare("UPDATE credit_grants SET alerted_at=NULL,cleared_at=?,cleared_tries=tries WHERE invoice_id='in_1'").bind(NOW + HOUR).run();
        spy.mockImplementation(async (_e, input) => { if (input.invoiceId === "in_1") throw new FluxHookRetry("b4_busy"); fluxLog.push({ hook: "grant", args: input }); });
        // a rebuild with no new ask of in_1 (the renewal's grant lands), while in_1 still qualifies by flux_not_wired AND by age: it stays cleared
        at(NOW + 30 * DAY);
        const renewal = invoice({ id: "in_2", billing_reason: "subscription_cycle",
          lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 } }] } });
        expect((await hook(stripeEvent("invoice.paid", renewal, (NOW + 30 * DAY) / 1000))).status).toBe(200);
        expect(await env.DB.prepare("SELECT granted_at AS g FROM credit_grants WHERE invoice_id='in_2'").first()).toEqual({ g: NOW + 30 * DAY });
        expect(spy.mock.calls.filter(([, i]) => i.invoiceId === "in_1")).toHaveLength(1);
        expect(await env.DB.prepare("SELECT alerted_at AS t,last_error AS err FROM credit_grants WHERE invoice_id='in_1'").first()).toEqual({ t: null, err: "flux_not_wired" });
        expect(await openGrantAlerts()).toBe(0);
        // a new failed ask after the clearance lists it again; completion records are untouched
        at(NOW + 30 * DAY + HOUR); await sweep();
        expect(await grantRow()).toMatchObject({ g: null, a: 2, err: "b4_busy" });
        expect(await openGrantAlerts()).toBe(1);
        expect(await alertDetail()).toMatchObject({ grantIds: ["in_1:period"], grants: [{ invoiceId: "in_1", error: "b4_busy" }] });
        expect(await env.DB.prepare("SELECT granted_at AS g FROM credit_grants WHERE invoice_id='in_2'").first()).toEqual({ g: NOW + 30 * DAY });
      });
      const reversalAlertRows = () => env.DB.prepare("SELECT resolved_at AS r,detail FROM cloud_alerts WHERE id='alert:credit_reversal:in_9:period'").first<{ r: number | null; detail: string }>();
      it("STUB-4 #1: a failure of a reversal after its alert was resolved reopens the alert", async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_9','period','home-1','refund',NULL,?)").bind(NOW).run();
        vi.spyOn(flux, "revokeCredits").mockImplementation(async (e) => { await d1Fail(e); });
        at(NOW + 2 * HOUR); await sweep();
        expect(await reversalAlertRows()).toMatchObject({ r: null });
        await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE id='alert:credit_reversal:in_9:period'").bind(NOW + 2 * HOUR).run();
        at(NOW + 3 * HOUR); await sweep();
        const again = (await reversalAlertRows())!;
        expect(again.r).toBeNull();
        expect(JSON.parse(again.detail)).toMatchObject({ invoiceId: "in_9", error: "pending_too_long", revision: 1 });
        expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.reversal_pending' AND resolved_at IS NULL")).toBe(1);
      });
      it("STUB-4 #2: clearing a home's only (suppressed) claim closes its alert at the next sweep", async () => {
        await stubbedPaidMonth();
        await env.DB.prepare("UPDATE credit_grants SET suppressed_at=?,suppressed_reason='subscription_ended' WHERE invoice_id='in_1'").bind(NOW).run();
        expect(await openGrantAlerts()).toBe(1);
        await env.DB.prepare("UPDATE credit_grants SET alerted_at=NULL,cleared_at=?,cleared_tries=tries WHERE invoice_id='in_1'").bind(NOW + HOUR).run();
        at(NOW + 2 * HOUR); await sweep();
        expect(await openGrantAlerts()).toBe(0);
      });
      it("STUB-4 #3: a suppression that lands after a clearance made during the sweep (earlier sweep time) still lists the claim", async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,cleared_at,cleared_tries)
          VALUES ('in_1','period','home-1','starter',?,?,0)`).bind(NOW, NOW + DAY).run();
        at(NOW + HOUR); await sweep(); // suppressed as grant_input_missing at a time BEFORE cleared_at
        expect(await env.DB.prepare("SELECT suppressed_reason AS s,alerted_at AS a FROM credit_grants WHERE invoice_id='in_1'").first()).toEqual({ s: "grant_input_missing", a: NOW + HOUR });
        expect(await openGrantAlerts()).toBe(1);
        expect(await alertDetail()).toMatchObject({ grantIds: ["in_1:period"] });
      });
      it("STUB-4 #4: a reversal with attempts=2 and tries backfilled from them escalates after the normal count of raw failures", async () => {
        await order("FR");
        await hook(stripeEvent("checkout.session.completed", await sessionObj()));
        await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at,attempts,tries) VALUES ('in_9','period','home-1','refund',NULL,?,2,2)").bind(NOW).run();
        vi.spyOn(flux, "revokeCredits").mockImplementation(async (e) => { await d1Fail(e); });
        for (let i = 1; i <= 3; i++) { at(NOW + i * 1000); await sweep(); }
        expect(await reversalAlertRows()).toBeNull();
        at(NOW + 4000); await sweep();
        expect(JSON.parse((await reversalAlertRows())!.detail)).toMatchObject({ error: "infra_failing" });
      });
    });
    it("r3-4 an unpaid rejection whose payment clears later: the delayed email states the refund from the ledger, never 'nothing was charged'", async () => {
      await order("DE");
      const mails: { subject: string; text: string; html?: string }[] = []; let mailDown = true;
      envOver = { ...envOver, EMAIL: { async send(m: { subject: string; text: string; html?: string }) { if (mailDown) throw new Error("mail_down"); mails.push(m); } } } as unknown as Partial<Env>;
      const real: BillingDependencies = { ...deps(), notifier: undefined };
      const via = async (type: string, object: Record<string, unknown>) => {
        const raw = JSON.stringify(stripeEvent(type, object));
        return send("/v1/billing/webhook", { raw, headers: { "stripe-signature": await signStripePayload(raw, WHSEC, Math.floor(Date.now() / 1000)) } }, real);
      };
      const billedAt = { customer_details: { address: { country: "AT" } } };
      expect((await via("checkout.session.completed", await sessionObj(billedAt, "unpaid"))).status).toBe(200);
      const stored0 = JSON.parse((await env.DB.prepare("SELECT payload,sent_at FROM billing_notices WHERE kind='order_rejected'").first<{ payload: string }>())!.payload) as { source: Record<string, unknown> };
      expect(stored0.source).toMatchObject({ opId: null, invoiceId: "in_1", subscriptionId: "sub_test1" });
      // the payment clears after the rejection: refunded in full through the ledger
      at(NOW + HOUR);
      expect((await via("checkout.session.async_payment_succeeded", await sessionObj(billedAt, "paid"))).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE invoice_id='in_1' AND paid_cents=4900")).toBe(1);
      mailDown = false; at(NOW + DAY);
      await sweepBilling(baseEnv(envOver), real).catch(() => undefined);
      const mail = mails.find((m) => m.text.includes("(Österreich)"))!;
      expect(mail.text).toContain("Wir erstatten Ihre Zahlung vollständig.");
      expect(mail.text).not.toContain("es wurde also nichts abgebucht");
      const stored = JSON.parse((await env.DB.prepare("SELECT payload FROM billing_notices WHERE kind='order_rejected'").first<{ payload: string }>())!.payload) as { emailText: string };
      expect(stored.emailText).toBe(mail.text);
    });
    it("checklist: wrong path alone (declared = billed = FR, but the order's path no longer covers FR) is a mismatch at the webhook: refunded, nothing provisioned", async () => {
      await order("FR"); // a Link (Managed Payments) order
      envOver = { CLOUD_NONUS_SELLER: "direct", FERROX_TAX_COUNTRIES: "US,DE" } as Partial<Env>; // the direct path covers no FR
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj()))).status).toBe(200);
      expect(await consentRow()).toMatchObject({ rejected_reason: "mismatch", paid_at: null });
      const op = (await env.DB.prepare("SELECT kind,amount_cents AS a,detail FROM refund_ops").first<{ kind: string; a: number; detail: string }>())!;
      expect(op).toMatchObject({ kind: "mismatch", a: 4900 });
      expect(JSON.parse(op.detail)).toMatchObject({ path: "mp" }); // refunded on the order's own path
      expect(subDeletes()).toHaveLength(1);
      expect(await inbox()).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM checkout_retry_routes")).toBe(0); // no path covers FR now: no retry route is offered
    });
    it("checklist: an unsupported country (declared = billed, covered by no path) is a mismatch at the webhook: refunded, nothing provisioned", async () => {
      await order("FR");
      const id = await latestConsentId("home-1");
      await env.DB.prepare("UPDATE checkout_consents SET declared_country='AQ', billing_country='AQ' WHERE id=?").bind(id).run();
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj({ customer_details: { address: { country: "AQ" } } })))).status).toBe(200);
      expect(await consentRow()).toMatchObject({ rejected_reason: "mismatch", paid_at: null });
      expect(await env.DB.prepare("SELECT kind,amount_cents AS a FROM refund_ops").first()).toEqual({ kind: "mismatch", a: 4900 });
      expect(refundPosts()).toHaveLength(1);
      expect(subDeletes()).toHaveLength(1);
      expect(await inbox()).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM checkout_retry_routes")).toBe(0);
      expect((notices.find((n) => n.kind === "order_rejected")!.data as { emailText: string }).emailText).toContain("We are refunding your payment in full.");
    });
  });
  describe("Astra WP5-4 (round 4): one test per finding", () => {
    const sweep = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    const HOUR = 3_600_000;
    const parkedOrder = async () => {
      await order("FR");
      const id = await latestConsentId("home-1");
      const good = (await env.DB.prepare("SELECT wording,disclosure FROM checkout_consents WHERE id=?").bind(id).first<{ wording: string; disclosure: string }>())!;
      await env.DB.prepare("UPDATE checkout_consents SET wording='{}', disclosure=NULL WHERE id=?").bind(id).run();
      await hook(stripeEvent("checkout.session.completed", await sessionObj()));
      expect((await consentRow())!.acceptance_parked_at).toBe(NOW);
      const repair = () => env.DB.prepare("UPDATE checkout_consents SET wording=?, disclosure=? WHERE id=?").bind(good.wording, good.disclosure, id).run();
      return { id, repair };
    };
    const consentOf = (id: string) => env.DB.prepare("SELECT acceptance_parked_at AS p, rejected_at AS r, rejected_reason AS why FROM checkout_consents WHERE id=?").bind(id).first();
    const homeSub = () => env.DB.prepare("SELECT subscription_id AS s, status FROM billing_subscriptions WHERE home_id='home-1'").first();
    const homeState = () => env.DB.prepare("SELECT desired_state AS d, entitlement AS e FROM cloud_homes WHERE id='home-1'").first();
    const released = () => env.DB.prepare("SELECT COUNT(*) AS n, MAX(detail) AS d FROM cloud_alerts WHERE kind='checkout.parked_order_released'").first<{ n: number; d: string | null }>();
    const newSubDeletes = () => stripeCalls.filter((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_new");
    const subDeleted = () => stripeEvent("customer.subscription.deleted", { object: "subscription", id: "sub_test1", customer: "cus_test1", status: "canceled",
      items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }, NOW / 1000 + 5);

    it("r4-1 an old order completed (parking left behind), then a replacement takes the home: the sweep leaves the replacement alone, releases the old parking, refunds nothing, one alert", async () => {
      const { id, repair } = await parkedOrder();
      await repair();
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj()))).status).toBe(200);
      expect(await inbox()).toBe(1); // provisioned under sub_test1
      // a parking mark left behind by an older build
      await env.DB.prepare("UPDATE checkout_consents SET acceptance_parked_at=? WHERE id=?").bind(NOW, id).run();
      // the old subscription ends and a replacement takes the home
      expect((await hook(subDeleted())).status).toBe(200);
      await env.DB.prepare("UPDATE open_checkouts SET state='failed'").run();
      await env.DB.prepare("UPDATE cloud_homes SET desired_state='payment_pending', entitlement='pending' WHERE id='home-1'").run();
      at(NOW + HOUR);
      expect((await checkout("starter", { billingCountry: "FR", earlyStart: true })).status).toBe(200);
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj({ id: "cs_new", subscription: "sub_new", invoice: "in_new" })))).status).toBe(200);
      expect(await homeSub()).toEqual({ s: "sub_new", status: "active" });
      const home = await homeState();
      const refunds = await count("SELECT COUNT(*) AS n FROM refund_ops");
      at(NOW + 24 * HOUR); await sweep();
      at(NOW + 25 * HOUR); await sweep();
      expect(await homeSub()).toEqual({ s: "sub_new", status: "active" });
      expect(await homeState()).toEqual(home);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id LIKE 'reject:%'")).toBe(0);
      expect(await consentOf(id)).toEqual({ p: null, r: null, why: null });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(refunds);
      expect(refundPosts()).toHaveLength(0);
      expect(newSubDeletes()).toHaveLength(0);
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions")).toBe(0);
      const alert = (await released())!;
      expect(alert.n).toBe(1);
      expect(JSON.parse(alert.d!)).toMatchObject({ consentId: id, reason: "completed_earlier", subscriptionId: "sub_test1", currentSubscriptionId: "sub_new" });
    });
    // Astra WP5-5 #1: a parked paid order whose subscription no longer owns the home is still refunded in full after 24 hours (its OWN
    // subscription cancelled, its own invoice refunded), and nothing the home has now is touched.
    const provisionedEvidence = (paymentId: string) => env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
      .bind(`evt_prov_${paymentId}`, "home-1", NOW, JSON.stringify({ eventId: `evt_prov_${paymentId}`, homeId: "home-1", version: NOW, status: "paid", paymentId }), NOW).run();
    const replacementOwnsHome = () => env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,consent_id,created_at,updated_at)
      VALUES ('home-1','cus_test1','sub_new','starter','active','consent_other',?,?) ON CONFLICT(home_id) DO UPDATE SET subscription_id='sub_new',consent_id='consent_other',status='active'`)
      .bind(NOW, NOW).run();
    const expectDisplacedRefund = async (id: string, sub: string, invoice: string) => {
      expect(await consentOf(id)).toMatchObject({ r: expect.any(Number), why: "rejected_consent" });
      expect(await env.DB.prepare("SELECT kind,amount_cents AS a,end_plan AS e,cancel_subscription_id AS c,done_at IS NOT NULL AS done FROM refund_ops WHERE invoice_id=?").bind(invoice).first())
        .toEqual({ kind: "rejected_consent", a: 4900, e: 0, c: sub, done: 1 });
      expect(stripeCalls.filter((x) => x.method === "DELETE" && x.path === `/v1/subscriptions/${sub}`)).toHaveLength(1);
    };
    const expectHomeUntouched = async (home: unknown, sub: unknown) => {
      expect(await homeSub()).toEqual(sub);
      expect(await homeState()).toEqual(home);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id LIKE 'reject:%'")).toBe(0);
      expect(newSubDeletes()).toHaveLength(0);
      expect(fluxLog.filter((f) => f.hook === "stop")).toHaveLength(0);
    };
    it("r5-1 a parked paid order with provisioning evidence whose subscription no longer owns the home: refunded in full, its own subscription cancelled, the replacement untouched, one alert", async () => {
      const { id } = await parkedOrder(); // never completed: no acceptance on record
      await provisionedEvidence("in_1");
      await replacementOwnsHome();
      const home = await homeState();
      at(NOW + 24 * HOUR); await sweep();
      at(NOW + 25 * HOUR); await sweep();
      await expectDisplacedRefund(id, "sub_test1", "in_1");
      expect(refundPosts()).toHaveLength(1);
      await expectHomeUntouched(home, { s: "sub_new", status: "active" });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind LIKE 'checkout.%' AND resolved_at IS NULL")).toBe(1);
      const alert = (await released())!;
      expect(alert.n).toBe(1);
      expect(JSON.parse(alert.d!)).toMatchObject({ consentId: id, reason: "not_current_subscription", subscriptionId: "sub_test1", currentSubscriptionId: "sub_new",
        opId: "rejected_consent:in_1", refundRequested: true });
    });
    it("r5-1 the same with no current subscription on the home at all: refunded in full, its own subscription cancelled, the home untouched, one alert", async () => {
      const { id } = await parkedOrder();
      await provisionedEvidence("in_1");
      await env.DB.prepare("DELETE FROM billing_subscriptions WHERE home_id='home-1'").run();
      const home = await homeState();
      at(NOW + 24 * HOUR); await sweep();
      at(NOW + 25 * HOUR); await sweep();
      await expectDisplacedRefund(id, "sub_test1", "in_1");
      expect(refundPosts()).toHaveLength(1);
      await expectHomeUntouched(home, null);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind LIKE 'checkout.%' AND resolved_at IS NULL")).toBe(1);
      expect(JSON.parse((await released())!.d!)).toMatchObject({ consentId: id, reason: "not_current_subscription", subscriptionId: "sub_test1", currentSubscriptionId: null });
    });
    it("r5-2 two displaced parked orders on one home: both refunded, ONE alert naming both orders, re-armed for delivery when the second is added", async () => {
      const { id } = await parkedOrder();
      // a second parked order of the same home (its own subscription, invoice and payment), parked an hour later
      await env.DB.prepare("CREATE TABLE tmp_c AS SELECT * FROM checkout_consents WHERE id=?").bind(id).run();
      await env.DB.prepare("UPDATE tmp_c SET id='consent_two', stripe_subscription_id='sub_two', created_at=created_at+1, acceptance_parked_at=acceptance_parked_at+?").bind(HOUR).run();
      await env.DB.prepare("INSERT INTO checkout_consents SELECT * FROM tmp_c").run();
      await env.DB.prepare("DROP TABLE tmp_c").run();
      await env.DB.prepare(`CREATE TABLE tmp_e AS SELECT * FROM stripe_events WHERE type='checkout.session.completed'
        AND json_extract(payload,'$.data.object.metadata.consent_id')=?`).bind(id).run();
      await env.DB.prepare(`UPDATE tmp_e SET id='evt_two', payload=json_set(payload,'$.data.object.metadata.consent_id','consent_two','$.data.object.subscription','sub_two',
        '$.data.object.invoice','in_two','$.data.object.id','cs_two')`).run();
      await env.DB.prepare("INSERT INTO stripe_events SELECT * FROM tmp_e").run();
      await env.DB.prepare("DROP TABLE tmp_e").run();
      invoiceSubs = { in_two: "sub_two" }; piInvoices = { pi_two: "in_two" };
      await provisionedEvidence("in_1");
      await provisionedEvidence("in_two");
      await replacementOwnsHome();
      const home = await homeState();
      at(NOW + 24 * HOUR); await sweep(); // the first order only
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(1);
      // ops has been sent the first alert before the second order is added
      await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=?, delivery_attempts=1 WHERE kind='checkout.parked_order_released'").bind(NOW + 24 * HOUR).run();
      at(NOW + 25 * HOUR); await sweep();
      at(NOW + 26 * HOUR); await sweep();
      await expectDisplacedRefund(id, "sub_test1", "in_1");
      await expectDisplacedRefund("consent_two", "sub_two", "in_two");
      await expectHomeUntouched(home, { s: "sub_new", status: "active" });
      const rows = (await env.DB.prepare("SELECT detail,delivered_at AS dl FROM cloud_alerts WHERE kind='checkout.parked_order_released'")
        .all<{ detail: string; dl: number | null }>()).results;
      expect(rows).toHaveLength(1);
      const d = JSON.parse(rows[0].detail) as { consentIds: string[]; items: { consentId: string; subscriptionId: string }[] };
      expect([...d.consentIds].sort()).toEqual(["consent_two", id].sort());
      expect(d.items.map((x) => x.subscriptionId).sort()).toEqual(["sub_test1", "sub_two"]);
      // re-armed when it changed (or already delivered again, with the new list)
      expect(rows[0].dl === null || rows[0].dl > NOW + 24 * HOUR).toBe(true);
    });
    // Astra WP5-6 (round 6): one test per finding.
    const addSecondParkedOrder = async (id: string) => {
      await env.DB.prepare("CREATE TABLE tmp_c AS SELECT * FROM checkout_consents WHERE id=?").bind(id).run();
      await env.DB.prepare("UPDATE tmp_c SET id='consent_two', stripe_subscription_id='sub_two', created_at=created_at+1, acceptance_parked_at=acceptance_parked_at+?").bind(HOUR).run();
      await env.DB.prepare("INSERT INTO checkout_consents SELECT * FROM tmp_c").run();
      await env.DB.prepare("DROP TABLE tmp_c").run();
      await env.DB.prepare(`CREATE TABLE tmp_e AS SELECT * FROM stripe_events WHERE type='checkout.session.completed'
        AND json_extract(payload,'$.data.object.metadata.consent_id')=?`).bind(id).run();
      await env.DB.prepare(`UPDATE tmp_e SET id='evt_two', payload=json_set(payload,'$.data.object.metadata.consent_id','consent_two','$.data.object.subscription','sub_two',
        '$.data.object.invoice','in_two','$.data.object.id','cs_two')`).run();
      await env.DB.prepare("INSERT INTO stripe_events SELECT * FROM tmp_e").run();
      await env.DB.prepare("DROP TABLE tmp_e").run();
      invoiceSubs = { in_two: "sub_two" }; piInvoices = { pi_two: "in_two" };
    };
    // A granted claim with its frozen amount (the target of a refund-backed reversal is computed from it).
    const grant = (invoice: string) => env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,granted_at,body_json,body_sha256)
      VALUES (?,'period','home-1','starter',?,?,'{"amount_microcents":5000000}','x')`).bind(invoice, NOW, NOW).run();
    const revokes = () => fluxLog.filter((f) => f.hook === "revoke");
    const targets = () => fluxLog.filter((f) => f.hook === "target");
    const opsEnv = () => baseEnv({ ...envOver, ALERT_WEBHOOK_URL: "https://hooks.example.test/x" } as Partial<Env>);
    it("r6-1 a displaced order is refunded, then the lifecycle reconciles: its paid entry provisions nothing, and the replacement's own payment still does", async () => {
      const { id } = await parkedOrder();
      await provisionedEvidence("in_1");
      await replacementOwnsHome();
      at(NOW + 24 * HOUR); await sweep();
      await expectDisplacedRefund(id, "sub_test1", "in_1");
      // the home is waiting for a payment, and the refunded order's paid entry is still unprocessed
      await env.DB.prepare("UPDATE cloud_homes SET desired_state='failed', entitlement='pending', payment_version=0 WHERE id='home-1'").run();
      expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id='evt_prov_in_1' AND processed_at IS NULL")).toBe(1);
      const capacity = () => env.DB.prepare("SELECT id,home_id,expires_at FROM cloud_capacity ORDER BY id").all().then((r) => r.results);
      expect((await reconcile()).status).toBe(200); // seeds the capacity rows once
      const slots = await capacity();
      await env.DB.prepare("UPDATE cloud_payment_inbox SET processed_at=NULL WHERE id='evt_prov_in_1'").run(); // seen again with capacity in place
      expect((await reconcile()).status).toBe(200);
      expect(await homeState()).toEqual({ d: "failed", e: "pending" });
      expect(await env.DB.prepare("SELECT payment_version AS v FROM cloud_homes WHERE id='home-1'").first()).toEqual({ v: 0 });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE id='payment:evt_prov_in_1'")).toBe(0);
      expect(await capacity()).toEqual(slots); // no server slot claimed
      // handled with no effect, and kept (never deleted)
      expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id='evt_prov_in_1' AND processed_at IS NOT NULL")).toBe(1);
      expect(await homeSub()).toEqual({ s: "sub_new", status: "active" });
      // only the refunded order's payment is tombstoned: the replacement's own payment provisions the home
      await provisionedEvidence("in_new");
      expect((await reconcile()).status).toBe(200);
      expect(await homeState()).toMatchObject({ e: "paid" });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE id='payment:evt_prov_in_new'")).toBe(1);
    });
    it("r6-2 a displaced order whose invoice was granted credit: refunded in full, that one grant reversed once (replays do not repeat it), the replacement's grant untouched", async () => {
      const { id } = await parkedOrder();
      await provisionedEvidence("in_1");
      await replacementOwnsHome();
      await grant("in_1"); await grant("in_new");
      at(NOW + 24 * HOUR); await sweep();
      at(NOW + 25 * HOUR); await sweep();
      at(NOW + 26 * HOUR); await sweep();
      await expectDisplacedRefund(id, "sub_test1", "in_1");
      expect(refundPosts()).toHaveLength(1);
      // Astra JOURNEY-A-8 #3: refund-backed, so a FINAL versioned target following the money returned (never the one-shot /reverse).
      expect((await env.DB.prepare("SELECT invoice_id AS i,kind AS k,reason AS r,op_id AS op,scope,final,reversed_at IS NOT NULL AS done FROM credit_reversals").all()).results)
        .toEqual([{ i: "in_1", k: "period", r: "rejected_consent", op: "rejected_consent:in_1", scope: "target", final: 1, done: 1 }]);
      expect(revokes()).toEqual([]);
      expect(targets()).toEqual([{ hook: "target", args: expect.objectContaining({ homeId: "home-1", invoiceId: "in_1", kind: "period", grantId: "in_1:period",
        reason: "rejected_consent", targetRemovedMicrocents: 5_000_000 }) }]);
      expect(fluxLog.filter((f) => f.hook === "stop")).toHaveLength(0); // the home's service and plan are not touched
      expect(await count("SELECT COUNT(*) AS n FROM credit_grants WHERE invoice_id='in_new'")).toBe(1);
    });
    it("r6-2 a reversal B4 cannot apply yet: the refund completes anyway, the reversal stays pending, and the sweep applies it exactly once", async () => {
      const { id } = await parkedOrder();
      await provisionedEvidence("in_1");
      await replacementOwnsHome();
      await grant("in_1");
      revokeFails = 1_000; // B4 refuses for as long as it is down
      at(NOW + 24 * HOUR); await sweep();
      at(NOW + 25 * HOUR); await sweep();
      // the refund is complete while the reversal is still pending, and ops has been told
      await expectDisplacedRefund(id, "sub_test1", "in_1");
      expect(await env.DB.prepare("SELECT reversed_at AS r,last_error AS e FROM credit_reversals WHERE invoice_id='in_1'").first()).toEqual({ r: null, e: "b4_down" });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.reversal_pending' AND resolved_at IS NULL")).toBe(1);
      expect(targets()).toHaveLength(0);
      revokeFails = 0; // B4 is back
      for (let h = 26; h <= 30 && targets().length === 0; h++) { at(NOW + h * HOUR); await sweep(); }
      expect(revokes()).toHaveLength(0);
      expect(targets()).toHaveLength(1);
      expect(await env.DB.prepare("SELECT reversed_at IS NOT NULL AS r,last_error AS e,removed_microcents AS m FROM credit_reversals WHERE invoice_id='in_1'").first())
        .toEqual({ r: 1, e: null, m: 5_000_000 });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.reversal_pending' AND resolved_at IS NULL")).toBe(0);
      expect(refundPosts()).toHaveLength(1);
    });
    it("r6-2 a displaced order whose invoice was never granted: refunded in full, no reversal journaled, B4 not asked", async () => {
      await parkedOrder();
      await provisionedEvidence("in_1");
      await replacementOwnsHome();
      await grant("in_new");
      at(NOW + 24 * HOUR); await sweep();
      at(NOW + 25 * HOUR); await sweep();
      expect(refundPosts()).toHaveLength(1);
      expect(await count("SELECT COUNT(*) AS n FROM credit_reversals")).toBe(0);
      expect(revokes()).toHaveLength(0);
    });
    it("r6-3 an order is added to the alert while the previous list is being sent: the alert stays due, and the next send carries both", async () => {
      const { id } = await parkedOrder();
      await addSecondParkedOrder(id);
      await provisionedEvidence("in_1");
      await provisionedEvidence("in_two");
      await replacementOwnsHome();
      at(NOW + 24 * HOUR); await sweep(); // the first order only
      const sent: string[] = [];
      let appended = false;
      const fetcher = (async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { kind: string; text: string };
        sent.push(body.text);
        // while this send of the one-order list is outstanding, the second order is refunded and added to the alert
        if (body.kind === "checkout.parked_order_released" && !appended) { appended = true; at(NOW + 25 * HOUR); await sweep(); }
        return new Response("ok");
      }) as unknown as typeof fetch;
      await sweepMonitoring(opsEnv(), NOW + 25 * HOUR, fetcher);
      expect(appended).toBe(true);
      const row = (await env.DB.prepare("SELECT detail,delivered_at AS dl FROM cloud_alerts WHERE kind='checkout.parked_order_released'").first<{ detail: string; dl: number | null }>())!;
      expect([...(JSON.parse(row.detail) as { consentIds: string[] }).consentIds].sort()).toEqual(["consent_two", id].sort());
      expect(row.dl).toBeNull(); // still due: the send that finished carried the old list
      // the old send does not use up the new list's retry budget (Astra WP5-7 P3)
      expect((await env.DB.prepare("SELECT delivery_attempts AS n FROM cloud_alerts WHERE kind='checkout.parked_order_released'").first<{ n: number }>())!.n).toBe(0);
      await sweepMonitoring(opsEnv(), NOW + 26 * HOUR, fetcher);
      expect(sent.filter((t) => t.includes("checkout.parked_order_released")).at(-1)).toContain("consent_two");
      expect(await env.DB.prepare("SELECT delivered_at AS dl FROM cloud_alerts WHERE kind='checkout.parked_order_released'").first()).toEqual({ dl: NOW + 26 * HOUR });
    });
    it("r6-4 Stripe cannot take the refund after the alert was written: the alert says the refund was requested, never that it was made", async () => {
      const { id } = await parkedOrder();
      await provisionedEvidence("in_1");
      await replacementOwnsHome();
      refundFails = 1_000;
      at(NOW + 24 * HOUR); await sweep();
      const d = JSON.parse((await released())!.d!) as Record<string, unknown> & { items: Record<string, unknown>[] };
      expect(d).toMatchObject({ consentId: id, opId: "rejected_consent:in_1", refundRequested: true });
      expect(d).not.toHaveProperty("refunded");
      expect(d.items[0]).not.toHaveProperty("refunded");
      expect(await env.DB.prepare("SELECT refunded_at AS r FROM refund_ops WHERE id='rejected_consent:in_1'").first()).toEqual({ r: null });
      const sent: string[] = [];
      const fetcher = (async (_u: string, init: RequestInit) => { sent.push((JSON.parse(init.body as string) as { text: string }).text); return new Response("ok"); }) as unknown as typeof fetch;
      await sweepMonitoring(opsEnv(), NOW + 24 * HOUR, fetcher);
      const text = sent.find((t) => t.includes("checkout.parked_order_released"))!;
      expect(text).toContain("rejected_consent:in_1=requested");
      expect(text).not.toContain("=refunded");
    });
    it("r4-2 populated upgrade: a rejection written before 0073 whose cancellation failed is queued by the migration, and the sweep cancels it once", async () => {
      await order("DE");
      cancelStuck = true;
      expect((await hook(stripeEvent("checkout.session.completed", await sessionObj({ customer_details: { address: { country: "AT" } } }, "unpaid")))).status).toBe(200);
      expect(subDeletes()).toHaveLength(1); // tried once, refused
      // the rows as an older build left them: no home, nothing queued; plus a failed asynchronous payment (its cancellation was confirmed)
      await env.DB.prepare("UPDATE rejected_subscriptions SET home_id=NULL, cancel_pending=0 WHERE subscription_id='sub_test1'").run();
      await env.DB.prepare("INSERT INTO rejected_subscriptions (subscription_id,at,reason) VALUES ('sub_af',?,'async_payment_failed')").bind(NOW).run();
      cancelStuck = false;
      at(NOW + HOUR); await sweep();
      expect(subDeletes()).toHaveLength(1); // the gap: without the reconciliation nothing retries it
      // 0073 run on the old table shape, with these rows in it
      await env.DB.prepare("CREATE TABLE mig_rs (subscription_id TEXT PRIMARY KEY, at INTEGER NOT NULL, reason TEXT)").run();
      await env.DB.prepare("INSERT INTO mig_rs SELECT subscription_id,at,reason FROM rejected_subscriptions").run();
      const stmts = m0073.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean)
        .map((x) => x.replaceAll("rejected_subscriptions", "mig_rs"));
      for (const x of stmts) await env.DB.prepare(x).run();
      expect((await env.DB.prepare("SELECT subscription_id AS s,home_id AS h,cancel_pending AS p,cancel_confirmed_at AS c FROM mig_rs ORDER BY subscription_id").all()).results)
        .toEqual([{ s: "sub_af", h: null, p: 0, c: null }, { s: "sub_test1", h: "home-1", p: 1, c: null }]);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.rejected_cancel_no_home'")).toBe(0);
      // the migrated values are what the sweep reads
      await env.DB.prepare(`UPDATE rejected_subscriptions SET home_id=(SELECT m.home_id FROM mig_rs m WHERE m.subscription_id=rejected_subscriptions.subscription_id),
        cancel_pending=(SELECT m.cancel_pending FROM mig_rs m WHERE m.subscription_id=rejected_subscriptions.subscription_id)`).run();
      await env.DB.prepare("DROP TABLE mig_rs").run();
      at(NOW + 2 * HOUR); await sweep();
      expect(subDeletes()).toHaveLength(2);
      expect(subDeletes()[1].form.get("prorate")).toBe("false");
      expect(await env.DB.prepare("SELECT cancel_pending AS p,cancel_confirmed_at AS c FROM rejected_subscriptions WHERE subscription_id='sub_test1'").first())
        .toEqual({ p: 0, c: NOW + 2 * HOUR });
      at(NOW + 3 * HOUR); await sweep();
      expect(subDeletes()).toHaveLength(2); // confirmed: never asked again
      expect(stripeCalls.filter((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_af")).toHaveLength(0);
    });
    it("r5-2 0073 with several rejections whose home cannot be found: ONE billing alert naming every subscription", async () => {
      await env.DB.prepare("CREATE TABLE mig_rs (subscription_id TEXT PRIMARY KEY, at INTEGER NOT NULL, reason TEXT)").run();
      await env.DB.prepare("INSERT INTO mig_rs VALUES ('sub_orphan_b',?,'mismatch'),('sub_orphan_a',?,'country_paused'),('sub_af2',?,'async_payment_failed')")
        .bind(NOW, NOW, NOW).run();
      const stmts = m0073.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean)
        .map((x) => x.replaceAll("rejected_subscriptions", "mig_rs"));
      for (const x of stmts) await env.DB.prepare(x).run();
      const rows = (await env.DB.prepare("SELECT home_id AS h,detail FROM cloud_alerts WHERE kind='checkout.rejected_cancel_no_home'").all<{ h: string; detail: string }>()).results;
      expect(rows).toHaveLength(1);
      expect(rows[0].h).toBe("billing");
      expect(JSON.parse(rows[0].detail)).toEqual({ subscriptionId: "sub_orphan_a", subscriptionIds: ["sub_orphan_a", "sub_orphan_b"] });
      await env.DB.prepare("DROP TABLE mig_rs").run();
    });
  });
});

describe("Cloud checkout WP6: address change and replacement checkout (plan r13d §1.3, §3.3, §4.1; Test 3 replacement rows, Test 4 address rows)", () => {
  const at = (ms: number) => { vi.mocked(Date.now).mockReturnValue(ms); };
  // Managed Payments for new non-US signups, Ferrox registered only in the US: a direct plan abroad is then not covered by its own path (r1-3:
  // coverage is the retained seller's, so a Ferrox registration in FR would keep a direct FR plan covered).
  const managed = () => { envOver = { CLOUD_NONUS_SELLER: "managed_payments", FERROX_TAX_COUNTRIES: "US" } as Partial<Env>; };
  const sweepNow = () => sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const subDeletes = (id: string) => stripeCalls.filter((c) => c.method === "DELETE" && c.path === `/v1/subscriptions/${id}`);
  const cancelSets = (value: string) => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_test1" && c.form.get("cancel_at_period_end") === value);
  const custEvent = (country: string | null) => stripeEvent("customer.updated", { object: "customer", id: "cus_test1", address: country ? { country } : null });
  /** Stripe's live customer (the handler reads it, so an older event cannot undo a newer address). */
  const liveAddress = (country: string) => { customerIdentity = { address: { country } }; };
  const route = () => env.DB.prepare("SELECT account_id,seller,collected_country,reason,replaces_subscription_id,expires_at FROM checkout_retry_routes").first<Record<string, unknown>>();
  const consentOf = (id: string) => env.DB.prepare("SELECT * FROM checkout_consents WHERE id=?").bind(id).first<Record<string, unknown>>();
  const billing = () => env.DB.prepare("SELECT subscription_id,consent_id,plan,status,cancel_at_period_end,service_start_at,first_invoice_id FROM billing_subscriptions WHERE home_id='home-1'")
    .first<{ subscription_id: string; consent_id: string; plan: string; status: string; cancel_at_period_end: number; service_start_at: number | null; first_invoice_id: string | null }>();
  const oldSession = async (over: Record<string, unknown> = {}) => boundSession({ object: "checkout.session", id: "cs_test_1", mode: "subscription", payment_status: "paid", customer: "cus_test1",
    subscription: "sub_test1", invoice: "in_1", client_reference_id: "home-1", amount_total: 4900, total_details: { amount_tax: 0 }, customer_details: { address: { country: "FR" } },
    metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1") } }, over, retrievable);
  const newSession = async (status = "paid", over: Record<string, unknown> = {}) => boundSession({ object: "checkout.session", id: "cs_test_2", mode: "subscription", payment_status: status,
    customer: "cus_test1", subscription: "sub_test2", invoice: "in_2", client_reference_id: "home-1", amount_total: 4900, total_details: { amount_tax: 0 },
    customer_details: { address: { country: "US" } },
    metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1"), replaces: "sub_test1" } }, over, retrievable);
  const newInvoice = (over: Record<string, unknown> = {}) => invoice({ id: "in_2", subscription: "sub_test2", billing_reason: "subscription_create", ...over });
  /** A running Managed Payments (Link) plan sold in France: period NOW..NOW+30d, 4900 paid on in_1. */
  async function runningMpFr() {
    managed(); await reserve();
    expect((await checkout("starter", { billingCountry: "FR", earlyStart: true })).status).toBe(200);
    expect((await hook(stripeEvent("checkout.session.completed", await oldSession()))).status).toBe(200);
    expect((await hook(stripeEvent("invoice.paid", invoice()))).status).toBe(200);
    paidInvoices = [{ ...invoice(), id: "in_1", amount_paid: 4900, tax: 0, payment_intent: "pi_1", created: NOW / 1000 } as never];
    return (await billing())!;
  }
  /** The customer moves to the US: Stripe says so, the route to the direct page is written, the old plan is set to end. */
  async function moveToUs() {
    liveAddress("US");
    expect((await hook(custEvent("US"))).status).toBe(200);
    expect(await route()).toMatchObject({ seller: "ferrox", reason: "address_change", replaces_subscription_id: "sub_test1" });
  }
  const checkoutUs = () => checkout("starter", { billingCountry: "US", earlyStart: true });
  /** A route to the managed page for an EU resident (DE): the statutory and guarantee clocks exist only for residents. */
  // An address_change route exists because Stripe's live customer is already in the new country (customer.updated): so is the fake's.
  const routeToMp = () => { liveAddress("DE"); return env.DB.prepare("INSERT INTO checkout_retry_routes (account_id,seller,collected_country,reason,replaces_subscription_id,expires_at) VALUES (?,?,?,?,?,?)")
    .bind(OWNER, "link", "DE", "address_change", "sub_test1", NOW + 60 * DAY).run(); };
  const checkoutDe = () => checkout("starter", { billingCountry: "DE", earlyStart: true });
  const DE = { customer_details: { address: { country: "DE" } } };

  describe("Test 4 address rows: the check is path coverage only", () => {
    it("direct plan, new address needs Link: cancel at period end, an address_change route to the managed page, Email A; nothing refunded or voided", async () => {
      await paidUs(); managed(); liveAddress("FR");
      expect((await hook(custEvent("FR"))).status).toBe(200);
      expect(await route()).toMatchObject({ seller: "link", collected_country: "FR", reason: "address_change", replaces_subscription_id: "sub_test1", account_id: OWNER });
      expect(cancelSets("true")).toHaveLength(1);
      expect((await billing())!.cancel_at_period_end).toBe(1);
      const mail = notices.find((n) => n.kind === "address_change")!.data as { emailText: string };
      expect(mail.emailText).toContain("Your billing address is now in FR, so a different company has to take your payments: Link (by Stripe). Press Continue to payment on your account page before");
      expect(mail.emailText).toContain("You won't pay twice: we refund the unused days of your current plan.");
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(subDeletes("sub_test1")).toHaveLength(0);
      // The account page shows the next step.
      signedIn = OWNER;
      expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ nextStep: { kind: "continue_to_payment", reason: "address_change", country: "FR", path: "managed" } });
    });
    it("the reverse: a Link plan whose customer moves to the US is sent to the direct page", async () => {
      await runningMpFr(); await moveToUs();
      expect(cancelSets("true")).toHaveLength(1);
      expect((notices.find((n) => n.kind === "address_change")!.data as { emailText: string }).emailText).toContain("Ferrox Labs directly");
      signedIn = OWNER;
      expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ nextStep: { kind: "continue_to_payment", path: "direct", country: "US" } });
    });
    it("a same-path change changes nothing but the declared country; no route, no cancellation, no email", async () => {
      await paidUs(); liveAddress("US");
      expect((await hook(custEvent("US"))).status).toBe(200);
      expect(await route()).toBeNull();
      expect(cancelSets("true")).toHaveLength(0);
      expect(notices.filter((n) => n.kind === "address_change")).toHaveLength(0);
      expect((await billing())!.cancel_at_period_end).toBe(0);
      // direct covers France too when Ferrox is registered there (default test env): still the same path.
      liveAddress("FR");
      await hook(custEvent("FR"));
      expect(await route()).toBeNull();
      expect(await env.DB.prepare("SELECT declared_country AS c FROM checkout_consents WHERE home_id='home-1'").first()).toEqual({ c: "FR" });
    });
    it("no path covers the new country: the plan ends at its period end, no route to a page, Email B", async () => {
      await paidUs(); managed(); liveAddress("ZZ");
      expect((await hook(custEvent("ZZ"))).status).toBe(200);
      expect(await route()).toMatchObject({ seller: "none", reason: "address_change", collected_country: "ZZ" });
      expect(cancelSets("true")).toHaveLength(1);
      expect((notices.find((n) => n.kind === "address_change")!.data as { emailText: string }).emailText).toContain("We can't take payments there yet, so your plan ends on");
      signedIn = OWNER;
      expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ nextStep: { kind: "payment_not_available" } });
      expect((await checkoutUs()).status).toBe(409); // no valid route: a running home does not check out again
    });
    it("replay of the same Stripe address event, and of the same address in a new event, is idempotent: one route, one cancellation, one email", async () => {
      await paidUs(); managed(); liveAddress("FR");
      const ev = custEvent("FR");
      await hook(ev);
      expect(await (await hook(ev)).json()).toEqual({ received: true, duplicate: true });
      await hook(custEvent("FR"));
      expect(await count("SELECT COUNT(*) AS n FROM checkout_retry_routes")).toBe(1);
      expect(cancelSets("true").length).toBeLessThanOrEqual(2);
      expect(notices.filter((n) => n.kind === "address_change")).toHaveLength(1);
      expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='address_change'")).toBe(1);
    });
    it("a stale event cannot undo a newer address: the live customer decides", async () => {
      await paidUs(); managed(); liveAddress("US");
      await hook(custEvent("FR")); // an older event arriving late
      expect(await route()).toBeNull();
      expect(cancelSets("true")).toHaveLength(0);
    });
    it("moving back to a covered country takes the stopped renewal back", async () => {
      await paidUs(); managed(); liveAddress("FR");
      await hook(custEvent("FR"));
      expect((await billing())!.cancel_at_period_end).toBe(1);
      liveAddress("US");
      await hook(custEvent("US"));
      expect(await route()).toBeNull();
      expect(cancelSets("false")).toHaveLength(1);
      expect((await billing())!.cancel_at_period_end).toBe(0);
    });
    it("the kill switch is never read: a paused country still gets its address change recorded, a running plan there still renews", async () => {
      await paidUs(); managed(); liveAddress("FR");
      await env.DB.prepare("INSERT INTO checkout_country_switch (country,state,updated_at) VALUES ('FR','paused',?)").bind(NOW).run();
      expect((await hook(custEvent("FR"))).status).toBe(200);
      expect(await route()).toMatchObject({ reason: "address_change", seller: "link" });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions")).toBe(0);
    });
    it("a customer event for an unknown customer, and an address change with no country, touch nothing", async () => {
      await paidUs();
      expect(await (await hook(stripeEvent("customer.updated", { object: "customer", id: "cus_other", address: { country: "FR" } }))).json()).toMatchObject({ received: true });
      liveAddress("US"); customerIdentity = {};
      await hook(custEvent(null));
      expect(await route()).toBeNull();
    });
  });

  describe("Test 4: the invoice.created backstop (path coverage only)", () => {
    const renewalDraft = (country: string | null, over: Record<string, unknown> = {}) => ({ object: "invoice", id: "in_9", customer: "cus_test1", subscription: "sub_test1", status: "draft",
      billing_reason: "subscription_cycle", amount_paid: 0, customer_address: country ? { country } : null, lines: { data: [] }, ...over });
    const draftAtStripe = () => { invoiceStore["in_9"] = { id: "in_9", status: "draft", amount_due: 4900, auto_advance: true, subscription: "sub_test1", billing_reason: "subscription_cycle" }; };
    it("a renewal invoice for a country the path cannot cover: held, voided, the subscription ends now without proration, route and email", async () => {
      await paidUs(); managed(); draftAtStripe(); liveAddress("FR");
      expect((await hook(stripeEvent("invoice.created", renewalDraft("FR")))).status).toBe(200);
      expect(invoiceStore["in_9"]).toMatchObject({ status: "void", auto_advance: false });
      expect(subDeletes("sub_test1")).toHaveLength(1);
      expect(subDeletes("sub_test1")[0].form.get("prorate")).toBe("false");
      expect(subDeletes("sub_test1")[0].form.get("invoice_now")).toBe("false");
      expect(await route()).toMatchObject({ seller: "link", reason: "address_change" });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.renewal_uncovered'")).toBe(1);
    });
    it("covered, not a renewal, or no address: nothing is voided, cancelled or refunded", async () => {
      await paidUs(); managed(); draftAtStripe(); liveAddress("US");
      for (const ev of [renewalDraft("US"), renewalDraft(null), renewalDraft("FR", { billing_reason: "manual" })]) {
        expect((await hook(stripeEvent("invoice.created", ev))).status).toBe(200);
      }
      expect(invoiceStore["in_9"]).toMatchObject({ status: "draft", auto_advance: true });
      expect(subDeletes("sub_test1")).toHaveLength(0);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(await route()).toBeNull();
    });
    it("a paused country's renewal invoice is not touched (the switch is not read)", async () => {
      await paidUs(); draftAtStripe();
      await env.DB.prepare("INSERT INTO checkout_country_switch (country,state,updated_at) VALUES ('US','paused',?)").bind(NOW).run();
      await hook(stripeEvent("invoice.created", renewalDraft("US")));
      expect(invoiceStore["in_9"]).toMatchObject({ status: "draft" });
      expect(subDeletes("sub_test1")).toHaveLength(0);
    });
  });

  describe("Test 3 replacement rows", () => {
    it("the retry route lets a running home check out again: the session carries metadata.replaces, the running plan is untouched; without a valid route it is already_subscribed", async () => {
      await runningMpFr();
      expect((await checkoutUs()).status).toBe(409);
      await moveToUs();
      const before = await billing();
      expect((await checkoutUs()).status).toBe(200);
      const created = stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions").pop()!;
      expect(created.form.get("metadata[replaces]")).toBe("sub_test1");
      expect(created.form.get("subscription_data[metadata][replaces]")).toBe("sub_test1");
      expect(created.form.get("managed_payments[enabled]")).toBe("false"); // the direct page
      expect(await billing()).toEqual(before); // plan, consent and subscription unchanged until the payment is confirmed
      // The wrong page (the path it already has) does not pass.
      expect((await checkout("starter", { billingCountry: "FR", earlyStart: true })).status).toBe(409);
    });
    it("the customer reaches the replacement from the account page: reserve returns the running home when a valid route exists", async () => {
      await runningMpFr(); await moveToUs(); signedIn = OWNER;
      const res = await send("/v1/billing/reserve", { body: {} });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ homeId: "home-1", replacement: true });
    });
    it("completed but unpaid: no ownership move, 'We'll switch your plan as soon as your payment clears', statutory clock from completed_at", async () => {
      await runningMpFr(); await routeToMp(); expect((await checkoutDe()).status).toBe(200);
      const cid = await latestConsentId("home-1");
      at(NOW + DAY);
      expect((await hook(stripeEvent("checkout.session.completed", await newSession("unpaid", DE), (NOW + DAY) / 1000))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test1", plan: "starter" });
      expect(await consentOf(cid)).toMatchObject({ completed_at: NOW + DAY, paid_at: null, statutory_withdraw_until: aoeEnd(NOW + DAY, 14), guarantee_withdraw_until: null });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(subDeletes("sub_test1")).toHaveLength(0);
      expect(await route()).toMatchObject({ reason: "address_change" });
      const conf = notices.filter((n) => n.kind === "confirmation").pop()!.data as { emailText: string };
      expect(conf.emailText).toContain("We got your order. We'll switch your plan as soon as your payment clears.");
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions")).toBe(0);
    });
    it("async_payment_succeeded moves ownership: cutover_at is that event's time, the old invoice and period are frozen, the guarantee runs from paid_at, the old plan is tombstoned and cancelled without proration, the cutover refund is the unused fraction, the route is cleared", async () => {
      await runningMpFr(); await routeToMp(); expect((await checkoutDe()).status).toBe(200);
      const cid = await latestConsentId("home-1");
      at(NOW + DAY);
      await hook(stripeEvent("checkout.session.completed", await newSession("unpaid", DE), (NOW + DAY) / 1000));
      const paidAt = NOW + 2 * DAY; at(paidAt);
      expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", await newSession("paid", DE), paidAt / 1000))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test2", consent_id: cid, cancel_at_period_end: 0, service_start_at: NOW });
      expect(await consentOf(cid)).toMatchObject({ paid_at: paidAt, guarantee_withdraw_until: aoeEnd(paidAt, 14), statutory_withdraw_until: aoeEnd(NOW + DAY, 14) });
      const op = await env.DB.prepare("SELECT id,kind,cutover_at,old_invoice_id,old_period_start,old_period_end,subscription_id,amount_cents FROM refund_ops").first();
      expect(op).toMatchObject({ id: "cutover:sub_test1", kind: "cutover", cutover_at: paidAt, old_invoice_id: "in_1", old_period_start: NOW, old_period_end: NOW + 30 * DAY,
        subscription_id: "sub_test1", amount_cents: Math.round(4900 * 28 / 30) });
      expect(refundPosts().map((c) => c.form.get("amount"))).toEqual([String(Math.round(4900 * 28 / 30))]);
      // Cancelled by the cutover and again (idempotently) by the ledger step: every request is without proration.
      expect(subDeletes("sub_test1").length).toBeGreaterThanOrEqual(1);
      expect(subDeletes("sub_test1").every((c) => c.form.get("prorate") === "false" && c.form.get("invoice_now") === "false")).toBe(true);
      expect(await env.DB.prepare("SELECT reason FROM rejected_subscriptions WHERE subscription_id='sub_test1'").first()).toEqual({ reason: "replaced" });
      expect(await route()).toBeNull();
      expect(notices.some((n) => n.kind === "replacement_done")).toBe(true);
      expect(notices.some((n) => n.kind === "payment_received")).toBe(false);
      // The first invoice of the replacement is recorded against it, and the old subscription's events are ignored.
      expect((await hook(stripeEvent("invoice.paid", newInvoice(), paidAt / 1000))).status).toBe(200);
      expect((await billing())!.first_invoice_id).toBe("in_2");
      expect(await (await hook(stripeEvent("customer.subscription.deleted", { object: "subscription", id: "sub_test1", customer: "cus_test1", status: "canceled" }))).json()).toMatchObject({ received: true });
      expect((await billing())!.status).toBe("active");
    });
    it("a session already paid at completion moves ownership at once (both moments), once, with one cutover refund even if the event is replayed", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      const paidAt = NOW + 3 * DAY; at(paidAt);
      const ev = stripeEvent("checkout.session.completed", await newSession("paid"), paidAt / 1000);
      expect((await hook(ev)).status).toBe(200);
      expect(await (await hook(ev)).json()).toEqual({ received: true, duplicate: true });
      // A second delivery with a new event id (Stripe retry after a lost answer) lands on the committed state and changes nothing.
      expect((await hook(stripeEvent("checkout.session.completed", await newSession("paid"), paidAt / 1000))).status).toBe(200);
      expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", await newSession("paid"), paidAt / 1000))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test2" });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='cutover'")).toBe(1);
      expect(refundPosts()).toHaveLength(1);
      expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='replacement_done'")).toBe(1);
    });
    it("async_payment_failed: the old server and plan are untouched (still ending at its period end), the route stays, the new subscription is cancelled and tombstoned", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      await hook(stripeEvent("checkout.session.completed", await newSession("unpaid")));
      expect((await hook(stripeEvent("checkout.session.async_payment_failed", await newSession("unpaid")))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test1", status: "active", cancel_at_period_end: 1 });
      expect(subDeletes("sub_test1")).toHaveLength(0);
      expect(subDeletes("sub_test2")).toHaveLength(1);
      expect(subDeletes("sub_test2")[0].form.get("prorate")).toBe("false");
      expect(await route()).toMatchObject({ reason: "address_change", replaces_subscription_id: "sub_test1" });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect((notices.find((n) => n.kind === "replacement_failed")!.data as { emailText: string }).emailText)
        .toContain("Your payment didn't go through, so your plan is unchanged and still ends on");
      expect((await checkoutUs()).status).toBe(200); // try again from the account page
    });
    it("expiry without payment: nothing moves, the route stays, the customer is told the plan is unchanged", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      expect((await hook(stripeEvent("checkout.session.expired", await newSession("unpaid")))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test1", cancel_at_period_end: 1 });
      expect(await route()).toMatchObject({ reason: "address_change" });
      expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='replacement_failed'")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
    });
    it("the first invoice of the replacement arriving before the event that moves ownership waits (retried), it is not dropped", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      const early = stripeEvent("invoice.paid", newInvoice({ subscription_details: { metadata: { replaces: "sub_test1" } },
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_test2", metadata: { replaces: "sub_test1" } } } }));
      expect((await hook(early)).status).toBe(500);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(early.id).first()).toEqual({ p: null });
      await hook(stripeEvent("checkout.session.completed", await newSession("paid")));
      await env.DB.prepare("UPDATE stripe_events SET next_attempt_at=0 WHERE id=?").bind(early.id).run();
      await sweepNow();
      expect((await billing())!.first_invoice_id).toBe("in_2");
    });
    it("a renewal of the old plan that settles after the cutover is refunded in full once (invoice-keyed), not swallowed by the tombstone", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      await hook(stripeEvent("checkout.session.completed", await newSession("paid")));
      refundsMade = []; stripeCalls = [];
      // The next period's renewal (never served by the old plan, judged against the frozen boundary; r1-5).
      const late = invoice({ id: "in_3", billing_reason: "subscription_cycle", lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 } }] } });
      expect((await hook(stripeEvent("invoice.paid", late))).status).toBe(200);
      expect(await env.DB.prepare("SELECT id,kind,invoice_id FROM refund_ops WHERE kind='late_payment'").first()).toEqual({ id: "late_payment:in_3", kind: "late_payment", invoice_id: "in_3" });
      expect(refundPosts().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      await hook(stripeEvent("invoice.paid", late));
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='late_payment'")).toBe(1);
      // The invoice the cutover refund was computed on is not refunded a second time.
      await hook(stripeEvent("invoice.paid", invoice()));
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='late_payment'")).toBe(1);
    });
    it("a paused country refuses the replacement checkout (new and replacement purchases), and the running plan keeps its end date", async () => {
      await runningMpFr(); await moveToUs();
      await env.DB.prepare("INSERT INTO checkout_country_switch (country,state,updated_at) VALUES ('US','paused',?)").bind(NOW).run();
      expect((await checkoutUs()).status).toBe(409);
      expect(await route()).toMatchObject({ reason: "address_change" });
      expect((await billing())!.cancel_at_period_end).toBe(1);
    });
    it("a replacement whose billing country does not match what was declared is a mismatch: the new subscription is refunded and cancelled, the old plan and the address_change route survive", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      expect((await hook(stripeEvent("checkout.session.completed", await newSession("paid", { customer_details: { address: { country: "DE" } } })))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test1" });
      expect(await env.DB.prepare("SELECT kind FROM refund_ops").first()).toEqual({ kind: "mismatch" });
      expect(await route()).toMatchObject({ reason: "address_change", replaces_subscription_id: "sub_test1" });
      expect(subDeletes("sub_test1")).toHaveLength(0);
    });
  });

  describe("WP6 r1: replacements, the backstop and the frozen boundary (Astra WP6-1)", () => {
    const period = (startDays: number, endDays: number) => ({ data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: NOW / 1000 + startDays * 86400, end: NOW / 1000 + endDays * 86400 } }] });
    const renewalEvent = (country: string | null) => ({ object: "invoice", id: "in_9", customer: "cus_test1", subscription: "sub_test1", status: "draft",
      billing_reason: "subscription_cycle", amount_paid: 0, customer_address: country ? { country } : null, lines: { data: [] } });
    const retry = async (eventId: string) => { await env.DB.prepare("UPDATE stripe_events SET next_attempt_at=0 WHERE id=?").bind(eventId).run(); await sweepNow(); };
    const opAmounts = async () => (await env.DB.prepare("SELECT id,kind,amount_cents,invoice_id,old_invoice_id,cutover_at FROM refund_ops ORDER BY id").all()).results;

    it("r1-1: an unpaid completion during the grace never claims the ended plan; the payment clearing later adopts the replacement and restores service", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      // The old plan reached its period end and Stripe ended it (the seven-day grace of the route).
      await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled' WHERE home_id='home-1'").run();
      const t1 = NOW + 31 * DAY; at(t1);
      expect((await hook(stripeEvent("checkout.session.completed", await newSession("unpaid"), t1 / 1000))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test1", status: "canceled" });
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions")).toBe(0);
      expect((notices.filter((n) => n.kind === "confirmation").pop()!.data as { emailText: string }).emailText).toContain("We'll switch your plan as soon as your payment clears.");
      const inbox = await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE home_id='home-1'");
      const t2 = NOW + 32 * DAY; at(t2);
      expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", await newSession("paid"), t2 / 1000))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test2", status: "active" });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE home_id='home-1'")).toBe(inbox + 1); // service restored
      expect(await env.DB.prepare("SELECT reason FROM rejected_subscriptions WHERE subscription_id='sub_test1'").first()).toEqual({ reason: "replaced" });
      // Nothing of the old period was left: no cutover refund, but the boundary is on record; no false alarm.
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(await env.DB.prepare("SELECT cutover_at,old_invoice_id FROM replacement_cutovers WHERE old_subscription_id='sub_test1'").first()).toEqual({ cutover_at: t2, old_invoice_id: null });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.cutover_no_paid_invoice'")).toBe(0);
    });
    it("r1-1: a payment that clears when the replacement can no longer be adopted is refunded in full through the ledger (never foreign_subscription)", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      piInvoices.pi_2 = "in_2";
      creditNotesOn = true; // the replacement is a direct (US) order: its duplicate refund is a credit note (Astra DROPDOWN-DIRECT-2 (2))
      await hook(stripeEvent("checkout.session.completed", await newSession("unpaid")));
      await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='sub_other',status='active' WHERE home_id='home-1'").run();
      const ev = stripeEvent("checkout.session.async_payment_succeeded", await newSession("paid"));
      expect((await hook(ev)).status).toBe(200);
      expect(await env.DB.prepare("SELECT error FROM stripe_events WHERE id=?").bind(ev.id).first()).toEqual({ error: "replacement_refunded" });
      expect(await env.DB.prepare("SELECT id,kind,invoice_id FROM refund_ops").first()).toEqual({ id: "duplicate:in_2", kind: "duplicate", invoice_id: "in_2" });
      expect(refundPosts()).toHaveLength(0);
      expect(stripeCalls.filter((x) => x.method === "POST" && x.path === "/v1/credit_notes").map((x) => Number(x.form.get("refund_amount")))).toEqual([4900]);
      expect(subDeletes("sub_test2").length).toBeGreaterThanOrEqual(1);
      expect(await billing()).toMatchObject({ subscription_id: "sub_other" });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.replacement_unrecoverable'")).toBe(1);
    });
    it("Astra TAXCOUNTRY-7 P1-a: reordered refund/activation: Link refunds A (its webhook first, dated T2) after B was paid at T1: A's line ends alone, B serves", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      expect((await reconcile()).status).toBe(200);
      expect(await getHome()).toMatchObject({ entitlement: "paid", payment_line: "sub_test1" });
      const t1 = NOW + 3 * DAY, t2 = NOW + 4 * DAY;
      // Link refunds A's charge in full at T2; that webhook is delivered before any of B's (B was paid at T1, its webhooks delayed).
      refundsMade.push({ id: "re_link_a", amount: 4900, status: "succeeded", payment_intent: "pi_1", metadata: {} });
      at(t2);
      expect((await hook(stripeEvent("charge.refunded", { object: "charge", id: "ch_a", customer: "cus_test1", payment_intent: "pi_1", invoice: "in_1", amount: 4900,
        refunded: true, amount_refunded: 4900, refunds: { data: [] } }, t2 / 1000))).status).toBe(200);
      const ended = JSON.parse((await env.DB.prepare("SELECT payload FROM cloud_payment_inbox WHERE id='refund_coverage-pi_1'").first<{ payload: string }>())!.payload);
      expect(ended).toMatchObject({ status: "canceled", subscriptionId: "sub_test1", paymentId: "pi_1" });
      expect((await reconcile()).status).toBe(200);
      expect(await getHome()).toMatchObject({ entitlement: "canceled", payment_line: "sub_test1" });
      // B's paid completion (dated T1, before the refund) arrives now: the replacement is adopted and its activation is applied.
      expect((await hook(stripeEvent("checkout.session.completed", await newSession("paid"), t1 / 1000))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test2" });
      expect((await reconcile()).status).toBe(200);
      const h = await getHome();
      expect(h).toMatchObject({ entitlement: "paid", payment_line: "sub_test2" });
      expect(h.desired_state).not.toBe("failed");
      expect(await env.DB.prepare("SELECT subscription_id AS s,closed FROM cloud_subscription_lines WHERE home_id='home-1' ORDER BY subscription_id").all().then((r) => r.results))
        .toEqual([{ s: "sub_test1", closed: 1 }, { s: "sub_test2", closed: 0 }]);
      // A late event of A's closed line (its subscription's deletion) never touches the home again.
      await env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)").bind("late-a", "home-1", t2 * 1000 + 999,
        JSON.stringify({ eventId: "late-a", homeId: "home-1", version: t2 * 1000 + 999, status: "canceled", paymentId: "sub_test1", subscriptionId: "sub_test1" }), t2).run();
      expect((await reconcile()).status).toBe(200);
      expect(await getHome()).toMatchObject({ entitlement: "paid", payment_line: "sub_test2" });
    });
    it("r1-2: a renewal already collected when invoice.created is handled is refunded in full (invoice-keyed) before the cancellation, and the event is not acknowledged until both are done", async () => {
      await paidUs(); managed(); liveAddress("FR");
      invoiceStore["in_9"] = { id: "in_9", status: "paid", amount_due: 4900, auto_advance: false, subscription: "sub_test1", billing_reason: "subscription_cycle", payment_intent: "pi_9" };
      piInvoices.pi_9 = "in_9";
      cancelStuck = true; // the cancellation is not confirmed on the first attempt
      const ev = stripeEvent("invoice.created", renewalEvent("FR"));
      expect((await hook(ev)).status).toBe(500);
      expect(await env.DB.prepare("SELECT id,kind,invoice_id,target_cents FROM refund_ops").first()).toEqual({ id: "late_payment:in_9", kind: "late_payment", invoice_id: "in_9", target_cents: 4900 });
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).toEqual({ p: null });
      cancelStuck = false;
      await retry(ev.id);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).not.toEqual({ p: null });
      expect(invoiceStore["in_9"].status).toBe("paid"); // a paid invoice is never voided
      expect(subDeletes("sub_test1").every((c) => c.form.get("prorate") === "false")).toBe(true);
      expect(refundPosts().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      // Its invoice.paid arriving afterwards grants nothing and refunds nothing again.
      await hook(stripeEvent("invoice.paid", invoice({ id: "in_9", billing_reason: "subscription_cycle", payment_intent: "pi_9" })));
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(1);
      expect(refundPosts()).toHaveLength(1);
    });
    it("r1-2: a payment racing the void leaves the event retryable; the retry finds the invoice paid and refunds it", async () => {
      await paidUs(); managed(); liveAddress("FR");
      invoiceStore["in_9"] = { id: "in_9", status: "open", amount_due: 4900, auto_advance: true, subscription: "sub_test1", billing_reason: "subscription_cycle", payment_intent: "pi_9" };
      piInvoices.pi_9 = "in_9";
      invoiceHoldFails = true; // the hold fails while the payment is going through
      const ev = stripeEvent("invoice.created", renewalEvent("FR"));
      expect((await hook(ev)).status).toBe(500);
      expect(subDeletes("sub_test1")).toHaveLength(0);
      invoiceHoldFails = false; invoiceStore["in_9"].status = "paid";
      await retry(ev.id);
      expect(await env.DB.prepare("SELECT id FROM refund_ops").first()).toEqual({ id: "late_payment:in_9" });
      expect(refundPosts().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(subDeletes("sub_test1").length).toBeGreaterThanOrEqual(1);
    });
    it("r1-3: switching NEW signups to direct does not make a running Link plan in a country Link still covers need a replacement", async () => {
      await runningMpFr();
      envOver = { CLOUD_NONUS_SELLER: "direct", FERROX_TAX_COUNTRIES: "US" } as Partial<Env>;
      liveAddress("FR");
      expect((await hook(custEvent("FR"))).status).toBe(200);
      expect(await route()).toBeNull();
      expect(cancelSets("true")).toHaveLength(0);
      invoiceStore["in_9"] = { id: "in_9", status: "draft", amount_due: 4900, auto_advance: true, subscription: "sub_test1", billing_reason: "subscription_cycle" };
      expect((await hook(stripeEvent("invoice.created", renewalEvent("FR")))).status).toBe(200);
      expect(invoiceStore["in_9"]).toMatchObject({ status: "draft", auto_advance: true });
      expect(subDeletes("sub_test1")).toHaveLength(0);
    });
    it("r1-4: the live address decides before anything is voided: a corrected address, or a cleared one, never voids a renewal on the event's stale copy", async () => {
      await paidUs(); managed();
      invoiceStore["in_9"] = { id: "in_9", status: "draft", amount_due: 4900, auto_advance: true, subscription: "sub_test1", billing_reason: "subscription_cycle" };
      liveAddress("US"); stripeCalls = []; // the customer already corrected it
      expect((await hook(stripeEvent("invoice.created", renewalEvent("FR")))).status).toBe(200);
      customerIdentity = { address: null }; // cleared at Stripe
      expect((await hook(stripeEvent("invoice.created", renewalEvent("FR")))).status).toBe(200);
      expect((await hook(custEvent("FR"))).status).toBe(200);
      expect(invoiceStore["in_9"]).toMatchObject({ status: "draft", auto_advance: true });
      expect(subDeletes("sub_test1")).toHaveLength(0);
      expect(await route()).toBeNull();
      expect(cancelSets("true")).toHaveLength(0);
      // The live invoice and customer were read before any write.
      const firstWrite = stripeCalls.findIndex((c) => c.method !== "GET");
      expect(firstWrite).toBe(-1);
    });
    it("r1-5: a zero-value cutover is persisted; a delayed frozen or served old invoice is never refunded", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      const paidAt = NOW + 30 * DAY - 100_000; at(paidAt); // under half a cent of the old period left
      expect((await hook(stripeEvent("checkout.session.completed", await newSession("paid"), paidAt / 1000))).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(await env.DB.prepare("SELECT cutover_at,old_invoice_id,old_period_end FROM replacement_cutovers").first()).toEqual({ cutover_at: paidAt, old_invoice_id: "in_1", old_period_end: NOW + 30 * DAY });
      refundsMade = []; stripeCalls = [];
      expect((await hook(stripeEvent("invoice.paid", invoice()))).status).toBe(200); // the frozen invoice, delivered again
      expect((await hook(stripeEvent("invoice.paid", invoice({ id: "in_0", billing_reason: "subscription_cycle", lines: period(-30, 0) })))).status).toBe(200); // a served period
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(refundPosts()).toHaveLength(0);
    });
    it("r1-6: a delayed cutover freezes the invoice covering paidAt; an old renewal charged meanwhile (its webhook already applied) is refunded on its own", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      at(NOW + DAY);
      await hook(stripeEvent("checkout.session.completed", await newSession("unpaid"), (NOW + DAY) / 1000));
      const in3 = invoice({ id: "in_3", billing_reason: "subscription_cycle", payment_intent: "pi_3", lines: period(30, 60) });
      piInvoices.pi_3 = "in_3";
      at(NOW + 30 * DAY + 3_600_000);
      expect((await hook(stripeEvent("invoice.paid", in3, (NOW + 30 * DAY) / 1000))).status).toBe(200);
      paidInvoices = [...paidInvoices, { ...in3, amount_paid: 4900, tax: 0, created: (NOW + 30 * DAY) / 1000 } as never];
      // The payment cleared on day 2; its event is processed only now.
      const paidAt = NOW + 2 * DAY; at(NOW + 31 * DAY);
      expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", await newSession("paid"), paidAt / 1000))).status).toBe(200);
      const ops = await opAmounts();
      expect(ops).toContainEqual(expect.objectContaining({ id: "cutover:sub_test1", old_invoice_id: "in_1", cutover_at: paidAt, amount_cents: Math.round(4900 * 28 / 30) }));
      expect(ops).toContainEqual(expect.objectContaining({ id: "late_payment:in_3", kind: "late_payment", invoice_id: "in_3", amount_cents: 4900 }));
      expect(refundPosts().map((c) => c.form.get("amount")).sort()).toEqual([String(Math.round(4900 * 28 / 30)), "4900"].sort());
      // Its webhook again: the same invoice-keyed operation, nothing more.
      await hook(stripeEvent("invoice.paid", in3));
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(2);
    });
    it("r1-7: an async replacement onto Link switches the direct auto top-up off (durable revision in the cutover, applied to Flux)", async () => {
      await paidUs({ topup: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } });
      const t0 = await env.DB.prepare("SELECT enabled,revision,applied_revision FROM topup_settings").first<{ enabled: number; revision: number; applied_revision: number }>();
      expect(t0).toMatchObject({ enabled: 1 }); expect(t0!.applied_revision).toBe(t0!.revision);
      paidInvoices = [{ ...invoice(), id: "in_1", amount_paid: 4900, tax: 0, payment_intent: "pi_1", created: NOW / 1000 } as never];
      managed(); liveAddress("DE");
      await hook(custEvent("DE"));
      expect(await route()).toMatchObject({ seller: "link", collected_country: "DE" });
      expect((await checkoutDe()).status).toBe(200);
      at(NOW + DAY);
      await hook(stripeEvent("checkout.session.completed", await newSession("unpaid", DE), (NOW + DAY) / 1000));
      fluxLog = [];
      at(NOW + 2 * DAY);
      expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", await newSession("paid", DE), (NOW + 2 * DAY) / 1000))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test2" });
      const t1 = await env.DB.prepare("SELECT enabled,revision,applied_revision FROM topup_settings").first<{ enabled: number; revision: number; applied_revision: number }>();
      expect(t1).toMatchObject({ enabled: 0, revision: t0!.revision + 1, applied_revision: t0!.revision + 1 });
      expect(fluxLog.filter((f) => f.hook === "autorecharge").map((f) => (f.args as { enabled: boolean }).enabled)).toEqual([false]);
      expect(await count("SELECT COUNT(*) AS n FROM topup_events WHERE source='link_not_eligible'")).toBe(1);
    });
    it("an async replacement that actually changes seller (Link -> Ferrox direct): the home's contract is the direct one afterwards", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      const cid = await latestConsentId("home-1");
      at(NOW + DAY);
      await hook(stripeEvent("checkout.session.completed", await newSession("unpaid"), (NOW + DAY) / 1000));
      at(NOW + 2 * DAY);
      expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", await newSession("paid"), (NOW + 2 * DAY) / 1000))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test2", consent_id: cid, status: "active" });
      const seller = await env.DB.prepare("SELECT c.tax_source AS t FROM billing_subscriptions b JOIN checkout_consents c ON c.id=b.consent_id").first<{ t: string | null }>();
      expect(seller!.t).not.toBe("managed_payments");
      expect(JSON.parse((await env.DB.prepare("SELECT detail FROM refund_ops WHERE id='cutover:sub_test1'").first<{ detail: string }>())!.detail)).toMatchObject({ path: "mp" });
      signedIn = OWNER;
      expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ nextStep: null });
    });
    it("another home's subscription named in metadata.replaces moves nothing: the claim is refused and the payment refunded; neither plan is touched", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      piInvoices.pi_2 = "in_2";
      expect((await hook(stripeEvent("checkout.session.completed", await newSession("paid", { metadata: { home_id: "home-1", plan: "starter",
        consent_id: await latestConsentId("home-1"), replaces: "sub_home2" } })))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test1" });
      expect(await env.DB.prepare("SELECT kind FROM refund_ops").first()).toEqual({ kind: "duplicate" });
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM replacement_cutovers")).toBe(0);
      expect(subDeletes("sub_test1")).toHaveLength(0);
      expect(subDeletes("sub_home2")).toHaveLength(0);
    });
    it("the route at the endpoint: it expires at expires_at (409), and it is not reusable once the replacement completed", async () => {
      await runningMpFr(); await moveToUs();
      const r = (await route())!;
      at(r.expires_at as number);
      expect((await checkoutUs()).status).toBe(409);
      at(NOW);
      expect((await checkoutUs()).status).toBe(200);
      await hook(stripeEvent("checkout.session.completed", await newSession("paid")));
      expect(await route()).toBeNull();
      await env.DB.prepare("DELETE FROM open_checkouts WHERE home_id='home-1'").run();
      expect((await checkoutUs()).status).toBe(409);
    });
    it("a second address change while the replacement page is open: the route follows it; paying the open page still moves once, and the new plan gets the same check", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      liveAddress("ZZ");
      expect((await hook(custEvent("ZZ"))).status).toBe(200);
      expect(await route()).toMatchObject({ seller: "none", collected_country: "ZZ", replaces_subscription_id: "sub_test1" });
      expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='address_change'")).toBe(2);
      expect((await hook(stripeEvent("checkout.session.completed", await newSession("paid")))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test2" });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='cutover'")).toBe(1);
      expect(await route()).toBeNull();
      await hook(custEvent("ZZ"));
      expect(await route()).toMatchObject({ seller: "none", replaces_subscription_id: "sub_test2" });
    });
    it("a crash between the cutover and the Stripe cancellation: the committed cutover is finished by the retry, refunded once", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      cancelStuck = true;
      const ev = stripeEvent("checkout.session.completed", await newSession("paid"), (NOW + 3 * DAY) / 1000);
      at(NOW + 3 * DAY);
      expect((await hook(ev)).status).toBe(500);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test2" });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE id='cutover:sub_test1'")).toBe(1);
      expect(refundPosts()).toHaveLength(0);
      cancelStuck = false;
      await retry(ev.id);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).not.toEqual({ p: null });
      expect(subState.sub_test1?.status).toBe("canceled");
      expect(refundPosts()).toHaveLength(1);
      expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='replacement_done'")).toBe(1);
    });
    it("nextStep is per account: another account's route never shows on this account's page", async () => {
      await runningMpFr();
      await env.DB.prepare("INSERT INTO checkout_retry_routes (account_id,seller,collected_country,reason,replaces_subscription_id,expires_at) VALUES ('someone-else','ferrox','US','address_change','sub_x',?)")
        .bind(NOW + 60 * DAY).run();
      signedIn = OWNER;
      expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ nextStep: null });
      liveAddress("US");
      expect((await hook(custEvent("US"))).status).toBe(200);
      expect(await env.DB.prepare("SELECT replaces_subscription_id AS r FROM checkout_retry_routes WHERE account_id=?").bind(OWNER).first()).toEqual({ r: "sub_test1" });
      expect(await env.DB.prepare("SELECT replaces_subscription_id AS r FROM checkout_retry_routes WHERE account_id='someone-else'").first()).toEqual({ r: "sub_x" });
      expect(await (await get("/v1/account/cloud")).json()).toMatchObject({ nextStep: { kind: "continue_to_payment", country: "US", path: "direct" } });
    });
    it("the address-change email and alert carry the country only: no street, postal code, city, name or email address", async () => {
      await runningMpFr();
      const address = { country: "US", line1: "742 Evergreen Terrace", postal_code: "97403", city: "Springfield", state: "OR" };
      customerIdentity = { address, name: "Homer Private", email: "homer.private@example.test" };
      expect((await hook(stripeEvent("customer.updated", { object: "customer", id: "cus_test1", address, name: "Homer Private", email: "homer.private@example.test" }))).status).toBe(200);
      expect(notices.some((n) => n.kind === "address_change")).toBe(true);
      const stored = JSON.stringify([notices, (await env.DB.prepare("SELECT payload FROM billing_notices").all()).results,
        (await env.DB.prepare("SELECT detail FROM cloud_alerts").all()).results, await route()]);
      for (const pii of ["742 Evergreen", "97403", "Springfield", "Homer Private", "homer.private@example.test"]) expect(stored).not.toContain(pii);
    });
    it("migration 0071 applies over populated rows: an existing cutover's boundary is backfilled, the ledger untouched, and it is idempotent", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      await hook(stripeEvent("checkout.session.completed", await newSession("paid")));
      const ledger = (await env.DB.prepare("SELECT * FROM refund_ops ORDER BY id").all()).results;
      expect(ledger.length).toBeGreaterThan(0);
      const run = async () => {
        const stmts = m0071.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean);
        for (const x of stmts) await env.DB.prepare(x).run();
      };
      await env.DB.prepare("DROP TABLE replacement_cutovers").run(); // the database as it was before 0071
      await run();
      expect(await env.DB.prepare("SELECT old_subscription_id,home_id,replacement_subscription_id,cutover_at,old_invoice_id,old_period_start,old_period_end FROM replacement_cutovers").all())
        .toMatchObject({ results: [{ old_subscription_id: "sub_test1", home_id: "home-1", replacement_subscription_id: "sub_test2", cutover_at: NOW, old_invoice_id: "in_1",
          old_period_start: NOW, old_period_end: NOW + 30 * DAY }] });
      await run();
      expect(await count("SELECT COUNT(*) AS n FROM replacement_cutovers")).toBe(1);
      expect((await env.DB.prepare("SELECT * FROM refund_ops ORDER BY id").all()).results).toEqual(ledger);
    });

    // ---- WP6 r2 (Astra WP6-2) ------------------------------------------------------------------------------------------------------
    const run0071 = async () => {
      const stmts = m0071.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean);
      for (const x of stmts) await env.DB.prepare(x).run();
    };
    /** A zero-value cutover at the very end of the old period (under half a cent left): no refund operation. */
    const zeroValueCutover = async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      const paidAt = NOW + 30 * DAY - 100_000; at(paidAt);
      expect((await hook(stripeEvent("checkout.session.completed", await newSession("paid"), paidAt / 1000))).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      return paidAt;
    };
    const unservedIn4 = () => { piInvoices.pi_4 = "in_4"; return invoice({ id: "in_4", billing_reason: "subscription_cycle", payment_intent: "pi_4", lines: period(30, 60) }); };

    it("r2-1: a legacy zero-value cutover (no refund operation, no boundary row) is recovered from its original payment event: a $49 unserved old invoice is refunded", async () => {
      const paidAt = await zeroValueCutover();
      await env.DB.prepare("DELETE FROM replacement_cutovers").run(); // a cutover made before 0071, nothing owed: nothing to backfill from
      at(NOW + 31 * DAY);
      expect((await hook(stripeEvent("invoice.paid", unservedIn4(), (NOW + 30 * DAY) / 1000))).status).toBe(200);
      expect(await env.DB.prepare("SELECT id,kind,invoice_id,target_cents FROM refund_ops").first()).toEqual({ id: "late_payment:in_4", kind: "late_payment", invoice_id: "in_4", target_cents: 4900 });
      expect(refundPosts().map((c) => c.form.get("amount"))).toEqual(["4900"]);
      expect(await env.DB.prepare("SELECT replacement_subscription_id,cutover_at,old_invoice_id,source FROM replacement_cutovers").first())
        .toEqual({ replacement_subscription_id: "sub_test2", cutover_at: paidAt, old_invoice_id: null, source: "payment_event" });
    });
    it("r2-1: a replaced plan's invoice whose boundary cannot be resolved stays a retryable reconciliation obligation (alerted, never closed) until it is decided", async () => {
      const paidAt = await zeroValueCutover();
      await env.DB.prepare("DELETE FROM replacement_cutovers").run();
      await env.DB.prepare("DELETE FROM stripe_events WHERE type LIKE 'checkout.session.%'").run(); // the original payment event is not on record
      at(NOW + 31 * DAY);
      const ev = stripeEvent("invoice.paid", unservedIn4(), (NOW + 30 * DAY) / 1000);
      expect((await hook(ev)).status).toBe(500);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).toEqual({ p: null });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.replaced_boundary_unresolved'")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM replacement_cutovers")).toBe(0); // nothing invented
      await retry(ev.id); // still unresolved: still pending, alerted once
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).toEqual({ p: null });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.replaced_boundary_unresolved'")).toBe(1);
      // Ops records the boundary: the retry decides the refund and closes the event.
      await env.DB.prepare("INSERT INTO replacement_cutovers (old_subscription_id,home_id,replacement_subscription_id,cutover_at,created_at,source) VALUES ('sub_test1','home-1','sub_test2',?,?,'ops')")
        .bind(paidAt, paidAt).run();
      await retry(ev.id);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).not.toEqual({ p: null });
      expect(await env.DB.prepare("SELECT id,target_cents FROM refund_ops").first()).toEqual({ id: "late_payment:in_4", target_cents: 4900 });
    });
    it("r2-1/r2-3: migration 0071 over a populated database: a zero-value cutover is recovered from its payment event, a chained A->B->C keeps A->B, an unrecoverable one is not invented", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      await hook(stripeEvent("checkout.session.completed", await newSession("paid"))); // A->B, a refund owed (refund operation)
      // The home moved on again (B->C): its current subscription is no longer A's successor.
      await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='sub_test3' WHERE home_id='home-1'").run();
      // Two legacy zero-value cutovers (no refund operation): X->Y with its payment event on record, Z without one.
      await env.DB.prepare("INSERT INTO rejected_subscriptions (subscription_id,at,reason) VALUES ('sub_x',?,'replaced'),('sub_z',?,'replaced')").bind(NOW, NOW).run();
      const legacy = stripeEvent("checkout.session.completed", { ...(await newSession("paid")), id: "cs_legacy", subscription: "sub_y",
        metadata: { home_id: "home-1", plan: "starter", replaces: "sub_x" } }, (NOW + 5 * DAY) / 1000);
      await env.DB.prepare("INSERT INTO stripe_events (id,type,payload,received_at,processed_at) VALUES (?,?,?,?,?)").bind(legacy.id, legacy.type, JSON.stringify(legacy), NOW, NOW).run();
      // Its committed cutover evidence (r3-1): the cutover batch's own "replacement done" obligation for that home and successor.
      await env.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at) VALUES ('replacement_done:home-1:sub_y','home-1','replacement_done','{}',?)").bind(NOW + 5 * DAY).run();
      const ledger = (await env.DB.prepare("SELECT * FROM refund_ops ORDER BY id").all()).results;
      await env.DB.prepare("DROP TABLE replacement_cutovers").run();
      await run0071(); await run0071();
      expect((await env.DB.prepare("SELECT old_subscription_id,home_id,replacement_subscription_id,cutover_at,old_invoice_id,source FROM replacement_cutovers ORDER BY old_subscription_id").all()).results)
        .toEqual([
          { old_subscription_id: "sub_test1", home_id: "home-1", replacement_subscription_id: "sub_test2", cutover_at: NOW, old_invoice_id: "in_1", source: "refund_op" },
          { old_subscription_id: "sub_x", home_id: "home-1", replacement_subscription_id: "sub_y", cutover_at: NOW + 5 * DAY, old_invoice_id: null, source: "payment_event" },
        ]);
      expect((await env.DB.prepare("SELECT * FROM refund_ops ORDER BY id").all()).results).toEqual(ledger);
    });
    it("r2-3: a cutover refund whose original payment event is not on record backfills its successor as unknown (NULL), never the home's current subscription", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      await hook(stripeEvent("checkout.session.completed", await newSession("paid")));
      await env.DB.prepare("DELETE FROM stripe_events WHERE type LIKE 'checkout.session.%'").run();
      await env.DB.prepare("DROP TABLE replacement_cutovers").run();
      await run0071();
      expect(await env.DB.prepare("SELECT replacement_subscription_id AS r,source FROM replacement_cutovers").first()).toEqual({ r: null, source: "refund_op" });
    });
    /** An EU-resident (DE) replacement whose payment is pending at completion, then clears at NOW + 2d while the old plan's cancellation fails. */
    const asyncDeCutoverCancelFails = async () => {
      await paidUs(); managed(); liveAddress("DE");
      await hook(custEvent("DE"));
      expect((await checkoutDe()).status).toBe(200);
      const cid = await latestConsentId("home-1");
      at(NOW + DAY);
      await hook(stripeEvent("checkout.session.completed", await newSession("unpaid", DE), (NOW + DAY) / 1000));
      cancelStuck = true;
      at(NOW + 2 * DAY);
      const ev = stripeEvent("checkout.session.async_payment_succeeded", await newSession("paid", DE), (NOW + 2 * DAY) / 1000);
      expect((await hook(ev)).status).toBe(500);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test2" }); // the cutover committed
      return { cid, ev };
    };
    const clocks = (cid: string) => env.DB.prepare("SELECT paid_at,guarantee_withdraw_until AS g FROM checkout_consents WHERE id=?").bind(cid).first();
    it("r2-2: the cutover freezes the replacement's paid_at and guarantee; cancellation fails, the replacement's invoice.paid comes next, the retry keeps it", async () => {
      const { cid, ev } = await asyncDeCutoverCancelFails();
      const want = { paid_at: NOW + 2 * DAY, g: aoeEnd(NOW + 2 * DAY, 14) };
      expect(await clocks(cid)).toEqual(want); // frozen in the cutover batch, with replacement semantics
      at(NOW + 2 * DAY + 60_000);
      expect((await hook(stripeEvent("invoice.paid", newInvoice({ payment_intent: "pi_2" }), (NOW + 2 * DAY + 60_000) / 1000))).status).toBe(200);
      expect(await clocks(cid)).toEqual(want);
      cancelStuck = false;
      await retry(ev.id);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).not.toEqual({ p: null });
      expect(await clocks(cid)).toEqual(want);
      // The replacement's "Payment received" obligation was recorded once, with the frozen moment.
      expect(await count(`SELECT COUNT(*) AS n FROM billing_notices WHERE id='payment_received:home-1:${cid}'`)).toBe(1);
    });
    it("r2-2: a cutover committed without a paid moment (before r2): the replacement's invoice.paid records it from the frozen boundary with replacement semantics", async () => {
      const { cid } = await asyncDeCutoverCancelFails();
      await env.DB.prepare("UPDATE checkout_consents SET paid_at=NULL,guarantee_withdraw_until=NULL,refund7_until=NULL WHERE id=?").bind(cid).run();
      at(NOW + 3 * DAY);
      expect((await hook(stripeEvent("invoice.paid", newInvoice({ payment_intent: "pi_2" }), (NOW + 3 * DAY) / 1000))).status).toBe(200);
      expect(await clocks(cid)).toEqual({ paid_at: NOW + 2 * DAY, g: aoeEnd(NOW + 2 * DAY, 14) });
    });
    it("lease takeover after the committed cutover: another holder blocks the retry (nothing done twice); once it lets go the retry finishes, refunded once", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      cancelStuck = true;
      const ev = stripeEvent("checkout.session.completed", await newSession("paid"), (NOW + 3 * DAY) / 1000);
      at(NOW + 3 * DAY);
      expect((await hook(ev)).status).toBe(500);
      cancelStuck = false;
      await env.DB.prepare("INSERT OR REPLACE INTO billing_home_leases (home_id,holder,lease_until,generation) VALUES ('home-1','other-worker',?,9999)").bind(Date.now() + 10 * 365 * DAY).run();
      await retry(ev.id);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).toEqual({ p: null });
      expect(refundPosts()).toHaveLength(0);
      await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL").run();
      await retry(ev.id);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).not.toEqual({ p: null });
      expect(subState.sub_test1?.status).toBe("canceled");
      expect(refundPosts()).toHaveLength(1);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='cutover'")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM replacement_cutovers")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='replacement_done'")).toBe(1);
    });
    // ---- WP6 r3 (Astra WP6-3) ------------------------------------------------------------------------------------------------------
    const pending = async (id: string) => expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(id).first()).toEqual({ p: null });
    it("r3-1: cutover day 30, its payment event missing, a refunded duplicate paid day 40: the boundary stays unknown, the $49 unserved invoice is never cut to $32.67", async () => {
      await zeroValueCutover();
      await env.DB.prepare("DELETE FROM replacement_cutovers").run();
      await env.DB.prepare("DELETE FROM stripe_events WHERE type LIKE 'checkout.session.%'").run(); // the original payment event is not on record
      // A second paid replacement attempt on day 40, rejected as a duplicate and refunded: never adopted, no cutover of its own.
      const dup = stripeEvent("checkout.session.completed", { ...(await newSession("paid")), id: "cs_dup", subscription: "sub_dup",
        metadata: { home_id: "home-1", plan: "starter", replaces: "sub_test1" } }, (NOW + 40 * DAY) / 1000);
      await env.DB.prepare("INSERT INTO stripe_events (id,type,payload,received_at,processed_at) VALUES (?,?,?,?,?)").bind(dup.id, dup.type, JSON.stringify(dup), NOW + 40 * DAY, NOW + 40 * DAY).run();
      await env.DB.prepare("INSERT INTO rejected_subscriptions (subscription_id,at,reason) VALUES ('sub_dup',?,'duplicate')").bind(NOW + 40 * DAY).run();
      expect(await count("SELECT COUNT(*) AS n FROM replacement_payment_events")).toBe(0);
      at(NOW + 41 * DAY);
      const ev = stripeEvent("invoice.paid", unservedIn4(), (NOW + 41 * DAY) / 1000);
      expect((await hook(ev)).status).toBe(500);
      await pending(ev.id);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.replaced_boundary_unresolved'")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM replacement_cutovers")).toBe(0); // neither boundary nor successor invented
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(refundPosts()).toHaveLength(0);
      // Without the rejection row the duplicate still proves nothing: it has no committed cutover of its own.
      await env.DB.prepare("DELETE FROM rejected_subscriptions WHERE subscription_id='sub_dup'").run();
      expect(await count("SELECT COUNT(*) AS n FROM replacement_payment_events")).toBe(0);
      await retry(ev.id);
      await pending(ev.id);
      expect(await count("SELECT COUNT(*) AS n FROM replacement_cutovers")).toBe(0);
    });
    it("r3-2: an unresolved $49 invoice with a $1 external refund (or an undecided one) stays pending; a decided refund covering all of it closes it", async () => {
      await zeroValueCutover();
      await env.DB.prepare("DELETE FROM replacement_cutovers").run();
      await env.DB.prepare("DELETE FROM stripe_events WHERE type LIKE 'checkout.session.%'").run();
      const op = (id: string, kind: string, amount: number | null, decided: number | null) => env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,paid_cents,target_cents,amount_cents,end_plan,decided_at,created_at,updated_at)
        VALUES (?,?,'home-1',?,'in_4',4900,?,?,0,?,?,?)`).bind(id, kind, OWNER, amount, amount, decided, NOW, NOW).run();
      await op("extraordinary:ext1", "extraordinary", 100, NOW); // $1, decided, unrelated
      await op("extraordinary:ext0", "extraordinary", 0, NOW);   // zero
      await op("extraordinary:extu", "extraordinary", 4900, null); // undecided
      at(NOW + 31 * DAY);
      const ev = stripeEvent("invoice.paid", unservedIn4(), (NOW + 30 * DAY) / 1000);
      expect((await hook(ev)).status).toBe(500);
      await pending(ev.id);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.replaced_boundary_unresolved'")).toBe(1);
      // The remaining $48 is decided: together the decided refunds now cover the whole $49, and the retry closes the obligation.
      await op("extraordinary:ext48", "extraordinary", 4800, NOW);
      await retry(ev.id);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).not.toEqual({ p: null });
    });
    it("r3-2: an explicit, decided replacement-refund decision for the invoice closes it; the same decision undecided keeps it pending", async () => {
      await zeroValueCutover();
      await env.DB.prepare("DELETE FROM replacement_cutovers").run();
      await env.DB.prepare("DELETE FROM stripe_events WHERE type LIKE 'checkout.session.%'").run();
      await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,paid_cents,target_cents,end_plan,created_at,updated_at)
        VALUES ('late_payment:in_4','late_payment','home-1',?,'in_4',4900,4900,0,?,?)`).bind(OWNER, NOW, NOW).run();
      at(NOW + 31 * DAY);
      const ev = stripeEvent("invoice.paid", unservedIn4(), (NOW + 30 * DAY) / 1000);
      expect((await hook(ev)).status).toBe(500);
      await pending(ev.id);
      await env.DB.prepare("UPDATE refund_ops SET decided_at=?,amount_cents=0 WHERE id='late_payment:in_4'").bind(NOW).run(); // ops decides: nothing to refund
      await retry(ev.id);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).not.toEqual({ p: null });
    });
    it("r3: lease takeover DURING the cutover's pre-batch Stripe read: nothing is written; once the holder lets go the retry cuts over once, refunded once", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      const ev = stripeEvent("checkout.session.completed", await newSession("paid"), (NOW + 3 * DAY) / 1000);
      at(NOW + 3 * DAY);
      onInvoiceList = () => env.DB.prepare("INSERT OR REPLACE INTO billing_home_leases (home_id,holder,lease_until,generation) VALUES ('home-1','other-worker',?,9999)")
        .bind(Date.now() + 10 * 365 * DAY).run();
      await hook(ev);
      expect(onInvoiceList).toBeNull(); // the takeover happened inside the read
      await pending(ev.id);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test1" });
      for (const t of ["refund_ops", "replacement_cutovers", "rejected_subscriptions"]) expect(await count(`SELECT COUNT(*) AS n FROM ${t}`)).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='replacement_done'")).toBe(0);
      expect(subState.sub_test1?.status).not.toBe("canceled");
      expect(refundPosts()).toHaveLength(0);
      await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL").run();
      await retry(ev.id);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).not.toEqual({ p: null });
      expect(await billing()).toMatchObject({ subscription_id: "sub_test2" });
      expect(subState.sub_test1?.status).toBe("canceled");
      expect(refundPosts()).toHaveLength(1);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='cutover'")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM replacement_cutovers")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='replacement_done'")).toBe(1);
    });
    it("a SEEDED other home's subscription named in metadata.replaces: nothing of either home moves; the payment is refunded in full", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      const cols = (await env.DB.prepare("PRAGMA table_info(billing_subscriptions)").all<{ name: string }>()).results.map((c) => c.name);
      const pick = (c: string) => c === "home_id" ? "'home-2'" : c === "subscription_id" ? "'sub_home2'" : c === "customer_id" ? "'cus_home2'" : c;
      await env.DB.prepare("PRAGMA foreign_keys=OFF").run().catch(() => undefined);
      await env.DB.prepare(`INSERT INTO billing_subscriptions (${cols.join(",")}) SELECT ${cols.map(pick).join(",")} FROM billing_subscriptions WHERE home_id='home-1'`).run();
      const home2 = await env.DB.prepare("SELECT * FROM billing_subscriptions WHERE home_id='home-2'").first();
      piInvoices.pi_2 = "in_2";
      expect((await hook(stripeEvent("checkout.session.completed", await newSession("paid", { metadata: { home_id: "home-1", plan: "starter",
        consent_id: await latestConsentId("home-1"), replaces: "sub_home2" } })))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test1" });
      expect(await env.DB.prepare("SELECT * FROM billing_subscriptions WHERE home_id='home-2'").first()).toEqual(home2);
      expect(await env.DB.prepare("SELECT kind,amount_cents FROM refund_ops").first()).toEqual({ kind: "duplicate", amount_cents: 4900 });
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM replacement_cutovers")).toBe(0);
      expect(subDeletes("sub_home2")).toHaveLength(0);
      expect(subDeletes("sub_test1")).toHaveLength(0);
    });
    it("a disputed old plan is never taken over: paid at completion, the old claim stays and the replacement payment is refunded in full", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      await env.DB.prepare("UPDATE billing_subscriptions SET status='disputed' WHERE home_id='home-1'").run();
      piInvoices.pi_2 = "in_2";
      expect((await hook(stripeEvent("checkout.session.completed", await newSession("paid")))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test1", status: "disputed" });
      expect((await env.DB.prepare("SELECT amount_cents FROM refund_ops").all()).results).toEqual([{ amount_cents: 4900 }]);
      expect(await count("SELECT COUNT(*) AS n FROM replacement_cutovers")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM rejected_subscriptions WHERE reason='replaced'")).toBe(0);
      expect(subDeletes("sub_test1")).toHaveLength(0);
    });
    it("a disputed old plan is never taken over: payment clearing later, the old claim stays and the replacement payment is refunded in full", async () => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      at(NOW + DAY);
      await hook(stripeEvent("checkout.session.completed", await newSession("unpaid"), (NOW + DAY) / 1000));
      await env.DB.prepare("UPDATE billing_subscriptions SET status='disputed' WHERE home_id='home-1'").run();
      piInvoices.pi_2 = "in_2";
      at(NOW + 2 * DAY);
      expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", await newSession("paid"), (NOW + 2 * DAY) / 1000))).status).toBe(200);
      expect(await billing()).toMatchObject({ subscription_id: "sub_test1", status: "disputed" });
      expect((await env.DB.prepare("SELECT amount_cents FROM refund_ops").all()).results).toEqual([{ amount_cents: 4900 }]);
      expect(await count("SELECT COUNT(*) AS n FROM replacement_cutovers")).toBe(0);
      expect(subDeletes("sub_test1")).toHaveLength(0);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.replacement_unrecoverable'")).toBe(1);
    });

    // ---- integration WP5 x WP6 (Astra INT-1) ----
    const oldConsentId = async () => (await env.DB.prepare("SELECT id FROM checkout_consents WHERE stripe_subscription_id='sub_test1' ORDER BY created_at LIMIT 1").first<{ id: string }>())!.id;
    /** The OLD plan's checkout session whose delayed payment clears only after the cutover; Stripe returns `inv` as the session's invoice. */
    const lateOldSession = async (inv: Record<string, unknown>) => {
      retrievable[`/v1/invoices/${String(inv.id)}`] = inv;
      return oldSession({ id: "cs_old_late", invoice: inv.id, metadata: { home_id: "home-1", plan: "starter", consent_id: await oldConsentId() } });
    };
    const outcome = async (id: string) => (await env.DB.prepare("SELECT error FROM stripe_events WHERE id=?").bind(id).first<{ error: string | null }>())?.error;
    it("int-1: a late async payment on a replaced plan is judged like its invoice.paid: a fully served old invoice is not refunded", async () => {
      await zeroValueCutover(); refundsMade = []; stripeCalls = [];
      at(NOW + 31 * DAY);
      const ev = stripeEvent("checkout.session.async_payment_succeeded",
        await lateOldSession(invoice({ id: "in_0", billing_reason: "subscription_cycle", lines: period(-30, 0) })), (NOW + 31 * DAY) / 1000);
      expect((await hook(ev)).status).toBe(200);
      expect(await outcome(ev.id)).toBe("replaced_invoice_served");
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(refundPosts()).toHaveLength(0);
    });
    it("int-1: a late async payment on a replaced plan for a half-served old invoice gets the pro-rata cutover refund from the frozen boundary, not the whole amount", async () => {
      const paidAt = await zeroValueCutover(); refundsMade = []; stripeCalls = [];
      piInvoices.pi_5 = "in_5";
      at(NOW + 31 * DAY);
      const ev = stripeEvent("checkout.session.async_payment_succeeded",
        await lateOldSession(invoice({ id: "in_5", billing_reason: "subscription_cycle", payment_intent: "pi_5", lines: period(15, 45) })), (NOW + 31 * DAY) / 1000);
      expect((await hook(ev)).status).toBe(200);
      expect(await outcome(ev.id)).toBe("replaced_late_payment_refunded");
      const unused = Math.round(4900 * (NOW + 45 * DAY - paidAt) / (30 * DAY));
      expect(await opAmounts()).toEqual([expect.objectContaining({ id: "late_payment:in_5", kind: "cutover", invoice_id: "in_5", amount_cents: unused, cutover_at: paidAt })]);
      expect(refundPosts().filter((c) => c.form.get("amount") === "4900")).toHaveLength(0); // never the whole invoice
      expect(await count("SELECT COUNT(*) AS n FROM credit_reversals")).toBe(0); // a partly served month: its credit is not reversed
    });
    it("int-1: a late async payment on a replaced plan whose boundary cannot be resolved stays a retryable, alerted obligation, never a refund", async () => {
      await zeroValueCutover();
      await env.DB.prepare("DELETE FROM replacement_cutovers").run();
      await env.DB.prepare("DELETE FROM stripe_events WHERE type LIKE 'checkout.session.%'").run(); // the original payment event is not on record
      refundsMade = []; stripeCalls = [];
      at(NOW + 31 * DAY);
      const ev = stripeEvent("checkout.session.async_payment_succeeded", await lateOldSession(unservedIn4()), (NOW + 31 * DAY) / 1000);
      expect((await hook(ev)).status).toBe(500);
      expect(await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(ev.id).first()).toEqual({ p: null });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.replaced_boundary_unresolved'")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(refundPosts()).toHaveLength(0);
    });

    // ---- integration round 2 (Astra INT-2) ----
    const processedAt = async (id: string) => (await env.DB.prepare("SELECT processed_at AS p FROM stripe_events WHERE id=?").bind(id).first<{ p: number | null }>())!.p;
    const halfServedIn5 = () => { piInvoices.pi_5 = "in_5"; return invoice({ id: "in_5", billing_reason: "subscription_cycle", payment_intent: "pi_5", lines: period(15, 45) }); };
    const notePosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/credit_notes");
    const op5 = () => env.DB.prepare("SELECT kind,amount_cents,detail,credit_note_id,refunded_at FROM refund_ops WHERE id='late_payment:in_5'")
      .first<{ kind: string; amount_cents: number; detail: string; credit_note_id: string | null; refunded_at: number | null }>();
    it("int2-1: a paid async session of a replaced plan that names no invoice is never acknowledged: alerted and retried; once Stripe shows the invoice it is judged normally", async () => {
      const paidAt = await zeroValueCutover(); refundsMade = []; stripeCalls = [];
      at(NOW + 31 * DAY);
      const withInvoice = await lateOldSession(halfServedIn5());
      const noInvoice = { ...withInvoice, invoice: null };
      retrievable["/v1/checkout/sessions/cs_old_late"] = noInvoice; // Stripe itself shows no invoice on the session yet
      const ev = stripeEvent("checkout.session.async_payment_succeeded", noInvoice, (NOW + 31 * DAY) / 1000);
      expect((await hook(ev)).status).toBe(500);
      expect(await processedAt(ev.id)).toBeNull();
      expect(stripeCalls.some((c) => c.method === "GET" && c.path === "/v1/checkout/sessions/cs_old_late")).toBe(true);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.replaced_session_invoice_missing' AND resolved_at IS NULL")).toBe(1);
      expect(await env.DB.prepare("SELECT next_attempt_at AS n FROM stripe_events WHERE id=?").bind(ev.id).first<{ n: number | null }>()).not.toEqual({ n: null });
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
      expect(refundPosts()).toHaveLength(0);
      // Stripe now shows the invoice (expanded, as an object): the retry classifies it against the frozen boundary.
      retrievable["/v1/checkout/sessions/cs_old_late"] = { ...noInvoice, invoice: { id: "in_5", object: "invoice" } };
      await retry(ev.id);
      expect(await processedAt(ev.id)).not.toBeNull();
      expect(await outcome(ev.id)).toBe("replaced_late_payment_refunded");
      const unused = Math.round(4900 * (NOW + 45 * DAY - paidAt) / (30 * DAY));
      expect(await op5()).toMatchObject({ kind: "cutover", amount_cents: unused });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.replaced_session_invoice_missing' AND resolved_at IS NULL")).toBe(0);
    });
    it("int3-2: the session's missing-invoice alert closes when a later event carries the invoice in the event object itself", async () => {
      await zeroValueCutover(); refundsMade = []; stripeCalls = [];
      at(NOW + 31 * DAY);
      const withInvoice = await lateOldSession(halfServedIn5());
      const noInvoice = { ...withInvoice, invoice: null };
      retrievable["/v1/checkout/sessions/cs_old_late"] = noInvoice;
      const ev1 = stripeEvent("checkout.session.async_payment_succeeded", noInvoice, (NOW + 31 * DAY) / 1000);
      expect((await hook(ev1)).status).toBe(500);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.replaced_session_invoice_missing' AND resolved_at IS NULL")).toBe(1);
      // API-version reconciliation: the same session arrives in a new event with its invoice inside the event object.
      const ev2 = stripeEvent("checkout.session.async_payment_succeeded", withInvoice, (NOW + 31 * DAY) / 1000);
      expect((await hook(ev2)).status).toBe(200);
      expect(await outcome(ev2.id)).toBe("replaced_late_payment_refunded");
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='checkout.replaced_session_invoice_missing' AND resolved_at IS NULL")).toBe(0);
    });
    it("int2-2: a Link (Managed Payments) old plan: the pro-rata refund of a half-served old invoice goes through POST /v1/refunds at the amount, never a credit note; a replay adds nothing", async () => {
      const paidAt = await zeroValueCutover(); refundsMade = []; stripeCalls = []; creditNotesOn = true;
      at(NOW + 31 * DAY);
      const unused = Math.round(4900 * (NOW + 45 * DAY - paidAt) / (30 * DAY));
      expect((await hook(stripeEvent("invoice.paid", halfServedIn5(), (NOW + 30 * DAY) / 1000))).status).toBe(200);
      const op = (await op5())!;
      expect(op).toMatchObject({ kind: "cutover", amount_cents: unused, credit_note_id: null });
      expect(JSON.parse(op.detail)).toMatchObject({ path: "mp" });
      expect(op.refunded_at).not.toBeNull();
      expect(refundPosts().map((c) => c.form.get("amount"))).toEqual([String(unused)]);
      expect(notePosts()).toHaveLength(0);
      await hook(stripeEvent("invoice.paid", halfServedIn5(), (NOW + 30 * DAY) / 1000)); await sweepNow();
      expect(refundPosts()).toHaveLength(1);
      expect(notePosts()).toHaveLength(0);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(1);
    });
    it("int2-2: a direct (Ferrox) old plan: the pro-rata refund of a half-served old invoice is one credit note with refund_amount at the amount, never POST /v1/refunds; a replay adds nothing", async () => {
      const paidAt = await zeroValueCutover(); refundsMade = []; stripeCalls = []; creditNotesOn = true;
      await env.DB.prepare("UPDATE checkout_consents SET tax_source='stripe_tax' WHERE id=?").bind(await oldConsentId()).run(); // the old contract was direct
      at(NOW + 31 * DAY);
      const unused = Math.round(4900 * (NOW + 45 * DAY - paidAt) / (30 * DAY));
      expect((await hook(stripeEvent("invoice.paid", halfServedIn5(), (NOW + 30 * DAY) / 1000))).status).toBe(200);
      const op = (await op5())!;
      expect(op).toMatchObject({ kind: "cutover", amount_cents: unused, credit_note_id: "cn_1" });
      expect(JSON.parse(op.detail)).toMatchObject({ path: "direct" });
      expect(op.refunded_at).not.toBeNull();
      expect(notePosts().map((c) => [c.form.get("invoice"), c.form.get("amount"), c.form.get("refund_amount")])).toEqual([["in_5", String(unused), String(unused)]]);
      expect(refundPosts()).toHaveLength(0);
      await hook(stripeEvent("invoice.paid", halfServedIn5(), (NOW + 30 * DAY) / 1000)); await sweepNow();
      expect(notePosts()).toHaveLength(1);
      expect(refundPosts()).toHaveLength(0);
      expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(1);
    });

    /** r1-6's delayed cutover: an old renewal in_3 (days 30-60, never served) is charged before the replacement's payment event is processed. */
    const delayedCutoverWithRenewal = async (handled: boolean) => {
      await runningMpFr(); await moveToUs(); expect((await checkoutUs()).status).toBe(200);
      at(NOW + DAY);
      await hook(stripeEvent("checkout.session.completed", await newSession("unpaid"), (NOW + DAY) / 1000));
      const in3 = invoice({ id: "in_3", billing_reason: "subscription_cycle", payment_intent: "pi_3", lines: period(30, 60) });
      piInvoices.pi_3 = "in_3";
      at(NOW + 30 * DAY + 3_600_000);
      if (handled) expect((await hook(stripeEvent("invoice.paid", in3, (NOW + 30 * DAY) / 1000))).status).toBe(200);
      // Its frozen amount (a refund-backed reversal's target is computed from it).
      await env.DB.prepare(`UPDATE credit_grants SET body_json='{"amount_microcents":5000000}',body_sha256='x' WHERE invoice_id='in_3'`).run();
      paidInvoices = [...paidInvoices, { ...in3, amount_paid: 4900, tax: 0, created: (NOW + 30 * DAY) / 1000 } as never];
      // The replacement's own grant (its first invoice), which nothing here may touch.
      await env.DB.prepare("INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,granted_at) VALUES ('in_2','period','home-1','starter',?,?)").bind(NOW + DAY, NOW + DAY).run();
      fluxLog = []; refundsMade = []; stripeCalls = [];
      at(NOW + 31 * DAY);
      expect((await hook(stripeEvent("checkout.session.async_payment_succeeded", await newSession("paid"), (NOW + 2 * DAY) / 1000))).status).toBe(200);
    };
    const reversals = async () => (await env.DB.prepare("SELECT invoice_id AS i,kind AS k,reason AS r,op_id AS op,reversed_at AS at FROM credit_reversals ORDER BY invoice_id").all()).results;
    const voids = async () => (await env.DB.prepare("SELECT payment_id AS p,reason AS r,ref FROM cloud_payment_voids ORDER BY payment_id").all()).results;
    const revokes = () => fluxLog.filter((f) => f.hook === "revoke");
    const targets = () => fluxLog.filter((f) => f.hook === "target");
    it("int-2: a cutover refunding an unserved old renewal billing already handled takes back that renewal's credit and voids its payment, in the same batch; the replacement's grant and the frozen invoice's grant are untouched", async () => {
      await delayedCutoverWithRenewal(true);
      expect(await count("SELECT COUNT(*) AS n FROM credit_grants WHERE invoice_id='in_3' AND granted_at IS NOT NULL")).toBe(1); // WP5 granted it
      expect(await opAmounts()).toContainEqual(expect.objectContaining({ id: "late_payment:in_3", kind: "late_payment", amount_cents: 4900 }));
      // Astra JOURNEY-A-8 #3: a final versioned target following the renewal's money returned, never the one-shot /reverse.
      expect(await reversals()).toEqual([{ i: "in_3", k: "period", r: "replaced_unserved", op: "late_payment:in_3", at: NOW + 31 * DAY }]);
      expect(await env.DB.prepare("SELECT scope,final,removed_microcents AS m FROM credit_reversals").first()).toEqual({ scope: "target", final: 1, m: 5_000_000 });
      expect(revokes()).toEqual([]);
      expect(targets()).toEqual([{ hook: "target", args: expect.objectContaining({ homeId: "home-1", invoiceId: "in_3", kind: "period", grantId: "in_3:period",
        reason: "replaced_unserved", targetRemovedMicrocents: 5_000_000 }) }]);
      expect(await voids()).toEqual([{ p: "in_3", r: "replaced_unserved", ref: "late_payment:in_3" }]);
      expect(await count("SELECT COUNT(*) AS n FROM credit_grants WHERE invoice_id IN ('in_1','in_2')")).toBe(2);
      // Its webhook again: nothing more is refunded, reversed or voided.
      await hook(stripeEvent("invoice.paid", invoice({ id: "in_3", billing_reason: "subscription_cycle", payment_intent: "pi_3", lines: period(30, 60) })));
      expect(await reversals()).toHaveLength(1);
      expect(targets()).toHaveLength(1);
      expect(refundPosts().filter((c) => c.form.get("amount") === "4900")).toHaveLength(1);
    });
    it("int-2: a cutover refunding an unserved old renewal billing never handled journals nothing beyond the refund", async () => {
      await delayedCutoverWithRenewal(false);
      expect(await opAmounts()).toContainEqual(expect.objectContaining({ id: "late_payment:in_3", kind: "late_payment", amount_cents: 4900 }));
      expect(await reversals()).toEqual([]);
      expect(await voids()).toEqual([]);
      expect(revokes()).toHaveLength(0);
    });
  });
});

// ---- Customer journey, lane A ---------------------------------------------------------------------------------------------------
const REFERENCE = /^CX-[A-HJ-NP-Z2-9]{8}$/;

describe("journey A5: the in-app cancel answers with a receipt (reference, receivedAt, effectiveAt)", () => {
  it("returns a CX- reference, when it arrived and when the plan ends, and the same reference in the email", async () => {
    await paidUs(); signedIn = OWNER; notices = [];
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_end=?").bind(NOW + 30 * DAY).run();
    const res = await send("/v1/account/cancel-plan", { body: {} });
    expect(res.status).toBe(200);
    const body = await res.json() as { canceled: boolean; reference: string; receivedAt: number; effectiveAt: number; activeUntil: number };
    expect(body).toMatchObject({ canceled: true, receivedAt: NOW });
    expect(body.reference).toMatch(REFERENCE);
    expect(body.effectiveAt).toBe(body.activeUntil);
    expect(body.activeUntil).toBeGreaterThan(NOW);
    const text = (notices.find((n) => n.kind === "cancel_scheduled")!.data as { emailText: string }).emailText;
    expect(text).toContain(`Your cancellation reference: ${body.reference}`);
    expect(text).toContain("You cancelled your Murage Cloud plan.");
    // A second press shows the same receipt, not a new reference.
    const again = await (await send("/v1/account/cancel-plan", { body: {} })).json() as { reference: string; alreadyScheduled: boolean; receivedAt: number; effectiveAt: number };
    expect(again).toMatchObject({ alreadyScheduled: true, reference: body.reference, receivedAt: NOW, effectiveAt: body.effectiveAt });
    expect(await count("SELECT COUNT(*) AS n FROM plan_cancellations")).toBe(1);
  });
  it("keeps one reference through a cancel that is still processing, and the email carries it when it is confirmed", async () => {
    await paidUs(); signedIn = OWNER; notices = [];
    cancelFailNext = 1;
    expect(await (await send("/v1/account/cancel-plan", { body: {} })).json()).toEqual({ canceled: false, processing: true });
    const first = (await env.DB.prepare("SELECT reference FROM plan_cancellations").first<{ reference: string }>())!.reference;
    expect(first).toMatch(REFERENCE);
    const done = await (await send("/v1/account/cancel-plan", { body: {} })).json() as { canceled: boolean; reference: string };
    expect(done).toMatchObject({ canceled: true, reference: first });
    expect((notices.find((n) => n.kind === "cancel_scheduled")!.data as { emailText: string }).emailText).toContain(first);
  });
  it("the plan ends at Stripe even if the email cannot be sent (the effect never depends on the email)", async () => {
    await paidUs(); signedIn = OWNER; notifierFails = true;
    const res = await send("/v1/account/cancel-plan", { body: {} });
    expect(await res.json()).toMatchObject({ canceled: true, reference: expect.stringMatching(REFERENCE) });
    expect(subState.sub_test1?.cancel_at_period_end ?? true).toBe(true);
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c FROM billing_subscriptions").first()).toEqual({ c: 1 });
  });
  it("uses the public form's generator (cancel-reference.ts)", async () => {
    const { newRef, isCancelRef } = await import("../src/cancel-reference");
    expect(isCancelRef(newRef())).toBe(true);
    expect(isCancelRef("CX-0O1I2345")).toBe(false);
  });
});

describe("journey A5 (Astra JOURNEY-A-1): one reference allocator for the public form and the in-app cancel", () => {
  /** Makes the next `n` CX- references come out as CX-AAAAAAAA: only draws made by newRef (cancel-reference.ts) are forced. */
  const forceRefs = (n: number) => {
    const real = crypto.getRandomValues.bind(crypto);
    let left = n;
    return vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: ArrayBufferView) => {
      if (a instanceof Uint8Array && a.length === 8 && left > 0 && /newRef/.test(new Error().stack ?? "")) { left--; a.fill(0); return a; }
      return real(a as Uint8Array);
    }) as typeof crypto.getRandomValues);
  };
  const publicForm = () => send("/v1/public/cancellation", { body: { type: "end_of_paid_month", email: "nobody@example.test", name: "N", confirmationEmail: "nobody@example.test" } });
  it("a reference the public form already holds is never handed to an in-app cancel: the collision is retried with a fresh reference", async () => {
    await paidUs(); signedIn = OWNER;
    let spy = forceRefs(1);
    expect((await publicForm()).status).toBe(201);
    spy.mockRestore();
    expect(await env.DB.prepare("SELECT ref FROM cancellation_requests").first()).toEqual({ ref: "CX-AAAAAAAA" });
    spy = forceRefs(1); // the in-app cancel's first draw is the same number
    const body = await (await send("/v1/account/cancel-plan", { body: {} })).json() as { canceled: boolean; reference: string | null };
    spy.mockRestore();
    expect(body.canceled).toBe(true);
    expect(body.reference).toMatch(REFERENCE);
    expect(body.reference).not.toBe("CX-AAAAAAAA");
  });
  it("if no reference can be reserved the cancel still goes through, without a reference", async () => {
    await paidUs(); signedIn = OWNER;
    const spy = forceRefs(1000);
    expect((await publicForm()).status).toBe(201);
    const res = await send("/v1/account/cancel-plan", { body: {} });
    spy.mockRestore();
    expect(await res.json()).toMatchObject({ canceled: true, reference: null });
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c FROM billing_subscriptions").first()).toEqual({ c: 1 });
  });
  it("Astra JOURNEY-A-2 A5: a public cancellation whose reference cannot be reserved never shows an unreserved CX- number; the sweep reserves one", async () => {
    await paidUs(); signedIn = OWNER;
    let spy = forceRefs(1); // the in-app cancel holds CX-AAAAAAAA
    expect(await (await send("/v1/account/cancel-plan", { body: {} })).json()).toMatchObject({ canceled: true, reference: "CX-AAAAAAAA" });
    spy.mockRestore();
    spy = forceRefs(1000); // every draw for the public form collides with it
    const res = await publicForm();
    spy.mockRestore();
    expect(res.status).toBe(201); // the cancellation itself is recorded, never blocked
    const { id } = await res.json() as { id: string };
    const row = (await env.DB.prepare("SELECT ref,receipt_html FROM cancellation_requests WHERE id=?").bind(id).first<{ ref: string; receipt_html: string }>())!;
    expect(row.ref).toBe(id); // stored under its internal receipt id
    expect(row.receipt_html).not.toMatch(/CX-[A-HJ-NP-Z2-9]{8}/);
    expect(await count("SELECT COUNT(*) AS n FROM cancel_references WHERE reference='CX-AAAAAAAA'")).toBe(1);
    const { sweepCancellations } = await import("../src/public-cancellation");
    await sweepCancellations(baseEnv(envOver), deps()).catch(() => undefined);
    const after = (await env.DB.prepare("SELECT ref FROM cancellation_requests WHERE id=?").bind(id).first<{ ref: string }>())!.ref;
    expect(after).toMatch(REFERENCE);
    expect(after).not.toBe("CX-AAAAAAAA");
    expect(await env.DB.prepare("SELECT owner FROM cancel_references WHERE reference=?").bind(after).first()).toEqual({ owner: `public:${id}` });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM plan_cancellations WHERE reference=?").bind(after).first()).toEqual({ n: 0 });
  });
});

describe("journey A1: cancel reason and free text (separate call, never blocks or alters the cancel)", () => {
  const reasonOf = async () => env.DB.prepare("SELECT cancellation_id,user_id,reason,text,created_at,expires_at FROM cancellation_feedback").all<{ cancellation_id: string; user_id: string;
    reason: string; text: string | null; created_at: number; expires_at: number }>();
  const cancelled = async () => {
    await paidUs(); signedIn = OWNER;
    return (await (await send("/v1/account/cancel-plan", { body: {} })).json() as { reference: string }).reference;
  };
  it("stores the reason and text against the receipt, answers, and replaces the answer on a second call", async () => {
    const ref = await cancelled();
    const res = await send("/v1/account/cancel-plan/reason", { body: { cancellationId: ref, reason: "too_expensive", text: "  a bit much this month  " } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true, cancellationId: ref, reason: "too_expensive", receivedAt: NOW });
    let rows = (await reasonOf()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cancellation_id: ref, user_id: OWNER, reason: "too_expensive", text: "a bit much this month" });
    await send("/v1/account/cancel-plan/reason", { body: { cancellationId: ref, reason: "other" } });
    rows = (await reasonOf()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "other", text: null });
  });
  it("is optional and never changes the cancel: no Stripe call, no new email, no subscription change", async () => {
    const ref = await cancelled();
    const before = await env.DB.prepare("SELECT * FROM billing_subscriptions").first();
    stripeCalls = []; notices = [];
    expect((await send("/v1/account/cancel-plan/reason", { body: { cancellationId: ref, reason: "not_using_it", text: "x" } })).status).toBe(200);
    expect(stripeCalls).toEqual([]);
    expect(notices).toEqual([]);
    expect(await env.DB.prepare("SELECT * FROM billing_subscriptions").first()).toEqual(before);
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c FROM billing_subscriptions").first()).toEqual({ c: 1 });
  });
  it("refuses a bad reason, text over 500 characters, an unknown or another customer's cancellation, and no sign-in", async () => {
    const ref = await cancelled();
    const post = (body: unknown) => send("/v1/account/cancel-plan/reason", { body });
    expect((await post({ cancellationId: ref, reason: "because" })).status).toBe(400);
    expect((await post({ cancellationId: ref, reason: "other", text: "x".repeat(501) })).status).toBe(400);
    expect((await post({ cancellationId: ref, reason: "other", text: "x".repeat(500) })).status).toBe(200);
    expect((await post({ cancellationId: ref, reason: "other", extra: 1 })).status).toBe(400);
    expect((await post({ cancellationId: "CX-ZZZZZZZZ", reason: "other" })).status).toBe(404);
    expect((await post({ reason: "other" })).status).toBe(400);
    signedIn = "someone-else";
    expect((await post({ cancellationId: ref, reason: "other", text: "mine" })).status).toBe(404);
    expect((await send("/v1/account/cancel-plan/reason", { method: "GET" })).status).toBe(405);
    signedIn = null;
    expect((await post({ cancellationId: ref, reason: "other" })).status).toBe(401);
  });
  it("never puts the free text in an alert, a notice or a log line", async () => {
    const ref = await cancelled();
    const logs: string[] = [];
    for (const k of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    const secret = "my-private-reason-7731";
    expect((await send("/v1/account/cancel-plan/reason", { body: { cancellationId: ref, reason: "other", text: secret } })).status).toBe(200);
    expect((await send("/v1/account/cancel-plan/reason", { body: { cancellationId: ref, reason: "bogus", text: secret } })).status).toBe(400);
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    await sweepMonitoring(baseEnv(envOver)).catch(() => undefined);
    for (const table of ["cloud_alerts", "billing_notices", "cloud_outbox", "selfservice_audit", "topup_events"]) {
      expect(JSON.stringify((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results)).not.toContain(secret);
    }
    expect(logs.join("\n")).not.toContain(secret);
    expect(notices.map((n) => JSON.stringify(n))).not.toContain(secret);
  });
  it("keeps the feedback 13 months from the day it was written, then the billing sweep deletes it; erase removes a customer's rows at once", async () => {
    const ref = await cancelled();
    await send("/v1/account/cancel-plan/reason", { body: { cancellationId: ref, reason: "other", text: "later" } });
    const row = (await reasonOf()).results[0];
    const due = new Date(NOW); due.setUTCMonth(due.getUTCMonth() + 13);
    expect(row.expires_at).toBe(due.getTime());
    vi.mocked(Date.now).mockReturnValue(row.expires_at - 1);
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_feedback")).toBe(1);
    vi.mocked(Date.now).mockReturnValue(row.expires_at);
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_feedback")).toBe(0);
    vi.mocked(Date.now).mockReturnValue(NOW);
    await send("/v1/account/cancel-plan/reason", { body: { cancellationId: ref, reason: "other", text: "again" } });
    const { eraseCancellationFeedback } = await import("../src/journey");
    await eraseCancellationFeedback(env, OWNER);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_feedback")).toBe(0);
  });
});

describe("journey A1 (Astra JOURNEY-A-1): 13-month retention never runs past the destination month", () => {
  it("clamps to the destination month's last day and keeps the time of day", async () => {
    const { monthsLater, FEEDBACK_RETENTION_MONTHS } = await import("../src/journey");
    expect(monthsLater(Date.UTC(2025, 0, 31, 10, 20, 30, 400), FEEDBACK_RETENTION_MONTHS)).toBe(Date.UTC(2026, 1, 28, 10, 20, 30, 400));
    expect(monthsLater(Date.UTC(2027, 0, 31), 13)).toBe(Date.UTC(2028, 1, 29)); // leap year
    expect(monthsLater(Date.UTC(2025, 2, 31), 13)).toBe(Date.UTC(2026, 3, 30));
    expect(monthsLater(Date.UTC(2025, 4, 15, 8), 13)).toBe(Date.UTC(2026, 5, 15, 8));
    expect(monthsLater(Date.UTC(2025, 11, 31), 2)).toBe(Date.UTC(2026, 1, 28));
  });
});

describe("journey A2: refund request record (no money moves)", () => {
  const post = (body: unknown = {}) => send("/v1/account/refund-request", { body });
  const moneyCalls = () => stripeCalls.filter((c) => c.method === "POST" && /\/v1\/(refunds|credit_notes)/.test(c.path));
  it("records the request, emails a receipt, raises refund.requested and answers {requestId, receivedAt, eligible, deadline}", async () => {
    await paidUs(); signedIn = OWNER; notices = []; stripeCalls = []; fluxLog = [];
    const res = await post();
    expect(res.status).toBe(201);
    const body = await res.json() as { requestId: string; receivedAt: number; eligible: boolean; deadline: number };
    expect(body).toMatchObject({ receivedAt: NOW, eligible: true, alreadyRequested: false });
    const frozen = (await env.DB.prepare("SELECT refund7_until AS r FROM checkout_consents WHERE home_id='home-1'").first<{ r: number | null }>())!.r;
    expect(body.deadline).toBe(frozen ?? aoeEnd(NOW, 7));
    expect(body.requestId).toMatch(/^rr-/);
    const mail = notices.filter((n) => n.kind === "refund_request_received");
    expect(mail).toHaveLength(1);
    expect((mail[0].data as { emailText: string }).emailText).toContain(body.requestId);
    expect((mail[0].data as { emailText: string }).emailText).toContain("Nothing has been refunded yet");
    expect(await env.DB.prepare("SELECT kind,severity FROM cloud_alerts WHERE kind='refund.requested'").first()).toEqual({ kind: "refund.requested", severity: "warning" });
    // Nothing moved: no refund, no credit note, no ledger row, no claim, nothing taken back from Flux.
    expect(moneyCalls()).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(0);
    expect(fluxLog.filter((l) => l.hook === "revoke")).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions").first()).toEqual({ status: "active" });
  });
  it("is once per account per payment: a second call returns the same request, with no second email or alert", async () => {
    await paidUs(); signedIn = OWNER;
    const first = await (await post()).json() as { requestId: string };
    notices = [];
    const second = await post();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ requestId: first.requestId, alreadyRequested: true, eligible: true });
    expect(notices).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM refund_requests")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund.requested'")).toBe(1);
  });
  it("outside the 7-day window the request is still recorded and says eligible: false with the deadline", async () => {
    await paidUs(); signedIn = OWNER;
    vi.mocked(Date.now).mockReturnValue(NOW + 20 * DAY);
    const body = await (await post()).json() as { eligible: boolean; deadline: number; receivedAt: number };
    expect(body).toMatchObject({ eligible: false, receivedAt: NOW + 20 * DAY });
    expect(body.deadline).toBeLessThan(NOW + 20 * DAY);
    expect(await count("SELECT COUNT(*) AS n FROM refund_requests")).toBe(1);
  });
  it("an already-refunded customer is not eligible; a signed-out caller is 401; an account with no payment is 409", async () => {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare("INSERT INTO first_month_refunds (user_id,home_id,invoice_id,amount_cents,used_credit_cents,created_at) VALUES (?,?,?,?,0,?)")
      .bind(OWNER, "home-1", "in_1", 4900, NOW).run();
    expect(await (await post()).json()).toMatchObject({ eligible: false });
    await env.DB.prepare("DELETE FROM first_month_refunds").run();
    signedIn = null;
    expect((await post()).status).toBe(401);
    signedIn = "someone-else";
    expect((await post()).status).toBe(409);
  });
  it("a receipt that cannot be sent now is recorded and delivered by the sweep; the request stands", async () => {
    await paidUs(); signedIn = OWNER; notices = []; notifierFails = true;
    expect((await post()).status).toBe(201);
    expect(notices).toEqual([]);
    const row = await env.DB.prepare("SELECT sent_at FROM billing_notices WHERE kind='refund_request_received'").first<{ sent_at: number | null }>();
    expect(row?.sent_at ?? null).toBeNull();
    notifierFails = false;
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(notices.filter((n) => n.kind === "refund_request_received")).toHaveLength(1);
  });
});

describe("journey A2 (Astra JOURNEY-A-1): the operator executes a refund request by its id, as of its receipt time", () => {
  const request = async () => (await (await send("/v1/account/refund-request", { body: {} })).json()) as { requestId: string; eligible: boolean; deadline: number };
  const execute = (body: Record<string, unknown>, headers: Record<string, string> = admin) => send("/v1/admin/refund-first-month", { body, headers });
  it("a request received inside the window is refunded after the deadline (never window_expired); by home it would be", async () => {
    await paidUs(); signedIn = OWNER;
    const r = await request();
    expect(r.eligible).toBe(true);
    vi.mocked(Date.now).mockReturnValue(r.deadline + 3 * DAY); // the request waited for a person past the window
    expect(await (await execute({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false, reason: "window_expired" } });
    expect(await (await execute({ requestId: r.requestId, dryRun: true })).json()).toMatchObject({ quote: { eligible: true } });
    const res = await execute({ requestId: r.requestId });
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ refunded: true })]);
    expect(await count("SELECT COUNT(*) AS n FROM first_month_refunds")).toBe(1);
    expect(await env.DB.prepare("SELECT decided_at,refund_op_id FROM refund_requests").first()).toEqual({ decided_at: r.deadline + 3 * DAY, refund_op_id: `firstmonth:${OWNER}` });
    // Asked again: the same refund, never a second one (once per person stays).
    expect(await (await execute({ requestId: r.requestId })).json()).toMatchObject({ refunded: true });
    expect(stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds")).toHaveLength(1);
  });
  it("is operator-only, needs exactly one of homeId and requestId, and refuses a request whose payment is no longer the home's", async () => {
    await paidUs(); signedIn = OWNER;
    const r = await request();
    expect((await execute({ requestId: r.requestId }, {})).status).toBe(401);
    expect((await execute({ requestId: r.requestId, homeId: "home-1" })).status).toBe(400);
    expect((await execute({})).status).toBe(400);
    expect((await execute({ requestId: "rr-00000000-0000-0000-0000-000000000000" })).status).toBe(404);
    await env.DB.prepare("UPDATE billing_subscriptions SET first_invoice_id='in_replacement' WHERE home_id='home-1'").run();
    // Astra JOURNEY-A-3 #6: only a request whose payment truly cannot be found (no snapshot, and Stripe cannot show it for this home).
    await env.DB.prepare("UPDATE refund_requests SET payment_snapshot=NULL WHERE id=?").bind(r.requestId).run();
    const moved = await execute({ requestId: r.requestId });
    expect([moved.status, ((await moved.json()) as { error: string }).error]).toEqual([409, "payment_changed"]);
    expect(stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds")).toHaveLength(0);
  });
  it("keeps the abuse-closure limit: a request by id for a closed account is refused", async () => {
    await paidUs(); signedIn = OWNER;
    const r = await request();
    expect((await send("/v1/admin/abuse-closure", { body: { homeId: "home-1", evidence: "evidenced abuse for this test" }, headers: admin })).status).toBe(200);
    const res = await execute({ requestId: r.requestId, dryRun: true });
    expect(await res.json()).toMatchObject({ quote: { eligible: false, reason: "abuse_closure" } });
  });
});

describe("journey A2 (Astra JOURNEY-A-1): a later request for another payment stays visible in the ops alert", () => {
  const alerts = async () => (await env.DB.prepare("SELECT detail,resolved_at FROM cloud_alerts WHERE kind='refund.requested' ORDER BY raised_at").all<{ detail: string; resolved_at: number | null }>()).results;
  it("the one open alert lists every outstanding request id; an executed request leaves the list, the last one resolves it", async () => {
    await paidUs(); signedIn = OWNER;
    const first = await (await send("/v1/account/refund-request", { body: {} })).json() as { requestId: string };
    // The home's first payment changes (a replacement order): a request for that payment is a new request.
    await env.DB.prepare("UPDATE billing_subscriptions SET first_invoice_id='in_second' WHERE home_id='home-1'").run();
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000); // a minute later
    const second = await (await send("/v1/account/refund-request", { body: {} })).json() as { requestId: string };
    expect(second.requestId).not.toBe(first.requestId);
    let open = await alerts();
    expect(open).toHaveLength(1);
    expect(JSON.parse(open[0].detail)).toMatchObject({ requestIds: [first.requestId, second.requestId], outstanding: 2 });
    // Executing the second (the home's current payment) removes it from the list; the alert stays open for the first.
    const done = await send("/v1/admin/refund-first-month", { body: { requestId: second.requestId }, headers: admin });
    expect(done.status).toBeLessThan(500);
    open = await alerts();
    expect(JSON.parse(open[0].detail)).toMatchObject({ requestIds: [first.requestId], outstanding: 1 });
    expect(open[0].resolved_at).toBeNull();
    await env.DB.prepare("UPDATE refund_requests SET decided_at=? WHERE id=?").bind(NOW, first.requestId).run();
    const { refundAlertStatements } = await import("../src/journey");
    await env.DB.batch(refundAlertStatements(env, "home-1", NOW));
    expect((await alerts())[0].resolved_at).toBe(NOW);
  });
});

describe("journey A2 (Astra JOURNEY-A-2): a request is decided on its own payment and contract snapshot", () => {
  const request = async () => (await (await send("/v1/account/refund-request", { body: {} })).json()) as { requestId: string; eligible: boolean };
  const execute = (body: Record<string, unknown>) => send("/v1/admin/refund-first-month", { body, headers: admin });
  /** A second consent row for home-1 (a copy of the recorded one under a new id, with `over`), made the home's live consent. */
  const liveConsent = async (id: string, over: Record<string, unknown>) => {
    const row = (await env.DB.prepare("SELECT * FROM checkout_consents WHERE home_id='home-1' ORDER BY created_at DESC, rowid DESC LIMIT 1").first<Record<string, unknown>>())!;
    const copy: Record<string, unknown> = { ...row, ...over, id };
    const cols = Object.keys(copy);
    await env.DB.prepare(`INSERT INTO checkout_consents (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((c) => copy[c] ?? null)).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET consent_id=? WHERE home_id='home-1'").bind(id).run();
    return row.id as string;
  };
  it("the request's consent (c_receipt), never the live one (c_current), selects the entitlement and is pinned on the operation", async () => {
    await paidUs(); signedIn = OWNER;
    const r = await request();
    const receiptConsent = (await env.DB.prepare("SELECT consent_id FROM refund_requests WHERE id=?").bind(r.requestId).first<{ consent_id: string }>())!.consent_id;
    // The live contract now reads as an EU consumer's: with the live consent the EU/UK 14-day entitlement would be opened instead.
    expect(await liveConsent("c_current", { eu_region: 1, effective_eu_region: 1, stripe_session_id: null, stripe_subscription_id: null })).toBe(receiptConsent);
    expect(await (await execute({ requestId: r.requestId, dryRun: true })).json()).toMatchObject({ basis: "seven_day_offer" });
    const res = await execute({ requestId: r.requestId });
    expect(res.status).toBeLessThan(500);
    const ops = (await env.DB.prepare("SELECT id,detail FROM refund_ops").all<{ id: string; detail: string }>()).results;
    expect(ops.map((o) => o.id)).toEqual([`firstmonth:${OWNER}`]);
    expect(JSON.parse(ops[0].detail).consentId).toBe(receiptConsent);
    expect(await env.DB.prepare("SELECT refund_op_id FROM refund_requests WHERE id=?").bind(r.requestId).first()).toEqual({ refund_op_id: `firstmonth:${OWNER}` });
  });
  it("another payment's open operation never consumes the request: it stays outstanding and its alert stays open", async () => {
    await paidUs(); signedIn = OWNER;
    // The account's once-per-customer operation is open for an OLDER payment (in_old), still being worked.
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,detail,created_at,updated_at,next_attempt_at)
      VALUES (?,'first_month','home-1',?,'in_old',1,'{}',?,?,?)`).bind(`firstmonth:${OWNER}`, OWNER, NOW, NOW, NOW + 365 * DAY).run();
    const r = await request(); // for the current payment, in_1
    const res = await execute({ requestId: r.requestId });
    expect([res.status, await res.json()]).toEqual([202, expect.objectContaining({ outstanding: true, requestId: r.requestId, otherOperation: `firstmonth:${OWNER}` })]);
    expect(await env.DB.prepare("SELECT decided_at,refund_op_id FROM refund_requests WHERE id=?").bind(r.requestId).first()).toEqual({ decided_at: null, refund_op_id: null });
    const alert = (await env.DB.prepare("SELECT detail,resolved_at FROM cloud_alerts WHERE kind='refund.requested'").first<{ detail: string; resolved_at: number | null }>())!;
    expect(alert.resolved_at).toBeNull();
    expect(JSON.parse(alert.detail)).toMatchObject({ requestIds: [r.requestId], outstanding: 1 });
    // The other payment's operation was not advanced on this request's behalf.
    expect(await env.DB.prepare("SELECT invoice_id,decided_at FROM refund_ops").first()).toEqual({ invoice_id: "in_old", decided_at: null });
  });
});

describe("journey A2 (Astra JOURNEY-A-3): operation identity, pinned null consent, superseded payments", () => {
  const request = async () => (await (await send("/v1/account/refund-request", { body: {} })).json()) as { requestId: string; eligible: boolean };
  const execute = (body: Record<string, unknown>) => send("/v1/admin/refund-first-month", { body, headers: admin });
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  it("#4: a request behind another payment's completed zero-value operation is decided on its own (never 202 forever)", async () => {
    await paidUs(); signedIn = OWNER;
    // The account's base operation id is held by an OLDER payment's decided, zero-value refusal (the claim was released by it).
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,detail,created_at,updated_at,decided_at,done_at,amount_cents,target_cents,basis,notified_at)
      VALUES (?,'first_month','home-1',?,'in_old',1,'{}',?,?,?,?,0,0,'window_expired',?)`).bind(`firstmonth:${OWNER}`, OWNER, NOW - DAY, NOW - DAY, NOW - DAY, NOW - DAY, NOW - DAY).run();
    const r = await request();
    expect(r.eligible).toBe(true);
    const res = await execute({ requestId: r.requestId });
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ refunded: true })]);
    expect(await env.DB.prepare("SELECT refund_op_id FROM refund_requests WHERE id=?").bind(r.requestId).first())
      .toEqual({ refund_op_id: `firstmonth:${OWNER}:in_1` });
    // The other payment's operation is untouched; the once-per-customer claim is now this payment's.
    expect(await env.DB.prepare("SELECT invoice_id,amount_cents FROM refund_ops WHERE id=?").bind(`firstmonth:${OWNER}`).first()).toEqual({ invoice_id: "in_old", amount_cents: 0 });
    expect(await env.DB.prepare("SELECT invoice_id FROM first_month_refunds WHERE user_id=?").bind(OWNER).first()).toEqual({ invoice_id: "in_1" });
    // Executed again: the same operation, never a second refund.
    expect(await (await execute({ requestId: r.requestId })).json()).toMatchObject({ refunded: true });
    expect(refundPosts()).toHaveLength(1);
  });
  it("#5: a request recorded without a consent never adopts the live consent (its frozen deadline), in quoting or in the operation", async () => {
    await paidUs(); signedIn = OWNER;
    const r = await request();
    await env.DB.prepare("UPDATE refund_requests SET consent_id=NULL WHERE id=?").bind(r.requestId).run();
    // The live contract's frozen 7-day deadline passed before the receipt: adopting it would make the receipt window_expired.
    await env.DB.prepare("UPDATE checkout_consents SET refund7_until=? WHERE home_id='home-1'").bind(NOW - DAY).run();
    // Integration (B3 + Astra JOURNEY-B-1 #8): a frozen deadline never SHORTENS the window (the later of it, the payment's and the ready
    // rule), so the live window is expired only once the clock is past the payment/ready 7 days too; the receipt is still judged at NOW.
    vi.mocked(Date.now).mockReturnValue(aoeEnd(NOW, 7) + 1);
    expect(await (await execute({ homeId: "home-1", dryRun: true })).json()).toMatchObject({ quote: { eligible: false, reason: "window_expired" } });
    expect(await (await execute({ requestId: r.requestId, dryRun: true })).json()).toMatchObject({ quote: { eligible: true } });
    const res = await execute({ requestId: r.requestId });
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ refunded: true })]);
    const op = (await env.DB.prepare("SELECT detail,basis FROM refund_ops WHERE id=?").bind(`firstmonth:${OWNER}`).first<{ detail: string; basis: string }>())!;
    expect(op.basis).toBe("seven_day_offer");
    const detail = JSON.parse(op.detail) as Record<string, unknown>;
    expect("consentId" in detail).toBe(true);
    expect(detail.consentId).toBeNull();
  });
  it("#6: after a replacement checkout the original request is decided on its own payment, never touching the replacement", async () => {
    await paidUs(); signedIn = OWNER;
    const r = await request();
    const original = (await env.DB.prepare("SELECT subscription_id,first_payment_intent AS pi FROM billing_subscriptions WHERE home_id='home-1'").first<{ subscription_id: string; pi: string }>())!;
    expect(await env.DB.prepare("SELECT subscription_id FROM refund_requests WHERE id=?").bind(r.requestId).first()).toEqual({ subscription_id: original.subscription_id });
    // A replacement checkout takes the home: a new subscription and a new first payment.
    await env.DB.prepare(`UPDATE billing_subscriptions SET subscription_id='sub_replacement',first_invoice_id='in_replacement',first_payment_intent='pi_replacement',
      status='active' WHERE home_id='home-1'`).run();
    stripeCalls = []; fluxLog = [];
    await env.DB.prepare(`UPDATE credit_grants SET body_json='{"amount_microcents":49000000}' WHERE invoice_id='in_1'`).run();
    expect(await (await execute({ requestId: r.requestId, dryRun: true })).json()).toMatchObject({ quote: { eligible: true, invoiceId: "in_1" } });
    const res = await execute({ requestId: r.requestId });
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ refunded: true })]);
    const op = (await env.DB.prepare("SELECT id,invoice_id,payment_intent,subscription_id,end_plan FROM refund_ops").first())!;
    expect(op).toEqual({ id: `firstmonth:${OWNER}`, invoice_id: "in_1", payment_intent: original.pi, subscription_id: original.subscription_id, end_plan: 0 });
    expect(refundPosts().map((c) => c.form.get("payment_intent"))).toEqual([original.pi]);
    // The replacement is untouched: not cancelled at Stripe or here, and its plan never stopped at Flux. Only THIS payment's own grant is
    // taken back (Astra JOURNEY-A-4 #1), by grant.
    expect(stripeCalls.filter((c) => c.method === "DELETE" || c.path.includes("sub_replacement"))).toEqual([]);
    expect(await env.DB.prepare("SELECT subscription_id,status FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ subscription_id: "sub_replacement", status: "active" });
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
    expect(fluxLog.filter((l) => l.hook === "target").map((l) => (l.args as { invoiceId: string }).invoiceId)).toEqual(["in_1"]);
    expect(fluxLog.filter((l) => l.hook === "revoke")).toEqual([]);
  });
  it("JOURNEY-A-4 #4: an invalidated refusal reopens on its request's snapshot (explicit null consent, receipt time) under the invoice-aware op id", async () => {
    await paidUs(); signedIn = OWNER;
    const r = await request();
    const original = (await env.DB.prepare("SELECT subscription_id FROM billing_subscriptions WHERE home_id='home-1'").first<{ subscription_id: string }>())!;
    const recv = (await env.DB.prepare("SELECT received_at FROM refund_requests WHERE id=?").bind(r.requestId).first<{ received_at: number }>())!.received_at;
    await env.DB.prepare("UPDATE refund_requests SET consent_id=NULL WHERE id=?").bind(r.requestId).run();
    // Another payment's decided, zero-value refusal holds the account's base operation id.
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,detail,created_at,updated_at,decided_at,done_at,amount_cents,target_cents,basis,notified_at)
      VALUES (?,'first_month','home-1',?,'in_old',1,'{}',?,?,?,?,0,0,'window_expired',?)`).bind(`firstmonth:${OWNER}`, OWNER, NOW - DAY, NOW - DAY, NOW - DAY, NOW - DAY, NOW - DAY).run();
    // The request was refused at receipt (not_first_payment); the person it rested on was erased since (a recorded invalidation).
    await env.DB.prepare("INSERT INTO refund_refusal_receipts (invoice_id,home_id,user_id,received_at,rested_on) VALUES ('in_1','home-1',?,?,'[\"user-x\"]')").bind(OWNER, recv).run();
    await env.DB.prepare("INSERT INTO refund_refusal_invalidations (invoice_id,erased_user_id,erased_through,held,recorded_at) VALUES ('in_1','user-x',?,0,?)").bind(NOW, NOW).run();
    // A replacement then took the home: live reconstruction would refuse (payment changed) or adopt the replacement's contract.
    await env.DB.prepare(`UPDATE billing_subscriptions SET subscription_id='sub_replacement',first_invoice_id='in_replacement',first_payment_intent='pi_replacement',
      status='active' WHERE home_id='home-1'`).run();
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * DAY);
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    const op = (await env.DB.prepare("SELECT id,created_at,subscription_id,end_plan,detail FROM refund_ops WHERE invoice_id='in_1'").first<{ id: string; created_at: number;
      subscription_id: string; end_plan: number; detail: string }>())!;
    expect(op).toMatchObject({ id: `firstmonth:${OWNER}:in_1`, created_at: recv, subscription_id: original.subscription_id, end_plan: 0 });
    const detail = JSON.parse(op.detail) as Record<string, unknown>;
    expect("consentId" in detail && detail.consentId === null).toBe(true);
    expect(detail.pay).toMatchObject({ invoiceId: "in_1" });
    expect(await env.DB.prepare("SELECT op_id FROM refund_refusal_receipts WHERE invoice_id='in_1'").first()).toEqual({ op_id: `firstmonth:${OWNER}:in_1` });
    // The other payment's operation is untouched.
    expect(await env.DB.prepare("SELECT invoice_id,amount_cents FROM refund_ops WHERE id=?").bind(`firstmonth:${OWNER}`).first()).toEqual({ invoice_id: "in_old", amount_cents: 0 });
  });
  it("JOURNEY-A-4 #1: A grants, replacement B grants, A refunded in full -> A's grant reversed by grant (journaled), B's intact, no stop", async () => {
    await paidUs(); signedIn = OWNER;
    // A (in_1) was granted its credits through the real invoice.paid path.
    expect(await env.DB.prepare("SELECT invoice_id,kind,granted_at IS NOT NULL AS g FROM credit_grants").all().then((r) => r.results)).toEqual([{ invoice_id: "in_1", kind: "period", g: 1 }]);
    const r = await request();
    // A replacement checkout takes the home, and B (in_replacement) is granted its own credits.
    await env.DB.prepare(`UPDATE billing_subscriptions SET subscription_id='sub_replacement',first_invoice_id='in_replacement',first_payment_intent='pi_replacement',
      status='active' WHERE home_id='home-1'`).run();
    await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,granted_at) SELECT 'in_replacement',kind,home_id,plan,?,? FROM credit_grants WHERE invoice_id='in_1'`)
      .bind(NOW + 1, NOW + 1).run();
    await env.DB.prepare(`UPDATE credit_grants SET body_json='{"amount_microcents":49000000}' WHERE invoice_id='in_1'`).run();
    stripeCalls = []; fluxLog = [];
    // B4 is briefly down when the refund lands: the refund still completes, and the reversal is journaled for the sweep.
    revokeFails = 1;
    const res = await execute({ requestId: r.requestId });
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ refunded: true })]);
    const op = (await env.DB.prepare("SELECT id,end_plan,credits_revoked_at IS NOT NULL AS j,done_at IS NOT NULL AS d FROM refund_ops").first())!;
    expect(op).toEqual({ id: `firstmonth:${OWNER}`, end_plan: 0, j: 1, d: 1 });
    expect(await env.DB.prepare("SELECT invoice_id,kind,reason,op_id,scope,reversed_at IS NOT NULL AS done FROM credit_reversals").all().then((x) => x.results))
      .toEqual([{ invoice_id: "in_1", kind: "period", reason: "refunded", op_id: `firstmonth:${OWNER}`, scope: "target", done: 0 }]);
    expect(fluxLog.filter((l) => l.hook === "target")).toEqual([]);
    // The sweep asks B4 again: A's grant (by its grant id) gets its full target, once; B's grant, and the plan (no stop), are never touched.
    await sweepBilling(baseEnv(envOver), deps());
    expect(fluxLog.filter((l) => l.hook === "target").map((l) => l.args)).toEqual([{ homeId: "home-1", invoiceId: "in_1", kind: "period", grantId: "in_1:period", reason: "refunded",
      targetRemovedMicrocents: 49_000_000, revision: 1 }]);
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
    expect(await env.DB.prepare("SELECT invoice_id,reversed_at IS NOT NULL AS done FROM credit_reversals").all().then((x) => x.results)).toEqual([{ invoice_id: "in_1", done: 1 }]);
    expect(await count("SELECT COUNT(*) AS n FROM credit_reversals WHERE invoice_id='in_replacement'")).toBe(0);
    // The charge.refunded webhook of A's ledger refund journals nothing twice and never exits without the reversal on record.
    fluxLog = [];
    expect((await hook(stripeEvent("charge.refunded", { object: "charge", id: "ch_a", customer: "cus_test1", payment_intent: "pi_1", invoice: "in_1",
      refunded: true, amount_refunded: 4900, refunds: { data: [{ metadata: { op_id: `firstmonth:${OWNER}` } }] } }))).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM credit_reversals")).toBe(1);
    expect(fluxLog.filter((l) => l.hook === "revoke" || l.hook === "target" || l.hook === "stop")).toEqual([]);
    expect(await env.DB.prepare("SELECT subscription_id,status FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ subscription_id: "sub_replacement", status: "active" });
  });
  it("JOURNEY-A-4 #1: the charge.refunded webhook of a superseded payment's ledger refund journals and runs A's grant reversal itself", async () => {
    await paidUs(); signedIn = OWNER;
    await env.DB.prepare(`UPDATE billing_subscriptions SET subscription_id='sub_replacement',first_invoice_id='in_replacement',first_payment_intent='pi_replacement',
      status='active' WHERE home_id='home-1'`).run();
    await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,granted_at) SELECT 'in_replacement',kind,home_id,plan,?,? FROM credit_grants WHERE invoice_id='in_1'`)
      .bind(NOW + 1, NOW + 1).run();
    // A ledger operation of A's payment exists (its own checkpoint has not run yet): the webhook used to exit as ledger_refund here.
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,detail,created_at,updated_at,payment_intent)
      VALUES ('firstmonth:x','first_month','home-1',?,'in_1',0,'{}',?,?,?)`).bind(OWNER, NOW, NOW, "pi_1").run();
    invoiceSubs = { in_1: "sub_test1" };
    await env.DB.prepare(`UPDATE credit_grants SET body_json='{"amount_microcents":49000000}' WHERE invoice_id='in_1'`).run();
    // (Astra JOURNEY-A-5 #2: Stripe's listing shows the refund succeeded: only that is evidence the money was returned.)
    refundsMade.push({ id: "re_a", amount: 4900, status: "succeeded", payment_intent: "pi_1", metadata: { op_id: "firstmonth:x" } });
    stripeCalls = []; fluxLog = [];
    expect((await hook(stripeEvent("charge.refunded", { object: "charge", id: "ch_a", customer: "cus_test1", payment_intent: "pi_1", invoice: "in_1",
      refunded: true, amount_refunded: 4900, refunds: { data: [{ metadata: { op_id: "firstmonth:x" } }] } }))).status).toBe(200);
    expect(await env.DB.prepare("SELECT invoice_id,reversed_at IS NOT NULL AS done FROM credit_reversals").all().then((x) => x.results)).toEqual([{ invoice_id: "in_1", done: 1 }]);
    expect(fluxLog.filter((l) => l.hook === "target").map((l) => (l.args as { grantId: string }).grantId)).toEqual(["in_1:period"]);
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
  });
});

describe("journey A2 (Astra JOURNEY-A-5 #1-#3, A-6 #1/#4): credit follows the money actually returned, as a versioned target; refunds never end a plan by themselves", () => {
  const request = async () => (await (await send("/v1/account/refund-request", { body: {} })).json()) as { requestId: string; eligible: boolean };
  const execute = (body: Record<string, unknown>) => send("/v1/admin/refund-first-month", { body, headers: admin });
  /** A replacement checkout (B) takes the home and is granted its own credits; A's grant carries its frozen amount (49 USD of credit). */
  const replaceWithB = async () => {
    await env.DB.prepare(`UPDATE billing_subscriptions SET subscription_id='sub_replacement',first_invoice_id='in_replacement',first_payment_intent='pi_replacement',
      status='active' WHERE home_id='home-1'`).run();
    await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,granted_at) SELECT 'in_replacement',kind,home_id,plan,?,? FROM credit_grants WHERE invoice_id='in_1'`)
      .bind(NOW + 1, NOW + 1).run();
  };
  const frozenA = () => env.DB.prepare(`UPDATE credit_grants SET body_json='{"amount_microcents":49000000}' WHERE invoice_id='in_1'`).run();
  const reversals = () => env.DB.prepare(`SELECT invoice_id,scope,covered_cents AS c,paid_cents AS p,target_revision AS v,removed_microcents AS removed,
    reversed_at IS NOT NULL AS done FROM credit_reversals ORDER BY invoice_id`).all().then((x) => x.results);
  const targets = () => fluxLog.filter((l) => l.hook === "target").map((l) => l.args as Record<string, unknown>);
  const target = (removed: number, revision: number) => ({ homeId: "home-1", invoiceId: "in_1", kind: "period", grantId: "in_1:period", reason: "refunded",
    targetRemovedMicrocents: removed, revision });
  const watch = () => env.DB.prepare("SELECT covered_cents AS c,open_cents AS o,paid_cents AS p,end_plan,ended_at IS NOT NULL AS ended,checked_at FROM refund_coverage WHERE payment_intent='pi_1'").first();
  const subDeleted = () => stripeCalls.filter((c) => c.method === "DELETE" && c.path.startsWith("/v1/subscriptions/"));
  const chargeRefunded = (over: Record<string, unknown>) => hook(stripeEvent("charge.refunded", { object: "charge", id: "ch_a", customer: "cus_test1", payment_intent: "pi_1",
    invoice: "in_1", amount: 4900, refunds: { data: [] }, ...over }));

  it("#1: $40 of $49 already decided (pending) + this $9: a proportional target of A's unused grant; the full grant only once both succeeded", async () => {
    await paidUs(); signedIn = OWNER;
    const r = await request();
    await replaceWithB(); await frozenA();
    // Another refund of $40 on A's payment was decided before (the ledger counts it) and is still pending at Stripe.
    await env.DB.prepare("INSERT OR REPLACE INTO refund_invoice_ledger (invoice_id,version,decided_cents) VALUES ('in_1',1,4000)").run();
    refundsMade.push({ id: "re_40", amount: 4000, status: "pending", payment_intent: "pi_1", metadata: { op_id: "earlier-op" } });
    stripeCalls = []; fluxLog = [];
    const res = await execute({ requestId: r.requestId });
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ refunded: true })]);
    expect(await env.DB.prepare("SELECT amount_cents,end_plan FROM refund_ops WHERE id=?").bind(`firstmonth:${OWNER}`).first()).toEqual({ amount_cents: 900, end_plan: 0 });
    // $9 returned of $49: 9/49 of A's grant, never all of it; B's grant is never named.
    expect(await reversals()).toEqual([{ invoice_id: "in_1", scope: "target", c: 900, p: 4900, v: 1, removed: 9_000_000, done: 1 }]);
    expect(targets()).toEqual([target(9_000_000, 1)]);
    // Still pending later: the sweep's re-check changes nothing.
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * 3_600_000);
    fluxLog = [];
    await sweepBilling(baseEnv(envOver), deps());
    expect(targets()).toEqual([]);
    // The $40 succeeds: the payment is covered in full, and only now is A's whole grant the target (a new revision).
    refundsMade.find((x) => x.id === "re_40")!.status = "succeeded";
    vi.mocked(Date.now).mockReturnValue(NOW + 4 * 3_600_000);
    await sweepBilling(baseEnv(envOver), deps());
    expect(await reversals()).toEqual([{ invoice_id: "in_1", scope: "target", c: 4900, p: 4900, v: 2, removed: 49_000_000, done: 1 }]);
    expect(targets()).toEqual([target(49_000_000, 2)]);
    expect(fluxLog.filter((l) => l.hook === "stop" || l.hook === "revoke")).toEqual([]);
  });
  it("#2: a stale charge.refunded of a superseded payment whose refund Stripe now lists as failed journals no target", async () => {
    await paidUs(); await replaceWithB(); await frozenA();
    invoiceSubs = { in_1: "sub_test1" };
    refundsMade.push({ id: "re_x", amount: 4900, status: "failed", payment_intent: "pi_1", metadata: {} });
    fluxLog = [];
    expect((await chargeRefunded({ refunded: true, amount_refunded: 4900, refunds: { data: [{ id: "re_x", metadata: {} }] } })).status).toBe(200);
    expect(await reversals()).toEqual([]);
    expect(targets()).toEqual([]);
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
  });
  it("#2: succeeded then failed: the target follows the money returned, then a new revision of 0 restores the credit", async () => {
    await paidUs(); await replaceWithB(); await frozenA();
    invoiceSubs = { in_1: "sub_test1" };
    refundsMade.push({ id: "re_x", amount: 4900, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    fluxLog = [];
    expect((await chargeRefunded({ refunded: true, amount_refunded: 4900, refunds: { data: [{ id: "re_x", metadata: {} }] } })).status).toBe(200);
    expect(await reversals()).toEqual([{ invoice_id: "in_1", scope: "target", c: 4900, p: 4900, v: 1, removed: 49_000_000, done: 1 }]);
    expect(targets()).toEqual([target(49_000_000, 1)]);
    refundsMade.find((x) => x.id === "re_x")!.status = "failed";
    fluxLog = [];
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    expect((await hook(stripeEvent("refund.failed", { object: "refund", id: "re_x", status: "failed", payment_intent: "pi_1", amount: 4900, metadata: {} }))).status).toBe(200);
    expect(await reversals()).toEqual([{ invoice_id: "in_1", scope: "target", c: 0, p: 4900, v: 2, removed: 0, done: 1 }]);
    expect(targets()).toEqual([target(0, 2)]);
    expect(await env.DB.prepare("SELECT subscription_id,status FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ subscription_id: "sub_replacement", status: "active" });
  });
  it("#3: a refund opened while A kept the home, resumed after replacement B took over: no Stop, only A's own grant targeted, B untouched", async () => {
    await paidUs(); signedIn = OWNER;
    const r = await request();
    // Opened while A owns the home (end_plan=1); Stripe has not finished the refund yet.
    refundStatus = "pending";
    const res = await execute({ requestId: r.requestId });
    expect(res.status).toBeLessThan(500);
    expect(await env.DB.prepare("SELECT end_plan,refunded_at FROM refund_ops WHERE id=?").bind(`firstmonth:${OWNER}`).first()).toEqual({ end_plan: 1, refunded_at: null });
    // A replacement checkout takes the home meanwhile.
    await replaceWithB(); await frozenA();
    // The refund succeeds; the operation resumes.
    for (const x of refundsMade) x.status = "succeeded";
    stripeCalls = []; fluxLog = [];
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * 3_600_000);
    await sweepBilling(baseEnv(envOver), deps());
    const op = (await env.DB.prepare("SELECT end_plan,refunded_at IS NOT NULL AS paid,done_at IS NOT NULL AS done,detail FROM refund_ops WHERE id=?").bind(`firstmonth:${OWNER}`)
      .first<{ end_plan: number; paid: number; done: number; detail: string }>())!;
    expect(op).toMatchObject({ end_plan: 0, paid: 1, done: 1 });
    expect(JSON.parse(op.detail)).toMatchObject({ supersededBy: "sub_replacement" });
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
    expect(targets().map((a) => a.grantId)).toEqual(["in_1:period"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM credit_reversals WHERE invoice_id='in_replacement'").first()).toEqual({ n: 0 });
    expect(stripeCalls.filter((c) => c.path.includes("sub_replacement"))).toEqual([]);
    expect(await env.DB.prepare("SELECT subscription_id,status FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ subscription_id: "sub_replacement", status: "active" });
  });
  it("A-6 #1: a stale full-refund webhook of the RETAINED contract with only a failed refund listed cancels nothing, stops nothing; full coverage later ends it", async () => {
    await paidUs(); await frozenA();
    refundsMade.push({ id: "re_x", amount: 4900, status: "failed", payment_intent: "pi_1", metadata: {} });
    stripeCalls = []; fluxLog = [];
    expect((await chargeRefunded({ refunded: true, amount_refunded: 4900, refunds: { data: [{ id: "re_x", metadata: {} }] } })).status).toBe(200);
    expect(subDeleted()).toEqual([]);
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
    expect(await env.DB.prepare("SELECT subscription_id,status FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ subscription_id: "sub_test1", status: "active" });
    expect(notices.filter((n) => n.kind === "refunded")).toEqual([]);
    // The obligation is on record: pending coverage, alerted; no credit target (nothing was returned).
    expect(await watch()).toMatchObject({ c: 0, p: 4900, end_plan: 1, ended: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund.coverage_pending' AND resolved_at IS NULL")).toBe(1);
    expect(await reversals()).toEqual([]);
    // Stripe's listing now shows the payment returned in full: the sweep ends the plan (cancelled at Stripe, a service-only Stop) and the
    // credit follows as its own target.
    refundsMade.find((x) => x.id === "re_x")!.status = "succeeded";
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * 3_600_000);
    await sweepBilling(baseEnv(envOver), deps());
    expect(subDeleted().map((c) => c.path)).toEqual(["/v1/subscriptions/sub_test1"]);
    expect(fluxLog.filter((l) => l.hook === "stop").map((l) => l.args)).toEqual([{ homeId: "home-1", invoiceId: "in_1", keepGrants: true }]);
    expect(targets()).toEqual([target(49_000_000, 1)]);
    expect(await watch()).toMatchObject({ c: 4900, end_plan: 1, ended: 1 });
    expect(notices.filter((n) => n.kind === "refunded")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund.coverage_pending' AND resolved_at IS NULL")).toBe(0);
  });
  it("A-6 #1: a current-contract $9 refund ends the plan by its own rule, with a proportional target and a service-only Stop (never an unbounded one)", async () => {
    await paidUs(); signedIn = OWNER;
    const r = await request();
    await frozenA();
    await env.DB.prepare("INSERT OR REPLACE INTO refund_invoice_ledger (invoice_id,version,decided_cents) VALUES ('in_1',1,4000)").run();
    refundsMade.push({ id: "re_40", amount: 4000, status: "pending", payment_intent: "pi_1", metadata: { op_id: "earlier-op" } });
    stripeCalls = []; fluxLog = [];
    const res = await execute({ requestId: r.requestId });
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ refunded: true })]);
    expect(await env.DB.prepare("SELECT amount_cents,end_plan,done_at IS NOT NULL AS d FROM refund_ops WHERE id=?").bind(`firstmonth:${OWNER}`).first())
      .toEqual({ amount_cents: 900, end_plan: 1, d: 1 });
    expect(targets()).toEqual([target(9_000_000, 1)]);
    expect(fluxLog.filter((l) => l.hook === "stop").map((l) => l.args)).toEqual([{ homeId: "home-1", invoiceId: "in_1", keepGrants: true }]);
    expect(fluxLog.filter((l) => l.hook === "revoke")).toEqual([]);
  });
  it("A-6 #4: an initial external partial refund creates the journal with its target, from the payment; the plan goes on", async () => {
    await paidUs(); await frozenA();
    refundsMade.push({ id: "re_9", amount: 900, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    fluxLog = []; stripeCalls = [];
    expect((await chargeRefunded({ refunded: false, amount_refunded: 900 })).status).toBe(200);
    expect(await reversals()).toEqual([{ invoice_id: "in_1", scope: "target", c: 900, p: 4900, v: 1, removed: 9_000_000, done: 1 }]);
    expect(targets()).toEqual([target(9_000_000, 1)]);
    expect(subDeleted()).toEqual([]);
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
    expect(await watch()).toMatchObject({ c: 900, p: 4900, end_plan: 0 });
  });
  it("A-6 #4: a never-sent target whose refund fails keeps the payment watch; a later success is found from the payment; polling outlives 120 days while pending", async () => {
    await paidUs(); await frozenA();
    // Hooks whose router is not qualified yet: nothing is sent, the target waits (journaled, alerted).
    const unqualified: BillingDependencies = { ...deps(), flux: { ...deps().flux!, capabilities: {} } };
    const hookWith = async (event: unknown, d: BillingDependencies) => {
      const raw = JSON.stringify(event);
      return send("/v1/billing/webhook", { raw, headers: { "stripe-signature": await signStripePayload(raw, WHSEC, Math.floor(Date.now() / 1000)) } }, d);
    };
    refundsMade.push({ id: "re_9", amount: 900, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    fluxLog = [];
    expect((await hookWith(stripeEvent("charge.refunded", { object: "charge", id: "ch_a", customer: "cus_test1", payment_intent: "pi_1", invoice: "in_1", amount: 4900,
      refunded: false, amount_refunded: 900, refunds: { data: [] } }), unqualified)).status).toBe(200);
    expect(await reversals()).toEqual([{ invoice_id: "in_1", scope: "target", c: 900, p: 4900, v: 1, removed: null, done: 0 }]);
    expect(await env.DB.prepare("SELECT last_error AS e FROM credit_reversals").first()).toEqual({ e: "pending_capability" });
    expect(targets()).toEqual([]);
    // The refund fails: never sent, so it settles here with nothing removed. The row and the payment's watch both stay.
    refundsMade[0].status = "failed";
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * 3_600_000);
    await sweepBilling(baseEnv(envOver), unqualified);
    expect(await reversals()).toEqual([{ invoice_id: "in_1", scope: "target", c: 0, p: 4900, v: 2, removed: 0, done: 1 }]);
    expect(await watch()).toMatchObject({ c: 0, p: 4900 });
    // A new refund of the payment succeeds: a new revision of the target, found from the payment (the sweep re-reads it).
    refundsMade.push({ id: "re_9b", amount: 900, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    vi.mocked(Date.now).mockReturnValue(NOW + 4 * 3_600_000);
    await sweepBilling(baseEnv(envOver), unqualified);
    expect(await reversals()).toEqual([{ invoice_id: "in_1", scope: "target", c: 900, p: 4900, v: 3, removed: 0, done: 0 }]);
    // Polling never stops while that work is pending: 200 days on, the payment is still re-read.
    const later = NOW + 200 * DAY;
    vi.mocked(Date.now).mockReturnValue(later);
    await sweepBilling(baseEnv(envOver), unqualified);
    expect(await watch()).toMatchObject({ checked_at: later });
    // A qualified router after cutover: the latest revision is sent, and applied.
    vi.mocked(Date.now).mockReturnValue(later + 2 * 3_600_000);
    await sweepBilling(baseEnv(envOver), deps());
    expect(targets()).toEqual([target(9_000_000, 3)]);
    expect(await reversals()).toEqual([{ invoice_id: "in_1", scope: "target", c: 900, p: 4900, v: 3, removed: 9_000_000, done: 1 }]);
  });
  /** A first-month refusal of the retained contract's payment, completed with nothing refunded (it ended nothing). */
  const refusal = () => env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,payment_intent,subscription_id,end_plan,amount_cents,decided_at,done_at,detail,
    created_at,updated_at) VALUES ('firstmonth:refused','first_month','home-1',?,'in_1','pi_1','sub_test1',1,0,?,?,'{}',?,?)`).bind(OWNER, NOW, NOW, NOW, NOW).run();
  it("A-7 #2: a completed zero-value first-month refusal never discharges a later verified full external repayment: cancelled, Stop, notice", async () => {
    await paidUs(); await frozenA(); await refusal();
    refundsMade.push({ id: "re_x", amount: 4900, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    stripeCalls = []; fluxLog = []; notices = [];
    expect((await chargeRefunded({ refunded: true, amount_refunded: 4900, refunds: { data: [{ id: "re_x", metadata: {} }] } })).status).toBe(200);
    expect(subDeleted().map((c) => c.path)).toEqual(["/v1/subscriptions/sub_test1"]);
    expect(fluxLog.filter((l) => l.hook === "stop").map((l) => l.args)).toEqual([{ homeId: "home-1", invoiceId: "in_1", keepGrants: true }]);
    expect(notices.filter((n) => n.kind === "refunded")).toHaveLength(1);
    expect(await watch()).toMatchObject({ c: 4900, end_plan: 1, ended: 1 });
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ status: "canceled" });
  });
  it("A-7 #2: a ledger operation that may still end the plan defers the obligation; once it ends the plan itself the obligation is discharged once", async () => {
    await paidUs(); await frozenA(); await refusal();
    // Undecided yet, and ending this subscription when it completes: the external repayment waits for it (no double cancellation).
    await env.DB.prepare("UPDATE refund_ops SET decided_at=NULL,done_at=NULL,amount_cents=NULL,next_attempt_at=? WHERE id='firstmonth:refused'").bind(NOW + 365 * DAY).run();
    refundsMade.push({ id: "re_x", amount: 4900, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    stripeCalls = []; fluxLog = [];
    expect((await chargeRefunded({ refunded: true, amount_refunded: 4900, refunds: { data: [{ id: "re_x", metadata: {} }] } })).status).toBe(200);
    expect(subDeleted()).toEqual([]);
    expect(await watch()).toMatchObject({ end_plan: 1, ended: 0 });
    // The operation cancels this subscription itself: the obligation is released, nothing is cancelled or stopped twice.
    await env.DB.prepare("UPDATE refund_ops SET canceled_at=? WHERE id='firstmonth:refused'").bind(NOW + 60_000).run();
    // INTEGRATED-2 RULE A: its cancelConfirmed recorded Stripe's end (THE checkpoint); canceled_at alone never discharges the watch.
    await env.DB.prepare("UPDATE billing_subscriptions SET stripe_end_confirmed=subscription_id WHERE subscription_id='sub_test1'").run();
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * 3_600_000);
    await sweepBilling(baseEnv(envOver), deps());
    expect(subDeleted()).toEqual([]);
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
    expect(await watch()).toMatchObject({ end_plan: 0, ended: 0 });
  });
  it("A-7 #5: an unfinished service end (pending coverage, only failed refunds) is polled past 120 days; the tail starts only once everything settled", async () => {
    await paidUs(); await frozenA();
    refundsMade.push({ id: "re_x", amount: 4900, status: "failed", payment_intent: "pi_1", metadata: {} });
    expect((await chargeRefunded({ refunded: true, amount_refunded: 4900, refunds: { data: [{ id: "re_x", metadata: {} }] } })).status).toBe(200);
    expect(await watch()).toMatchObject({ c: 0, end_plan: 1, ended: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM credit_reversals")).toBe(0);
    // 200 days on, nothing else pending on the payment: the unfinished service end alone keeps it polled.
    const later = NOW + 200 * DAY;
    vi.mocked(Date.now).mockReturnValue(later);
    await sweepBilling(baseEnv(envOver), deps());
    expect(await watch()).toMatchObject({ checked_at: later, ended: 0 });
    // The refund is retried and succeeds: the plan ends now, not lost to the tail.
    refundsMade.push({ id: "re_y", amount: 4900, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    stripeCalls = []; fluxLog = [];
    vi.mocked(Date.now).mockReturnValue(later + 2 * 3_600_000);
    await sweepBilling(baseEnv(envOver), deps());
    expect(subDeleted().map((c) => c.path)).toEqual(["/v1/subscriptions/sub_test1"]);
    expect(await watch()).toMatchObject({ c: 4900, ended: 1 });
    // Everything settled: the payment is re-read only within the tail after its last change, then no more.
    const after = later + 2 * 3_600_000 + 121 * DAY;
    vi.mocked(Date.now).mockReturnValue(after);
    await sweepBilling(baseEnv(envOver), deps());
    expect((await watch())!.checked_at).toBe(later + 2 * 3_600_000);
  });
  it("Astra TAXCOUNTRY-7 P1-b: paid-replacement dispute: A's charge disputed after B took the home: B keeps serving; only A's payment is recorded and its reimbursement held", async () => {
    await paidUs(); signedIn = OWNER;
    const r = await request();
    await replaceWithB(); await frozenA();
    stripeCalls = []; fluxLog = [];
    const before = notices.length;
    const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_old_a", charge: "ch_1", reason: "fraudulent" });
    expect((await hook(ev)).status).toBe(200);
    expect(await env.DB.prepare("SELECT error FROM stripe_events WHERE id=?").bind(ev.id).first()).toEqual({ error: "historical_dispute_recorded" });
    // B: untouched (active, never stopped, never ended at Stripe, no dispute notice); the home's entitlement unchanged.
    expect(await env.DB.prepare("SELECT subscription_id,status FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ subscription_id: "sub_replacement", status: "active" });
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
    expect(subDeleted()).toEqual([]);
    expect(notices.slice(before).filter((n) => n.kind === "dispute_opened")).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id=?", ev.id)).toBe(0);
    expect((await getHome()).entitlement).toBe("paid");
    // A: the dispute is on A's contract and payment, and ops is told.
    expect(await env.DB.prepare("SELECT scope,subscription_id AS s,payment_intent AS p,invoice_id AS i,closed_at FROM payment_disputes").first())
      .toEqual({ scope: "historical", s: "sub_test1", p: "pi_1", i: "in_1", closed_at: null });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='dispute.historical_payment'")).toBe(1);
    // A's own reimbursement (the first-month refund requested before) is HELD while the dispute is open: no refund is submitted.
    const res = await execute({ requestId: r.requestId });
    expect(res.status).toBeLessThan(500);
    expect(stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds")).toEqual([]);
    expect(await env.DB.prepare("SELECT last_error FROM refund_ops WHERE payment_intent='pi_1'").first()).toEqual({ last_error: "payment_disputed" });
  });

  it("Astra TAXCOUNTRY-8 P1-5 (round 9b): month two paid, month one disputed: month two keeps serving; nothing is cancelled, stopped or ended; ops is told", async () => {
    await paidUs();
    const monthTwo = invoice({ id: "in_2", billing_reason: "subscription_cycle", payment_intent: "pi_2",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 } }] } });
    expect((await hook(stripeEvent("invoice.paid", monthTwo))).status).toBe(200);
    expect(await env.DB.prepare("SELECT subscription_id AS s FROM credit_grants WHERE invoice_id='in_2' AND kind='period'").first()).toEqual({ s: "sub_test1" });
    stripeCalls = []; fluxLog = [];
    const before = notices.length;
    const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_m1", charge: "ch_1", reason: "fraudulent" });
    expect((await hook(ev)).status).toBe(200);
    expect(await env.DB.prepare("SELECT error FROM stripe_events WHERE id=?").bind(ev.id).first()).toEqual({ error: "earlier_period_dispute_recorded" });
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ status: "active" });
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
    expect(stripeCalls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(notices.slice(before).filter((n) => n.kind === "dispute_opened")).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id=?", ev.id)).toBe(0);
    expect(await env.DB.prepare("SELECT scope,invoice_id AS i,closed_at FROM payment_disputes WHERE dispute_id='dp_m1'").first()).toEqual({ scope: "current", i: "in_1", closed_at: null });
    expect(await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='dispute.earlier_period'").first<{ detail: string }>().then((r) => JSON.parse(r!.detail)))
      .toMatchObject({ disputeId: "dp_m1", invoiceId: "in_1", paidLaterInvoice: "in_2" });
  });
  it("round 9b: the disputed payment IS the current period's: service ends and is held (keepGrants), the subscription ends; no credit is reversed while the bank decides", async () => {
    await paidUs();
    stripeCalls = []; fluxLog = [];
    expect((await hook(stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_cur", charge: "ch_1", reason: "fraudulent" }))).status).toBe(200);
    expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([{ hook: "stop", args: { homeId: "home-1", invoiceId: "in_1", keepGrants: true, line: "sub_test1" } }]);
    expect(fluxLog.filter((l) => l.hook === "revoke" || l.hook === "target")).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ status: "disputed" });
    expect(stripeCalls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v1/subscriptions/sub_test1"]);
  });

  describe("round 8b: THE DISPUTE CLOSURE (charge.dispute.closed / funds_withdrawn / funds_reinstated)", () => {
    const disputeObj = (id: string, status: string, txns: Record<string, unknown>[] = [], amount = 4900) =>
      ({ object: "dispute", id, charge: "ch_1", status, amount, currency: "usd", reason: "fraudulent", balance_transactions: txns });
    const withdrawn = (id: string, cents: number) => ({ id, amount: -cents, fee: 1500, currency: "usd", reporting_category: "dispute" });
    const reinstated = (id: string, cents: number) => ({ id, amount: cents, fee: 0, currency: "usd", reporting_category: "dispute_reversal" });
    /** Stripe's current dispute (what every settling event reads), then an event of `type` carrying `payload` (possibly stale). */
    const disputeEvent = (type: string, current: Record<string, unknown>, payload: Record<string, unknown> = current) => {
      retrievable[`/v1/disputes/${current.id as string}`] = current;
      return stripeEvent(type, payload);
    };
    const row = (id: string) => env.DB.prepare(`SELECT closed_at IS NOT NULL AS closed,outcome,status,amount_cents AS amount,withdrawn_cents AS w,reinstated_cents AS r,
      returned_cents AS returned FROM payment_disputes WHERE dispute_id=?`).bind(id).first();
    const errorOf = async (ev: { id: string }) => (await env.DB.prepare("SELECT error FROM stripe_events WHERE id=?").bind(ev.id).first<{ error: string | null }>())?.error;
    const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds").map((c) => Number(c.form.get("amount")));
    /** A's reimbursement asked for before the dispute (decided at 4900, then held by the open dispute). */
    const heldRefund = async (disputeId: string) => {
      await paidUs(); signedIn = OWNER;
      const r = await request();
      await replaceWithB(); await frozenA();
      expect((await hook(disputeEvent("charge.dispute.created", disputeObj(disputeId, "needs_response", [withdrawn(`txn_${disputeId}_w`, 4900)])))).status).toBe(200);
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      expect(refundPosts()).toEqual([]);
      expect(await env.DB.prepare("SELECT amount_cents,last_error FROM refund_ops WHERE payment_intent='pi_1'").first()).toEqual({ amount_cents: 4900, last_error: "payment_disputed" });
    };
    let later = NOW;
    const advance = async () => {
      await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=0").run();
      later += 2 * 3_600_000; vi.mocked(Date.now).mockReturnValue(later);
      await sweepBilling(baseEnv(envOver), deps());
    };
    beforeEach(() => { later = NOW; });

    /** INTEGRATED-11: one hold per event; the charge's latest. */
    const holdRow = (charge: string) => env.DB.prepare(`SELECT dispute_id,payment_intent,home_id,attributed_at IS NOT NULL AS attributed,paged_at IS NOT NULL AS paged FROM dispute_holds
      WHERE charge_id=? ORDER BY held_at DESC,rowid DESC LIMIT 1`).bind(charge).first();
    const lastError = async () => (await env.DB.prepare("SELECT last_error FROM refund_ops WHERE payment_intent='pi_1'").first<{ last_error: string | null }>())?.last_error;
    /** A's reimbursement asked for, before any dispute. */
    const asked = async () => { await paidUs(); signedIn = OWNER; const r = await request(); await replaceWithB(); await frozenA(); return r; };

    it("INTEGRATED-10 dispute hold first: the hold is written from the event before any lookup; a refund racing it on the same charge is refused; attribution failing keeps the hold (5xx), pages after 15 minutes, and every retry attributes again", async () => {
      const r = await asked();
      chargeFails = 1000; // the charge's customer cannot be looked up: the home is never attributed while this lasts
      const ev = disputeEvent("charge.dispute.created", { ...disputeObj("dp_hf1", "needs_response"), payment_intent: "pi_1" });
      expect((await hook(ev)).status).toBe(500);
      expect(await holdRow("ch_1")).toEqual({ dispute_id: "dp_hf1", payment_intent: "pi_1", home_id: null, attributed: 0, paged: 0 });
      expect(await count("SELECT COUNT(*) AS n FROM payment_disputes WHERE dispute_id='dp_hf1'")).toBe(0); // the dispute row is not there yet
      stripeCalls = [];
      await execute({ requestId: r.requestId }); // the refund admission racing the dispute
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      // More than 15 minutes later, still unattributed: paged once (selected by the hold, not by a home). The sweep's retry of the event
      // fails again (the lookup is still down): the sweep reports itself incomplete, which is expected here.
      await advance().catch((e) => expect(String(e)).toMatch(/billing_sweep_incomplete/));
      expect(refundPosts()).toEqual([]);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='dispute.hold_unattributed' AND subject=? AND resolved_at IS NULL", ev.id)).toBe(1);
      expect(await holdRow("ch_1")).toMatchObject({ attributed: 0, paged: 1 });
      await advance().catch((e) => expect(String(e)).toMatch(/billing_sweep_incomplete/));
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='dispute.hold_unattributed'")).toBe(1);
      // Stripe's retry attributes it: the dispute row now decides (open: still held), the page resolves.
      chargeFails = 0;
      expect((await hook(ev)).status).toBe(200);
      expect(await holdRow("ch_1")).toMatchObject({ home_id: "home-1", attributed: 1 });
      await advance();
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='dispute.hold_unattributed' AND resolved_at IS NULL")).toBe(0);
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_disputed");
      // WON: the refund is paid once; a late redelivery of the creation event changes nothing.
      expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_hf1", "won")))).status).toBe(200);
      await advance();
      expect(refundPosts()).toEqual([4900]);
      expect((await hook(ev)).status).toBe(200);
      await advance();
      expect(refundPosts()).toEqual([4900]);
    });

    it("INTEGRATED-10 open dispute polled to closure: the closure webhook is lost; past the 72h retry window the sweep reads the dispute and closes it through the same path; the held refund is paid once; a late webhook changes nothing", async () => {
      await heldRefund("dp_poll");
      retrievable["/v1/disputes/dp_poll"] = disputeObj("dp_poll", "won", [withdrawn("txn_dp_poll_w", 4900), reinstated("txn_dp_poll_r", 4900)]);
      await advance(); // inside the window: not polled, still held
      expect(await row("dp_poll")).toMatchObject({ closed: 0 });
      expect(refundPosts()).toEqual([]);
      later = NOW + 73 * 3_600_000;
      await advance(); // polled: closed WON through settleDispute
      expect(await row("dp_poll")).toEqual({ closed: 1, outcome: "won", status: "won", amount: 4900, w: 4900, r: 4900, returned: 0 });
      expect(await count("SELECT COUNT(*) AS n FROM payment_dispute_events WHERE dispute_id='dp_poll' AND event_id LIKE 'poll:%'")).toBe(1);
      await advance();
      expect(refundPosts()).toEqual([4900]);
      const late = disputeEvent("charge.dispute.closed", disputeObj("dp_poll", "won", [withdrawn("txn_dp_poll_w", 4900), reinstated("txn_dp_poll_r", 4900)]));
      expect((await hook(late)).status).toBe(200);
      await advance(); await advance();
      expect(refundPosts()).toEqual([4900]);
      expect(await row("dp_poll")).toMatchObject({ w: 4900, r: 4900, returned: 0 });
    });

    it("INTEGRATED-10 dispute hold renew: a NEW event of a settled dispute renews the hold until it is applied; a redelivered applied event never does", async () => {
      await heldRefund("dp_rn");
      const won = disputeEvent("charge.dispute.closed", disputeObj("dp_rn", "won", [withdrawn("txn_dp_rn_w", 4900), reinstated("txn_dp_rn_r", 4900)]));
      expect((await hook(won)).status).toBe(200);
      const { holdDisputeFirst } = await import("../src/b5-billing");
      // A new funds movement arrives (its processing has not run yet): the refund the won closure released is held again.
      const moved = disputeEvent("charge.dispute.funds_withdrawn", disputeObj("dp_rn", "won", [withdrawn("txn_dp_rn_w", 4900), reinstated("txn_dp_rn_r", 4900)]));
      await holdDisputeFirst(baseEnv(envOver), moved as never, NOW);
      expect(await holdRow("ch_1")).toMatchObject({ attributed: 0 });
      await advance();
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      expect((await hook(moved)).status).toBe(200); // applied: attributed, the dispute row decides again (won: released)
      expect(await holdRow("ch_1")).toMatchObject({ attributed: 1 });
      await holdDisputeFirst(baseEnv(envOver), won as never, NOW); // a redelivery of an event already applied
      expect(await holdRow("ch_1")).toMatchObject({ attributed: 1 });
      await advance();
      expect(refundPosts()).toEqual([4900]);
      await advance();
      expect(refundPosts()).toEqual([4900]);
    });

    it("INTEGRATED-10 dispute hold per-charge scope: a hold on ANOTHER charge of the customer never holds this payment's refund", async () => {
      const r = await asked();
      const { holdDisputeFirst } = await import("../src/b5-billing");
      // INTEGRATED-12: its invoice is attributed (another invoice): a hold whose invoice is unknown would hold every refund it could belong to.
      await holdDisputeFirst(baseEnv(envOver), stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_other", charge: "ch_other", payment_intent: "pi_other", amount: 4900 }) as never, NOW,
        { charge: async () => { throw new Error("not_called"); }, invoiceOfPayment: async () => "in_other" });
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      await advance();
      expect(refundPosts()).toEqual([4900]);
      expect(await holdRow("ch_other")).toMatchObject({ attributed: 0 });
    });

    // ── Astra INTEGRATED-11 (reachable with Flux off). Prepaid funds and spent credit are never read or written here: no Flux hook is a
    // revoke or target, and no router exists on this path (Flux is off for every caller).
    const holdsOf = (charge: string) => env.DB.prepare(`SELECT event_id AS e,payment_intent AS pi,invoice_id AS inv,customer_id AS cus,attributed_at IS NOT NULL AS released
      FROM dispute_holds WHERE charge_id=? ORDER BY held_at,rowid`).bind(charge).all<Record<string, unknown>>().then((x) => x.results);
    /** Spent credit is never read for money (usedMicrocents stays as the test set it: 0) and no credit is revoked on a hold's account. */
    const noCreditTouched = () => { expect(usedMicrocents).toBe(0); expect(fluxLog.filter((l) => l.hook === "revoke")).toEqual([]); };

    it("INTEGRATED-11 renewed hold is released only by its own committed checkpoint: a failing Stripe retrieval keeps it, a retry keeps it, the committed settlement releases it; two overlapping events hold until both are checkpointed", async () => {
      await heldRefund("dp_r11");
      const wonObj = disputeObj("dp_r11", "won", [withdrawn("txn_dp_r11_w", 4900), reinstated("txn_dp_r11_r", 4900)]);
      expect((await hook(disputeEvent("charge.dispute.closed", wonObj))).status).toBe(200); // resolved: WON
      fluxLog = [];
      // A NEW movement arrives; the dispute row is recorded but Stripe's dispute cannot be read (the settlement fails).
      delete retrievable["/v1/disputes/dp_r11"];
      const moved = stripeEvent("charge.dispute.funds_withdrawn", { ...wonObj, payment_intent: "pi_1" });
      expect((await hook(moved)).status).toBe(500);
      expect((await holdsOf("ch_1")).at(-1)).toMatchObject({ e: moved.id, pi: "pi_1", released: 0 });
      stripeCalls = [];
      // The sweep retries the event (the retrieval still fails: the sweep reports itself incomplete, expected here) and the refund.
      await advance().catch((e) => expect(String(e)).toMatch(/billing_sweep_incomplete/));
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      expect((await hook(moved)).status).toBe(500); // Stripe's retry: still held
      await advance().catch((e) => expect(String(e)).toMatch(/billing_sweep_incomplete/));
      expect(refundPosts()).toEqual([]);
      expect((await holdsOf("ch_1")).at(-1)).toMatchObject({ e: moved.id, released: 0 });
      // The retrieval works again: the event's settlement commits with its checkpoint, which releases its hold.
      retrievable["/v1/disputes/dp_r11"] = wonObj;
      expect((await hook(moved)).status).toBe(200);
      expect((await holdsOf("ch_1")).at(-1)).toMatchObject({ e: moved.id, released: 1 });
      // Two overlapping events: each holds until ITS checkpoint commits.
      const { holdDisputeFirst } = await import("../src/b5-billing");
      const e1 = stripeEvent("charge.dispute.funds_withdrawn", { ...wonObj, payment_intent: "pi_1" });
      const e2 = stripeEvent("charge.dispute.funds_reinstated", { ...wonObj, payment_intent: "pi_1" });
      expect(await holdDisputeFirst(baseEnv(envOver), e1 as never, NOW)).toBe(true);
      expect(await holdDisputeFirst(baseEnv(envOver), e2 as never, NOW)).toBe(true);
      expect((await hook(e2)).status).toBe(200); // e2 applied: e1 still holds
      await advance();
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      expect((await hook(e1)).status).toBe(200);
      expect((await holdsOf("ch_1")).every((h) => h.released === 1)).toBe(true);
      await advance();
      expect(refundPosts()).toEqual([4900]); // WON: paid once
      await advance();
      expect(refundPosts()).toEqual([4900]);
      noCreditTouched();
    });

    it("INTEGRATED-11 a hold is always scoped: an event naming no payment intent holds only its payment's invoice; another customer's refund is never held; charge.dispute.updated arms nothing; an unmatched charge pages with no hold", async () => {
      const r = await asked();
      const { holdDisputeFirst } = await import("../src/b5-billing");
      const { disputeHeldFirst } = await import("../src/legal-refunds");
      const e = baseEnv(envOver);
      // NULL intent: the charge is resolved first (Stripe's charge: pi_1 on in_1); the hold is scoped to that payment and invoice only.
      const nullPi = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_np", charge: "ch_np", status: "needs_response", amount: 4900, currency: "usd" });
      expect(await holdDisputeFirst(e, nullPi as never, NOW, { charge: async () => ({ customer: "cus_test1", invoice: "in_1", payment_intent: "pi_1" }), invoiceOfPayment: async () => "in_1" })).toBe(true);
      expect(await holdsOf("ch_np")).toEqual([{ e: nullPi.id, pi: "pi_1", inv: "in_1", cus: null, released: 0 }]);
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_1" })).toBe(true);
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_b", invoiceId: "in_1" })).toBe(true); // another charge of the same invoice
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_zz", invoiceId: "in_zz", homeId: "home-zz" })).toBe(false); // another customer's
      // Never a hold with no scope (the database refuses one).
      await expect(env.DB.prepare("INSERT INTO dispute_holds (event_id,charge_id,dispute_id,event_type,held_at) VALUES ('evt_x','ch_x','dp_x','charge.dispute.created',1)").run())
        .rejects.toThrow(/CHECK/);
      // A charge with no payment and no invoice but a customer of ours: held for that customer only.
      const custOnly = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_co", charge: "ch_co", status: "needs_response" });
      expect(await holdDisputeFirst(e, custOnly as never, NOW, { charge: async () => ({ customer: "cus_test1", invoice: null, payment_intent: null }), invoiceOfPayment: async () => null })).toBe(true);
      expect(await disputeHeldFirst(e, { homeId: "home-1" })).toBe(true);
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_zz", homeId: "home-zz" })).toBe(false);
      // Unmatched: a charge of nobody of ours. Recorded (the stored event) and paged at once; nothing held. INTEGRATED-12: its pending row
      // (written before the lookup) is released by the system with what Stripe answered.
      const foreign = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_fx", charge: "ch_fx", status: "needs_response" });
      expect(await holdDisputeFirst(e, foreign as never, NOW, { charge: async () => ({ customer: "cus_foreign", invoice: null, payment_intent: null }), invoiceOfPayment: async () => null })).toBe(false);
      expect(await holdsOf("ch_fx")).toEqual([{ e: foreign.id, pi: null, inv: null, cus: null, released: 1 }]);
      expect(await env.DB.prepare("SELECT closed_by,close_evidence LIKE '%cus_foreign%' AS ev FROM dispute_holds WHERE event_id=?").bind(foreign.id).first())
        .toEqual({ closed_by: "system:unmatched", ev: 1 });
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_zz", invoiceId: "in_zz", homeId: "home-zz" })).toBe(false);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='dispute.unmatched' AND subject=? AND resolved_at IS NULL", foreign.id)).toBe(1);
      // charge.dispute.updated arms no hold (it has no handler and moves no money): checkpointed as ignored, nothing left behind.
      const updated = stripeEvent("charge.dispute.updated", { object: "dispute", id: "dp_up", charge: "ch_1", payment_intent: "pi_1", status: "under_review" });
      expect((await hook(updated)).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM dispute_holds WHERE event_id=?", updated.id)).toBe(0);
      expect(await env.DB.prepare("SELECT error FROM stripe_events WHERE id=?").bind(updated.id).first()).toEqual({ error: "ignored_type" });
      // The operator's evidenced close releases the two direct holds (their events will never be applied here); the refund then proceeds.
      for (const ev of [nullPi, custOnly]) {
        expect((await send(`/v1/admin/dispute-holds/${ev.id}/close`, { body: { by: "ops-sean", evidence: "Stripe dashboard: dispute withdrawn by the bank" }, headers: admin })).status).toBe(200);
      }
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      await advance();
      expect(refundPosts()).toEqual([4900]);
      noCreditTouched();
    });

    it("INTEGRATED-11 evidenced terminal recovery: an unattributable hold pages naming the close endpoint; the operator's close (with evidence) releases it once, a redelivery never re-arms it", async () => {
      const r = await asked();
      chargeFails = 1000; // the dispute's home can never be resolved
      const ev = disputeEvent("charge.dispute.created", { ...disputeObj("dp_tr", "needs_response"), payment_intent: "pi_1" });
      expect((await hook(ev)).status).toBe(500);
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      await advance().catch((e) => expect(String(e)).toMatch(/billing_sweep_incomplete/));
      const page = await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='dispute.hold_unattributed' AND subject=? AND resolved_at IS NULL").bind(ev.id).first<{ detail: string }>();
      expect(JSON.parse(page!.detail)).toMatchObject({ eventId: ev.id, paymentIntent: "pi_1", action: expect.stringContaining(`/v1/admin/dispute-holds/${ev.id}/close`) });
      expect((await send(`/v1/admin/dispute-holds/${ev.id}/close`, { body: { by: "ops-sean", evidence: "short" }, headers: admin })).status).toBe(400);
      expect((await send(`/v1/admin/dispute-holds/${ev.id}/close`, { body: { by: "ops-sean", evidence: "x".repeat(20) } })).status).toBe(401);
      expect((await send("/v1/admin/dispute-holds/evt_unknown/close", { body: { by: "ops-sean", evidence: "Stripe dashboard: nothing" }, headers: admin })).status).toBe(404);
      const closed = await send(`/v1/admin/dispute-holds/${ev.id}/close`, { body: { by: "ops-sean", evidence: "Stripe: dispute dp_tr is on a charge of another account" }, headers: admin });
      expect(closed.status).toBe(200);
      expect((await send(`/v1/admin/dispute-holds/${ev.id}/close`, { body: { by: "ops-sean", evidence: "Stripe: dispute dp_tr again" }, headers: admin })).status).toBe(409);
      expect(await env.DB.prepare("SELECT closed_by,close_evidence IS NOT NULL AS ev,attributed_at IS NOT NULL AS released FROM dispute_holds WHERE event_id=?").bind(ev.id).first())
        .toEqual({ closed_by: "ops-sean", ev: 1, released: 1 });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='dispute.hold_unattributed' AND resolved_at IS NULL")).toBe(0);
      expect((await hook(ev)).status).toBe(500); // redelivered (still unattributable): never re-armed
      expect((await holdsOf("ch_1")).at(-1)).toMatchObject({ e: ev.id, released: 1 });
      chargeFails = 0;
      await advance();
      expect(refundPosts()).toEqual([]); // the event then applied: the OPEN dispute row now holds the payment, as before
      expect(await lastError()).toBe("payment_disputed");
      noCreditTouched();
    });

    it("INTEGRATED-11 the frozen invoice-wide cap: an open dispute on charge A of the invoice holds charge B's refund; A WON admits B in full; cancelling during the hold is recorded, never gated", async () => {
      const r = await asked();
      await env.DB.prepare(`INSERT INTO payment_disputes (dispute_id,home_id,charge_id,payment_intent,invoice_id,subscription_id,scope,opened_at,amount_cents,currency,status,updated_at)
        VALUES ('dp_a','home-1','ch_A','pi_A','in_1','sub_test1','current',?,3000,'usd','needs_response',?)`).bind(NOW, NOW).run();
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      await advance();
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_disputed");
      // Cancelling is never gated by the hold: recorded and acknowledged.
      const cancelled = await send("/v1/account/cancel-plan", { body: {} });
      expect([200, 202]).toContain(cancelled.status);
      expect(await count("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE home_id='home-1' AND cancel_intent_rev>0")).toBe(1);
      await env.DB.prepare("UPDATE payment_disputes SET closed_at=?,outcome='won',status='won',returned_cents=0 WHERE dispute_id='dp_a'").bind(NOW + 1).run();
      await advance();
      expect(refundPosts()).toEqual([4900]);
      noCreditTouched();
    });

    it("INTEGRATED-11 the frozen invoice-wide cap: charge A's dispute closes LOST while charge B's refund was held: B is lowered so B + A's returned money never exceed the invoice", async () => {
      const r = await asked();
      await env.DB.prepare(`INSERT INTO payment_disputes (dispute_id,home_id,charge_id,payment_intent,invoice_id,subscription_id,scope,opened_at,amount_cents,currency,status,updated_at)
        VALUES ('dp_al','home-1','ch_A','pi_A','in_1','sub_test1','current',?,3000,'usd','needs_response',?)`).bind(NOW, NOW).run();
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      await advance();
      expect(refundPosts()).toEqual([]);
      await env.DB.prepare("UPDATE payment_disputes SET closed_at=?,outcome='lost',status='lost',returned_cents=3000,withdrawn_cents=3000 WHERE dispute_id='dp_al'").bind(NOW + 1).run();
      await advance(); await advance();
      expect(refundPosts()).toEqual([1900]);
      expect(await count("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refund_ops WHERE invoice_id='in_1' AND decided_at IS NOT NULL")).toBe(1900);
      noCreditTouched();
    });

    // ── Astra INTEGRATED-12 (reachable with Flux off). Prepaid funds and spent credit are never read or written here (noCreditTouched); no
    // Flux hook revokes or targets anything and no router exists on this path (Flux is off for every caller).
    /** A sweep that leaves every refund's own retry time as it is (advance() makes them all due). */
    const sweepOnly = async (ms = 60_000) => { later += ms; vi.mocked(Date.now).mockReturnValue(later); await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined); };
    const dueNow = async () => (await env.DB.prepare("SELECT COALESCE(next_attempt_at,0)<=? AS due FROM refund_ops WHERE payment_intent='pi_1'").bind(Date.now()).first<{ due: number }>())?.due;
    const longBackoff = () => env.DB.prepare("UPDATE refund_ops SET attempts=12,next_attempt_at=? WHERE payment_intent='pi_1'").bind(Date.now() + 6 * 3_600_000).run();

    it("INTEGRATED-12 P1-1 ownership before the lookup: an event naming no payment intent whose charge our records tie to an invoice (a closed earlier dispute) holds that invoice BEFORE the failing Stripe lookup; the failure is recorded on the retry path; another charge's refund on the invoice is held", async () => {
      const r = await asked();
      await env.DB.prepare(`INSERT INTO payment_disputes (dispute_id,home_id,charge_id,payment_intent,invoice_id,subscription_id,scope,opened_at,amount_cents,currency,status,updated_at,closed_at,outcome,returned_cents)
        VALUES ('dp_old12','home-1','ch_X12',NULL,'in_1','sub_test1','current',?,1000,'usd','won',?,?,'won',0)`).bind(NOW, NOW, NOW).run();
      chargeFails = 1000; // Stripe cannot be read
      const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_x12", charge: "ch_X12", status: "needs_response", amount: 1000, currency: "usd" });
      expect((await hook(ev)).status).toBe(500);
      // Before the fix: no payment intent, so the charge lookup came first, failed, and nothing was held.
      expect(await holdsOf("ch_X12")).toEqual([{ e: ev.id, pi: null, inv: "in_1", cus: null, released: 0 }]);
      expect(await env.DB.prepare("SELECT attempts>=1 AS tried,next_attempt_at IS NOT NULL AS due,processed_at FROM stripe_events WHERE id=?").bind(ev.id).first())
        .toEqual({ tried: 1, due: 1, processed_at: null });
      stripeCalls = [];
      await execute({ requestId: r.requestId }); // pi_1's refund on the same invoice
      await advance().catch((e) => expect(String(e)).toMatch(/billing_sweep_incomplete/));
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      noCreditTouched();
    });

    it("INTEGRATED-12 P1-1 attribution pending: a charge nothing of ours names is held ATTRIBUTION PENDING before the failing lookup (every refund it could belong to waits; the failure is recorded and retried; paged after 15 minutes); once Stripe answers (another payment) the hold narrows and the held refund is due at once, paid once", async () => {
      const r = await asked();
      chargeFails = 1000;
      const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_unk12", charge: "ch_unk12", status: "needs_response", amount: 4900, currency: "usd" });
      expect((await hook(ev)).status).toBe(500);
      expect(await holdsOf("ch_unk12")).toEqual([{ e: ev.id, pi: null, inv: null, cus: null, released: 0 }]);
      expect(await env.DB.prepare("SELECT scope_pending FROM dispute_holds WHERE event_id=?").bind(ev.id).first()).toEqual({ scope_pending: 1 });
      // The hold's own lookup failed AFTER the hold committed: recorded on the event's normal retry path (before the fix: no bookkeeping).
      expect(await env.DB.prepare("SELECT attempts,error IS NOT NULL AS err,next_attempt_at IS NOT NULL AS due FROM stripe_events WHERE id=?").bind(ev.id).first())
        .toEqual({ attempts: 1, err: 1, due: 1 });
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      await advance().catch((e) => expect(String(e)).toMatch(/billing_sweep_incomplete/));
      expect(refundPosts()).toEqual([]);
      const page = await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='dispute.hold_unattributed' AND subject=? AND resolved_at IS NULL").bind(ev.id).first<{ detail: string }>();
      expect(JSON.parse(page!.detail)).toMatchObject({ eventId: ev.id, scopePending: 1, action: expect.stringContaining(`/v1/admin/dispute-holds/${ev.id}/close`) });
      // The refund now waits on a six-hour backoff. Stripe's retry attributes the charge to ANOTHER payment: narrowed, the refund due at once.
      await longBackoff();
      chargeFails = 0;
      chargeObjs.ch_unk12 = { id: "ch_unk12", object: "charge", customer: "cus_other12", payment_intent: "pi_other12" };
      await hook(ev);
      expect(await holdsOf("ch_unk12")).toEqual([{ e: ev.id, pi: "pi_other12", inv: null, cus: null, released: 0 }]);
      expect(await env.DB.prepare("SELECT scope_pending FROM dispute_holds WHERE event_id=?").bind(ev.id).first()).toEqual({ scope_pending: 0 });
      expect(await dueNow()).toBe(1);
      await sweepOnly();
      expect(refundPosts()).toEqual([4900]);
      await sweepOnly(3_600_000);
      expect(refundPosts()).toEqual([4900]);
      noCreditTouched();
    });

    it("INTEGRATED-12 P1-2 complete invoice attribution: A's dispute names only its payment intent and the invoice lookup fails: B's refund on the same invoice is held; every retry attributes again until resolved (B still held, now by the invoice); A closes LOST: B is lowered so B + A's returned money never exceed the invoice", async () => {
      const r = await asked();
      const { holdDisputeFirst } = await import("../src/b5-billing");
      const e = baseEnv(envOver);
      const evA = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_A12", charge: "ch_A12", payment_intent: "pi_A12", status: "needs_response", amount: 3000, currency: "usd" });
      let down = true; let chargeReads = 0; let invoiceReads = 0;
      const lk = { charge: async (): Promise<never> => { chargeReads++; throw new Error("stripe_down"); },
        invoiceOfPayment: async () => { invoiceReads++; if (down) throw new Error("stripe_down"); return "in_1"; } };
      await expect(holdDisputeFirst(e, evA as never, NOW, lk)).rejects.toThrow(/stripe_down/);
      expect(await holdsOf("ch_A12")).toEqual([{ e: evA.id, pi: "pi_A12", inv: null, cus: null, released: 0 }]);
      stripeCalls = [];
      await execute({ requestId: r.requestId }); // B: pi_1's refund on in_1
      await advance();
      expect(refundPosts()).toEqual([]); // before the fix: admissible (A's hold named only pi_A12)
      expect(await lastError()).toBe("payment_dispute_hold");
      // A retry never returns early on a pending hold: it attributes again.
      await expect(holdDisputeFirst(e, evA as never, NOW, lk)).rejects.toThrow(/stripe_down/);
      down = false;
      expect(await holdDisputeFirst(e, evA as never, NOW, lk)).toBe(true);
      // INTEGRATED-13: the payment is known but not its customer: each pass also asks the charge for its customer (narrowing only; its
      // failure never stops the invoice lookup).
      expect([chargeReads, invoiceReads]).toEqual([3, 3]);
      expect(await holdsOf("ch_A12")).toEqual([{ e: evA.id, pi: "pi_A12", inv: "in_1", cus: null, released: 0 }]);
      await advance();
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      // A's event applied: its dispute row (open) recorded and the hold released by the checkpoint; the OPEN dispute on the invoice holds B.
      await env.DB.prepare(`INSERT INTO payment_disputes (dispute_id,home_id,charge_id,payment_intent,invoice_id,subscription_id,scope,opened_at,amount_cents,currency,status,updated_at)
        VALUES ('dp_A12','home-1','ch_A12','pi_A12','in_1','sub_test1','current',?,3000,'usd','needs_response',?)`).bind(NOW, NOW).run();
      await env.DB.prepare("UPDATE dispute_holds SET attributed_at=?,home_id='home-1' WHERE event_id=?").bind(NOW, evA.id).run();
      await advance();
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_disputed");
      await env.DB.prepare("UPDATE payment_disputes SET closed_at=?,outcome='lost',status='lost',returned_cents=3000,withdrawn_cents=3000 WHERE dispute_id='dp_A12'").bind(NOW + 1).run();
      await advance(); await advance();
      expect(refundPosts()).toEqual([1900]);
      expect(await count("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refund_ops WHERE invoice_id='in_1' AND decided_at IS NOT NULL")).toBe(1900);
      noCreditTouched();
    });

    it("INTEGRATED-12 P1-3 the claim carries the gate: a hold on the invoice committed after the gate passed (just before the claiming batch) stops the submission: no refund, no journal row; the operator's evidenced close makes it due at once and it is paid once", async () => {
      const r = await asked();
      const saved = envOver;
      let fired = false;
      envOver = { ...saved, DB: raceDb("SET submission=?1,submitted_at=COALESCE(submitted_at,?2)", async () => {
        fired = true;
        await env.DB.prepare(`INSERT INTO dispute_holds (event_id,charge_id,dispute_id,event_type,payment_intent,invoice_id,held_at)
          VALUES ('evt_race12','ch_B12','dp_B12','charge.dispute.created','pi_B12','in_1',?)`).bind(NOW).run();
      }) };
      stripeCalls = [];
      try { await execute({ requestId: r.requestId }); } finally { envOver = saved; }
      expect(fired).toBe(true);
      expect(refundPosts()).toEqual([]); // before the fix: submitted with the hold already committed
      expect(await env.DB.prepare("SELECT submitted_at,last_error FROM refund_ops WHERE payment_intent='pi_1'").first()).toEqual({ submitted_at: null, last_error: "payment_dispute_hold" });
      expect(await count("SELECT COUNT(*) AS n FROM refund_submission_journal j JOIN refund_ops o ON o.id=j.op_id WHERE o.payment_intent='pi_1'")).toBe(0);
      await longBackoff();
      await sweepOnly();
      expect(refundPosts()).toEqual([]);
      const closed = await send("/v1/admin/dispute-holds/evt_race12/close", { body: { by: "ops-sean", evidence: "Stripe dashboard: dispute dp_B12 withdrawn by the bank" }, headers: admin });
      expect(closed.status).toBe(200);
      expect(await dueNow()).toBe(1);
      await sweepOnly();
      expect(refundPosts()).toEqual([4900]);
      await sweepOnly(3_600_000);
      expect(refundPosts()).toEqual([4900]);
      noCreditTouched();
    });

    it("INTEGRATED-12 P1-3 a refund already submitted when a hold lands is kept: recorded once from what Stripe returned, never resubmitted, never undone; the hold stays for its own event", async () => {
      const r = await asked();
      const saved = envOver;
      let fired = false;
      envOver = { ...saved, DB: raceDb("intent_journaled,object_id,returned_at", async () => {
        fired = true;
        await env.DB.prepare(`INSERT INTO dispute_holds (event_id,charge_id,dispute_id,event_type,payment_intent,invoice_id,held_at)
          VALUES ('evt_late12','ch_1','dp_late12','charge.dispute.created','pi_1','in_1',?)`).bind(NOW).run();
      }) };
      stripeCalls = [];
      try { await execute({ requestId: r.requestId }); } finally { envOver = saved; }
      expect(fired).toBe(true);
      expect(refundPosts()).toEqual([4900]);
      const op = await env.DB.prepare("SELECT stripe_refund_id IS NOT NULL AS id,refund_submitted_at IS NOT NULL AS submitted,submission FROM refund_ops WHERE payment_intent='pi_1'").first();
      expect(op).toEqual({ id: 1, submitted: 1, submission: 1 });
      expect(await count("SELECT COUNT(*) AS n FROM refund_submission_journal j JOIN refund_ops o ON o.id=j.op_id WHERE o.payment_intent='pi_1' AND j.object_id IS NOT NULL")).toBe(1);
      await advance(); await advance();
      expect(refundPosts()).toEqual([4900]);
      expect(await holdsOf("ch_1")).toMatchObject([{ e: "evt_late12", released: 0 }]);
      noCreditTouched();
    });

    it("INTEGRATED-12 P2-6 a refund held on a six-hour backoff is due at once when its hold is closed (the operator's evidenced close) and is paid on the next sweep", async () => {
      const r = await asked();
      const { holdDisputeFirst } = await import("../src/b5-billing");
      const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_w12", charge: "ch_w12", payment_intent: "pi_1", status: "needs_response" });
      expect(await holdDisputeFirst(baseEnv(envOver), ev as never, NOW)).toBe(true);
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      expect(await lastError()).toBe("payment_dispute_hold");
      await longBackoff();
      await sweepOnly();
      expect(refundPosts()).toEqual([]);
      expect(await dueNow()).toBe(0);
      const closed = await send(`/v1/admin/dispute-holds/${ev.id}/close`, { body: { by: "ops-sean", evidence: "Stripe dashboard: dispute dp_w12 withdrawn by the bank" }, headers: admin });
      expect(closed.status).toBe(200);
      expect(await dueNow()).toBe(1);
      await sweepOnly();
      expect(refundPosts()).toEqual([4900]);
      noCreditTouched();
    });

    // ── Astra INTEGRATED-13 (reachable with Flux off). Prepaid funds and spent credit are never read or written (noCreditTouched); no
    // Flux hook revokes anything and no router exists on this path.
    it("INTEGRATED-13 P1-1 customer narrowing: the charge names an owned customer and its payment intent, then the invoice lookup fails: both are committed BEFORE the invoice lookup, so only that customer's (and that payment's) refunds are held; home-1's refund is paid; a retry keeps that scope", async () => {
      const r = await asked();
      const { holdDisputeFirst } = await import("../src/b5-billing");
      const { disputeHeldFirst } = await import("../src/legal-refunds");
      const e = baseEnv(envOver);
      await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,plan,status,created_at,updated_at) VALUES ('home-c13','cus_c13','starter','active',?,?)")
        .bind(NOW, NOW).run();
      const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_c13", charge: "ch_c13", status: "needs_response", amount: 4900, currency: "usd" });
      let chargeReads = 0; let invoiceReads = 0;
      const lk = { charge: async () => { chargeReads++; return { customer: "cus_c13", invoice: null, payment_intent: "pi_c13" }; },
        invoiceOfPayment: async (): Promise<never> => { invoiceReads++; throw new Error("stripe_down"); } };
      await expect(holdDisputeFirst(e, ev as never, NOW, lk)).rejects.toThrow(/stripe_down/);
      // Before the fix: neither identity was persisted (payment intent and customer NULL): every customer's refunds stayed held.
      expect(await holdsOf("ch_c13")).toEqual([{ e: ev.id, pi: "pi_c13", inv: null, cus: "cus_c13", released: 0 }]);
      expect(await env.DB.prepare("SELECT scope_pending FROM dispute_holds WHERE event_id=?").bind(ev.id).first()).toEqual({ scope_pending: 1 });
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_zz", invoiceId: "in_zz", homeId: "home-c13" })).toBe(true); // that customer's
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_c13" })).toBe(true); // that payment's
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_1", invoiceId: "in_1", homeId: "home-1" })).toBe(false); // another customer's: never
      // A retry starts from what is committed: only the invoice lookup is repeated (it fails again); the scope stays that customer's.
      await expect(holdDisputeFirst(e, ev as never, NOW, lk)).rejects.toThrow(/stripe_down/);
      expect([chargeReads, invoiceReads]).toEqual([1, 2]);
      expect(await holdsOf("ch_c13")).toEqual([{ e: ev.id, pi: "pi_c13", inv: null, cus: "cus_c13", released: 0 }]);
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      await advance();
      expect(refundPosts()).toEqual([4900]);
      await advance();
      expect(refundPosts()).toEqual([4900]);
      noCreditTouched();
    });

    it("INTEGRATED-13 P1-1 a local mapping that appears between retries is used: the charge cannot be read at Stripe; our own records then tie it to another customer's invoice; the next retry attributes the hold from them with no Stripe call, and the refund it fenced is due at once and paid once", async () => {
      const r = await asked();
      const { holdDisputeFirst } = await import("../src/b5-billing");
      const e = baseEnv(envOver);
      const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_m13", charge: "ch_m13", status: "needs_response", amount: 1000, currency: "usd" });
      let chargeReads = 0;
      const lk = { charge: async (): Promise<never> => { chargeReads++; throw new Error("stripe_down"); },
        invoiceOfPayment: async (): Promise<never> => { throw new Error("not_called"); } };
      await expect(holdDisputeFirst(e, ev as never, NOW, lk)).rejects.toThrow(/stripe_down/);
      expect(await holdsOf("ch_m13")).toEqual([{ e: ev.id, pi: null, inv: null, cus: null, released: 0 }]);
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      expect(refundPosts()).toEqual([]); // nothing is attributed yet: every refund waits
      expect(await lastError()).toBe("payment_dispute_hold");
      await longBackoff();
      // Our own records now know the charge: an earlier (won) dispute of it, on another customer's invoice.
      await env.DB.prepare(`INSERT INTO payment_disputes (dispute_id,home_id,charge_id,payment_intent,invoice_id,subscription_id,scope,opened_at,amount_cents,currency,status,updated_at,closed_at,outcome,returned_cents)
        VALUES ('dp_m13_old','home-c13','ch_m13','pi_m13','in_m13','sub_c13','current',?,1000,'usd','won',?,?,'won',0)`).bind(NOW, NOW, NOW).run();
      // Before the fix: the retry asked Stripe for the charge first, failed, and never used the mapping (the hold stayed fleet-wide).
      expect(await holdDisputeFirst(e, ev as never, NOW, lk)).toBe(true);
      expect(chargeReads).toBe(1);
      expect(await holdsOf("ch_m13")).toEqual([{ e: ev.id, pi: "pi_m13", inv: "in_m13", cus: null, released: 0 }]);
      expect(await env.DB.prepare("SELECT scope_pending FROM dispute_holds WHERE event_id=?").bind(ev.id).first()).toEqual({ scope_pending: 0 });
      expect(await dueNow()).toBe(1);
      await sweepOnly();
      expect(refundPosts()).toEqual([4900]);
      await sweepOnly(3_600_000);
      expect(refundPosts()).toEqual([4900]);
      noCreditTouched();
    });

    it("INTEGRATED-13 P2-5 a release during a held pass is never overwritten: the worker observed the hold, the operator closed it (waking the refund) before the worker's failure bookkeeping; the refund stays due now and is paid on the next sweep", async () => {
      const r = await asked();
      const { holdDisputeFirst, closeDisputeHold } = await import("../src/b5-billing");
      const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_g13", charge: "ch_g13", payment_intent: "pi_1", status: "needs_response" });
      expect(await holdDisputeFirst(baseEnv(envOver), ev as never, NOW)).toBe(true);
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      expect(await lastError()).toBe("payment_dispute_hold");
      // Its next pass is due; its failure backoff would now be six hours.
      await env.DB.prepare("UPDATE refund_ops SET attempts=12,next_attempt_at=0 WHERE payment_intent='pi_1'").run();
      const saved = envOver;
      let fired = false;
      envOver = { ...saved, DB: raceDb("UPDATE refund_ops SET attempts=?,last_error=?,next_attempt_at=CASE", async () => {
        fired = true;
        expect(await closeDisputeHold(env, { eventId: ev.id, by: "ops-sean", evidence: "Stripe dashboard: dispute dp_g13 withdrawn by the bank" }, Date.now())).toBe(true);
      }) };
      try { await sweepOnly(); } finally { envOver = saved; }
      expect(fired).toBe(true);
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      // Before the fix: the stale bookkeeping re-imposed the six-hour backoff over the release.
      expect(await dueNow()).toBe(1);
      await sweepOnly();
      expect(refundPosts()).toEqual([4900]);
      await sweepOnly(3_600_000);
      expect(refundPosts()).toEqual([4900]);
      noCreditTouched();
    });

    // ── Astra INTEGRATED-14 (reachable with Flux off). Prepaid funds and spent credit are never read or written and nothing is revoked
    // (noCreditTouched); the only Flux hook used is the reversal target of money ACTUALLY returned, once per refund paid (journaled by the
    // hook; no router exists on this path while Flux is off).
    const fluxOff14 = (paid: number) => {
      noCreditTouched();
      expect(fluxLog.filter((l) => l.hook === "target").map((l) => (l.args as { reason?: string }).reason)).toEqual(Array(paid).fill("refunded"));
    };
    /** A country-mismatch recreation, as switchCheckoutCustomer commits it: home-1's pointer moves from cus_test1 to cus_new14; the ownership
     *  ledger records both customers (never rewritten) and the previous-customer record keeps cus_test1 as home-1's. */
    const switchCustomer14 = async () => {
      const { customerHomeKey, customerPreviousKey } = await import("../src/b5-billing");
      await env.DB.batch([
        env.DB.prepare("UPDATE billing_subscriptions SET customer_id='cus_new14',updated_at=? WHERE home_id='home-1' AND customer_id='cus_test1'").bind(NOW),
        env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING")
          .bind(customerHomeKey("cus_new14"), JSON.stringify({ homeId: "home-1", customerId: "cus_new14", role: "attempt", at: NOW })),
        env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING")
          .bind(customerHomeKey("cus_test1"), JSON.stringify({ homeId: "home-1", customerId: "cus_test1", role: "previous", at: NOW })),
        env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING")
          .bind(customerPreviousKey("home-1", "cus_test1"), JSON.stringify({ homeId: "home-1", customerId: "cus_test1", replacedBy: "cus_new14", at: NOW })),
      ]);
      expect(await env.DB.prepare("SELECT customer_id FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ customer_id: "cus_new14" });
    };

    it("INTEGRATED-14 P1 customer switch after a dispute: a sibling payment's refund on the same invoice stays held when the hold names the customer the home was moved away from (ledger, then the legacy previous record alone); the exact disputed payment stays held; once attributed and closed it is paid once", async () => {
      const r = await asked();
      const { holdDisputeFirst } = await import("../src/b5-billing");
      const { disputeHeldFirst } = await import("../src/legal-refunds");
      const e = baseEnv(envOver);
      fluxLog = [];
      // The dispute is on ANOTHER payment of in_1 (pi_s14); the charge names home-1's customer and that payment, the invoice lookup fails.
      const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_s14", charge: "ch_s14", status: "needs_response", amount: 2000, currency: "usd" });
      let invoiceDown = true;
      const lk = { charge: async () => ({ customer: "cus_test1", invoice: null, payment_intent: "pi_s14" }),
        invoiceOfPayment: async () => { if (invoiceDown) throw new Error("stripe_down"); return "in_1"; } };
      await expect(holdDisputeFirst(e, ev as never, NOW, lk)).rejects.toThrow(/stripe_down/);
      expect(await holdsOf("ch_s14")).toEqual([{ e: ev.id, pi: "pi_s14", inv: null, cus: "cus_test1", released: 0 }]);
      await switchCustomer14();
      // Before the fix: admission matched only the CURRENT customer (cus_new14): pi_1's refund on in_1 escaped the hold.
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_1", invoiceId: "in_1", homeId: "home-1" })).toBe(true);
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_s14" })).toBe(true); // the exact disputed payment
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_zz", invoiceId: "in_zz", homeId: "home-other14" })).toBe(false); // another home's: never
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      await advance();
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      // A row written before the ownership ledger existed: the previous-customer record alone still proves the history.
      await env.DB.prepare("DELETE FROM cloud_ops_state WHERE key='customer_home:cus_test1'").run();
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_1", invoiceId: "in_1", homeId: "home-1" })).toBe(true);
      // Attributed: the invoice is in_1 (resolved); pi_1's refund is now held by the invoice itself.
      invoiceDown = false;
      expect(await holdDisputeFirst(e, ev as never, NOW, lk)).toBe(true);
      expect(await holdsOf("ch_s14")).toEqual([{ e: ev.id, pi: "pi_s14", inv: "in_1", cus: null, released: 0 }]);
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_1", invoiceId: "in_1", homeId: "home-1" })).toBe(true);
      await longBackoff();
      const closed = await send(`/v1/admin/dispute-holds/${ev.id}/close`, { body: { by: "ops-sean", evidence: "Stripe dashboard: dispute dp_s14 withdrawn by the bank" }, headers: admin });
      expect(closed.status).toBe(200);
      expect(await dueNow()).toBe(1);
      await sweepOnly();
      expect(refundPosts()).toEqual([4900]);
      await sweepOnly(3_600_000);
      expect(refundPosts()).toEqual([4900]);
      fluxOff14(1);
    });

    it("INTEGRATED-14 P1 the \"ours\" check reads ownership history: a charge naming only the customer home-1 was moved away from is attributed to that customer (never released as unmatched) and holds home-1's refunds", async () => {
      const r = await asked();
      const { holdDisputeFirst } = await import("../src/b5-billing");
      const { disputeHeldFirst } = await import("../src/legal-refunds");
      const e = baseEnv(envOver);
      fluxLog = [];
      await switchCustomer14();
      const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_o14", charge: "ch_o14", status: "needs_response", amount: 4900, currency: "usd" });
      const lk = { charge: async () => ({ customer: "cus_test1", invoice: null, payment_intent: null }),
        invoiceOfPayment: async (): Promise<never> => { throw new Error("not_called"); } };
      // Before the fix: cus_test1 had no billing row any more: "nothing of ours", released at once as dispute.unmatched.
      expect(await holdDisputeFirst(e, ev as never, NOW, lk)).toBe(true);
      expect(await holdsOf("ch_o14")).toEqual([{ e: ev.id, pi: null, inv: null, cus: "cus_test1", released: 0 }]);
      expect(await env.DB.prepare("SELECT scope_pending FROM dispute_holds WHERE event_id=?").bind(ev.id).first()).toEqual({ scope_pending: 0 });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='dispute.unmatched'")).toBe(0);
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_1", invoiceId: "in_1", homeId: "home-1" })).toBe(true);
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_zz", invoiceId: "in_zz", homeId: "home-other14" })).toBe(false);
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      await advance();
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      fluxOff14(0);
    });

    it("INTEGRATED-14 P1 a foreign customer still blocks only its own payment: the charge names a customer no home ever owned and the invoice lookup fails; home-1's refund (after its own customer switch) is paid once", async () => {
      const r = await asked();
      const { holdDisputeFirst } = await import("../src/b5-billing");
      const { disputeHeldFirst } = await import("../src/legal-refunds");
      const e = baseEnv(envOver);
      fluxLog = [];
      await switchCustomer14();
      const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_f14", charge: "ch_f14", status: "needs_response", amount: 1000, currency: "usd" });
      const lk = { charge: async () => ({ customer: "cus_foreign14", invoice: null, payment_intent: "pi_f14" }),
        invoiceOfPayment: async (): Promise<never> => { throw new Error("stripe_down"); } };
      await expect(holdDisputeFirst(e, ev as never, NOW, lk)).rejects.toThrow(/stripe_down/);
      expect(await holdsOf("ch_f14")).toEqual([{ e: ev.id, pi: "pi_f14", inv: null, cus: "cus_foreign14", released: 0 }]);
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_f14" })).toBe(true);
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_1", invoiceId: "in_1", homeId: "home-1" })).toBe(false);
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      await advance();
      expect(refundPosts()).toEqual([4900]);
      await advance();
      expect(refundPosts()).toEqual([4900]);
      fluxOff14(1);
    });

    it("INTEGRATED-14 P2 a failed scope commit is never swallowed: the payment is known, the charge names its customer and invoice, the commit fails: the event fails with no further Stripe call in that pass; the retry persists the scope", async () => {
      const { holdDisputeFirst } = await import("../src/b5-billing");
      fluxLog = [];
      const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_w14", charge: "ch_w14", payment_intent: "pi_w14", status: "needs_response", amount: 1000, currency: "usd" });
      let chargeReads = 0; let invoiceReads = 0;
      const lk = { charge: async () => { chargeReads++; return { customer: "cus_test1", invoice: "in_w14", payment_intent: "pi_w14" }; },
        invoiceOfPayment: async () => { invoiceReads++; return null; } };
      const failing = baseEnv({ ...envOver, DB: raceDb("UPDATE dispute_holds SET payment_intent=COALESCE(payment_intent,?1)", async () => { throw new Error("d1_write_failed"); }) });
      // Before the fix: the failure was caught, the invoice lookup ran (null) and the hold resolved without the learned invoice.
      await expect(holdDisputeFirst(failing, ev as never, NOW, lk)).rejects.toThrow(/d1_write_failed/);
      expect([chargeReads, invoiceReads]).toEqual([1, 0]);
      expect(await holdsOf("ch_w14")).toEqual([{ e: ev.id, pi: "pi_w14", inv: null, cus: null, released: 0 }]);
      expect(await env.DB.prepare("SELECT scope_pending FROM dispute_holds WHERE event_id=?").bind(ev.id).first()).toEqual({ scope_pending: 1 });
      // The retry commits what the charge named (its invoice: resolved) before anything else; the invoice lookup is never needed.
      expect(await holdDisputeFirst(baseEnv(envOver), ev as never, NOW, lk)).toBe(true);
      expect([chargeReads, invoiceReads]).toEqual([2, 0]);
      expect(await holdsOf("ch_w14")).toEqual([{ e: ev.id, pi: "pi_w14", inv: "in_w14", cus: null, released: 0 }]);
      expect(await env.DB.prepare("SELECT scope_pending FROM dispute_holds WHERE event_id=?").bind(ev.id).first()).toEqual({ scope_pending: 0 });
      // A failed charge READ is still only narrowing: the invoice lookup runs.
      const ev2 = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_r14", charge: "ch_r14", payment_intent: "pi_r14", status: "needs_response", amount: 1000, currency: "usd" });
      const lk2 = { charge: async (): Promise<never> => { throw new Error("stripe_down"); }, invoiceOfPayment: async () => "in_r14" };
      expect(await holdDisputeFirst(baseEnv(envOver), ev2 as never, NOW, lk2)).toBe(true);
      expect(await holdsOf("ch_r14")).toEqual([{ e: ev2.id, pi: "pi_r14", inv: "in_r14", cus: null, released: 0 }]);
      fluxOff14(0);
    });

    // ── Astra INTEGRATED-15 P2 (reachable with Flux off): admission work is bounded. Ownership is read from the customer_owners index
    // (migration 0106, kept by triggers), never from a home's JSON orphan / create-journal history.
    it("INTEGRATED-15 P2 the gate, the claim and the wake read no JSON history: ownership comes from the customer_owners index (trigger-kept, insert-only); the gate's rows read do not grow with a home's history; switch, history and foreign-customer semantics unchanged; paid once after the close", async () => {
      const r = await asked();
      const { holdDisputeFirst } = await import("../src/b5-billing");
      const { disputeHeldFirst } = await import("../src/legal-refunds");
      const { disputeHoldMatchSql, WAKE_HELD_BY_HOLD_SQL } = await import("../src/dispute-sql");
      const e = baseEnv(envOver);
      fluxLog = [];
      const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_s15", charge: "ch_s15", status: "needs_response", amount: 2000, currency: "usd" });
      const lk = { charge: async () => ({ customer: "cus_test1", invoice: null, payment_intent: "pi_s15" }),
        invoiceOfPayment: async (): Promise<never> => { throw new Error("stripe_down"); } };
      await expect(holdDisputeFirst(e, ev as never, NOW, lk)).rejects.toThrow(/stripe_down/);
      await switchCustomer14();
      const owners = async (cus: string) => (await env.DB.prepare("SELECT home_id FROM customer_owners WHERE customer_id=? ORDER BY home_id").bind(cus)
        .all<{ home_id: string }>()).results.map((o) => o.home_id);
      // The triggers indexed every ownership record the switch wrote (ledger, previous-customer record); the pointer is read directly.
      expect(await owners("cus_test1")).toEqual(["home-1"]);
      expect(await owners("cus_new14")).toEqual(["home-1"]);
      // 64 UNRELATED pending holds, each on a customer another home owns, and a refund home with a growing JSON history.
      await env.DB.batch(Array.from({ length: 64 }, (_, i) => [
        env.DB.prepare(`INSERT INTO dispute_holds (event_id,charge_id,dispute_id,event_type,customer_id,held_at,scope_pending) VALUES (?,?,?,'charge.dispute.created',?,?,1)`)
          .bind(`evt_u15_${i}`, `ch_u15_${i}`, `dp_u15_${i}`, `cus_u15_${i}`, NOW),
        env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?)").bind(`customer_home:cus_u15_${i}`, JSON.stringify({ homeId: "home-x15", role: "first", at: NOW })),
      ]).flat());
      const history = async (from: number, to: number) => {
        const st: D1PreparedStatement[] = [];
        for (let i = from; i < to; i++) {
          st.push(env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?)").bind(`customer_orphan:home-h15:a${i}`,
            JSON.stringify({ homeId: "home-h15", customerId: `cus_h15_${i}`, createdAt: NOW, recordedAt: NOW, reason: "binding_failed" })));
          st.push(env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?)").bind(`tax_customer:home-h15:k${i}`,
            JSON.stringify({ homeId: "home-h15", customerId: `cus_k15_${i}`, createdAt: NOW })));
        }
        for (let i = 0; i < st.length; i += 100) await env.DB.batch(st.slice(i, i + 100));
      };
      const gate = `SELECT 1 AS x FROM dispute_holds h WHERE ${disputeHoldMatchSql("?1", "?2", "?3")} LIMIT 1`;
      const gateRead = async () => {
        const res = await env.DB.prepare(gate).bind("pi_h15", "in_h15", "home-h15").all();
        expect(res.results).toEqual([]);
        return res.meta.rows_read;
      };
      await history(0, 16);
      const small = await gateRead();
      await history(16, 2048);
      expect(await owners("cus_h15_2047")).toEqual(["home-h15"]); // the orphan record is indexed
      expect(await owners("cus_k15_2047")).toEqual(["home-h15"]); // and the create journal row
      const large = await gateRead();
      expect(typeof small).toBe("number");
      expect(large).toBe(small); // 128x the history, the same rows read: no per-hold history scan
      // The plans of the gate's read, the claim's predicate and the wake touch the index, never cloud_ops_state.
      const plan = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>())
        .results.map((p) => p.detail).join("\n");
      for (const p of [await plan(gate, "pi_h15", "in_h15", "home-h15"),
        await plan(`SELECT id FROM refund_ops WHERE id=?1 AND NOT EXISTS (SELECT 1 FROM dispute_holds h WHERE ${disputeHoldMatchSql("?2", "?3", "?4")})`, "x", "pi_h15", "in_h15", "home-h15"),
        await plan(WAKE_HELD_BY_HOLD_SQL, "evt_u15_0", NOW)]) {
        expect(p).not.toMatch(/cloud_ops_state/);
        expect(p).toMatch(/SEARCH co USING PRIMARY KEY \(customer_id=\? AND home_id=\?\)/);
      }
      expect(disputeHoldMatchSql("?1", "?2", "?3")).not.toMatch(/cloud_ops_state|json_/);
      // Semantics unchanged: the customer home-1 was moved away from still holds its refunds, the exact payment is held, another home is not.
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_1", invoiceId: "in_1", homeId: "home-1" })).toBe(true);
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_s15" })).toBe(true);
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_zz", invoiceId: "in_zz", homeId: "home-other15" })).toBe(false);
      // Ownership is immutable history: a record deleted later (the ledger row, the previous-customer record) never narrows the hold.
      await env.DB.prepare("DELETE FROM cloud_ops_state WHERE key IN ('customer_home:cus_test1','customer_previous:home-1:cus_test1')").run();
      expect(await disputeHeldFirst(e, { paymentIntent: "pi_1", invoiceId: "in_1", homeId: "home-1" })).toBe(true);
      // The claim admits nothing while held.
      stripeCalls = [];
      await execute({ requestId: r.requestId });
      await advance();
      expect(refundPosts()).toEqual([]);
      expect(await lastError()).toBe("payment_dispute_hold");
      // Closed by ops with evidence: the wake reaches home-1's refund through the index; paid once, never twice.
      await longBackoff();
      const closed = await send(`/v1/admin/dispute-holds/${ev.id}/close`, { body: { by: "ops-sean", evidence: "Stripe dashboard: dispute dp_s15 withdrawn by the bank" }, headers: admin });
      expect(closed.status).toBe(200);
      expect(await dueNow()).toBe(1);
      // The 64 unrelated holds stay pending: they never hold home-1 (their customers are another home's).
      await sweepOnly();
      expect(refundPosts()).toEqual([4900]);
      await sweepOnly(3_600_000);
      expect(refundPosts()).toEqual([4900]);
      fluxOff14(1);
    });

    it("open -> closed WON: the row is closed with its outcome, nothing returned; the hold is released and the refund is paid in full", async () => {
      await heldRefund("dp_won8");
      const ev = disputeEvent("charge.dispute.closed", disputeObj("dp_won8", "won", [withdrawn("txn_dp_won8_w", 4900), reinstated("txn_dp_won8_r", 4900)]));
      expect((await hook(ev)).status).toBe(200);
      expect(await errorOf(ev)).toBe("dispute_closed_won");
      expect(await row("dp_won8")).toEqual({ closed: 1, outcome: "won", status: "won", amount: 4900, w: 4900, r: 4900, returned: 0 });
      await advance();
      expect(refundPosts()).toEqual([4900]);
    });

    it("open -> closed LOST: the money the bank returned is recorded for the payment; the held refund is lowered so it is never paid twice", async () => {
      await heldRefund("dp_lost8");
      // The bank kept 3,000 of the 4,900 paid (a partial dispute): only the remaining 1,900 may still be refunded.
      const ev = disputeEvent("charge.dispute.closed", disputeObj("dp_lost8", "lost", [withdrawn("txn_dp_lost8_w", 3000)], 3000));
      expect((await hook(ev)).status).toBe(200);
      expect(await row("dp_lost8")).toEqual({ closed: 1, outcome: "lost", status: "lost", amount: 3000, w: 3000, r: 0, returned: 3000 });
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='dispute.lost'")).toBe(1);
      await advance();
      expect(refundPosts()).toEqual([1900]);
      expect(await env.DB.prepare("SELECT amount_cents FROM refund_ops WHERE payment_intent='pi_1'").first()).toEqual({ amount_cents: 1900 });
      expect(await env.DB.prepare("SELECT decided_cents FROM refund_invoice_ledger WHERE invoice_id='in_1'").first()).toEqual({ decided_cents: 1900 });
      // A later full refund of the same payment is capped by the ledger: nothing is left (1,900 refunded + 3,000 returned = 4,900 paid).
      const { refundedAgainst } = await import("../src/legal-flows");
      expect(await refundedAgainst(env, "in_1")).toBe(4900);
    });

    it("LOST in full: the held refund is lowered to nothing and no refund is ever submitted", async () => {
      await heldRefund("dp_lostall");
      expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_lostall", "lost", [withdrawn("txn_dp_lostall_w", 4900)])))).status).toBe(200);
      await advance();
      expect(refundPosts()).toEqual([]);
      expect(await env.DB.prepare("SELECT amount_cents FROM refund_ops WHERE payment_intent='pi_1'").first()).toEqual({ amount_cents: 0 });
    });

    it("lost, then a PARTIAL reinstatement: the row is updated (returned lowered), idempotently; the refund pays exactly the reinstated part", async () => {
      await heldRefund("dp_part8");
      const closed = disputeEvent("charge.dispute.closed", disputeObj("dp_part8", "lost", [withdrawn("txn_dp_part8_w", 4900)]));
      expect((await hook(closed)).status).toBe(200);
      expect(await row("dp_part8")).toMatchObject({ outcome: "lost", returned: 4900 });
      const back = disputeObj("dp_part8", "lost", [withdrawn("txn_dp_part8_w", 4900), reinstated("txn_dp_part8_r", 1500)]);
      const ev = disputeEvent("charge.dispute.funds_reinstated", back);
      expect((await hook(ev)).status).toBe(200);
      expect(await errorOf(ev)).toBe("dispute_closed_lost_after_closure");
      expect(await row("dp_part8")).toEqual({ closed: 1, outcome: "lost", status: "lost", amount: 4900, w: 4900, r: 1500, returned: 3400 });
      // The same movement seen again (another event naming it): counted once.
      expect((await hook(disputeEvent("charge.dispute.closed", back))).status).toBe(200);
      expect(await row("dp_part8")).toMatchObject({ w: 4900, r: 1500, returned: 3400 });
      expect(await count("SELECT COUNT(*) AS n FROM payment_dispute_events WHERE dispute_id='dp_part8' AND after_closure=1")).toBe(2);
      await advance();
      expect(refundPosts()).toEqual([1500]);
    });

    it("duplicate and out-of-order events: judged by event id and Stripe's current dispute, never by their timestamps", async () => {
      await paidUs();
      // The closure (won) is delivered BEFORE the dispute's creation event: the row is opened and closed from Stripe's current state.
      const won = disputeObj("dp_order8", "won", [withdrawn("txn_o_w", 4900), reinstated("txn_o_r", 4900)]);
      const closed = disputeEvent("charge.dispute.closed", won, won);
      expect((await hook(closed)).status).toBe(200);
      expect(await row("dp_order8")).toMatchObject({ closed: 1, outcome: "won", returned: 0 });
      // A funds_withdrawn dated earlier, carrying its stale snapshot (still open), arrives after: recorded, never reopens the row.
      const stale = disputeEvent("charge.dispute.funds_withdrawn", won, disputeObj("dp_order8", "needs_response", [withdrawn("txn_o_w", 4900)]));
      const staleEv = { ...stale, created: NOW / 1000 - 3600 };
      expect((await hook(staleEv)).status).toBe(200);
      expect(await row("dp_order8")).toEqual({ closed: 1, outcome: "won", status: "won", amount: 4900, w: 4900, r: 4900, returned: 0 });
      // The same event redelivered: nothing is added twice.
      expect((await hook(staleEv)).status).toBe(200);
      expect(await count("SELECT COUNT(*) AS n FROM payment_dispute_events WHERE dispute_id='dp_order8'")).toBe(2);
      expect(await count("SELECT COUNT(*) AS n FROM payment_dispute_funds WHERE dispute_id='dp_order8'")).toBe(2);
      // The creation event handled last: the dispute is already closed in our favour, so nothing is stopped or cancelled.
      stripeCalls = []; fluxLog = [];
      const created = disputeEvent("charge.dispute.created", won, disputeObj("dp_order8", "needs_response"));
      expect((await hook(created)).status).toBe(200);
      expect(await errorOf(created)).toBe("dispute_already_closed_won");
      expect(await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ status: "active" });
      expect(fluxLog.filter((l) => l.hook === "stop")).toEqual([]);
      expect(stripeCalls.filter((c) => c.method === "DELETE")).toEqual([]);
    });

    it("manual closure by ops still works: closed_at set by hand releases the hold (won); a hand-closed LOST counts the disputed amount as returned", async () => {
      await heldRefund("dp_hand8");
      await env.DB.prepare("UPDATE payment_disputes SET closed_at=?,outcome='lost' WHERE dispute_id='dp_hand8'").bind(NOW + 1).run();
      await advance();
      expect(refundPosts()).toEqual([]);
      expect(await env.DB.prepare("SELECT amount_cents FROM refund_ops WHERE payment_intent='pi_1'").first()).toEqual({ amount_cents: 0 });
    });

    it("manual closure by ops as WON: the hold is released and the refund is paid; Stripe's later closure keeps the manual closed_at", async () => {
      await heldRefund("dp_handwon");
      await env.DB.prepare("UPDATE payment_disputes SET closed_at=?,outcome='won' WHERE dispute_id='dp_handwon'").bind(NOW + 1).run();
      await advance();
      expect(refundPosts()).toEqual([4900]);
      expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_handwon", "won", [withdrawn("txn_hw_w", 4900), reinstated("txn_hw_r", 4900)])))).status).toBe(200);
      expect(await env.DB.prepare("SELECT closed_at,outcome,returned_cents FROM payment_disputes WHERE dispute_id='dp_handwon'").first())
        .toEqual({ closed_at: NOW + 1, outcome: "won", returned_cents: 0 });
    });

    describe("round 9b (Astra TAXCOUNTRY-8)", () => {
      const op = () => env.DB.prepare(`SELECT id,amount_cents AS a,done_at IS NOT NULL AS done,last_error AS e,created_at AS c,refunded_at IS NOT NULL AS paid
        FROM refund_ops WHERE payment_intent='pi_1' AND id NOT LIKE 'disputerest:%'`).first<{ id: string; a: number; done: number; e: string | null; c: number; paid: number }>();
      const decided = async () => (await env.DB.prepare("SELECT decided_cents AS d FROM refund_invoice_ledger WHERE invoice_id='in_1'").first<{ d: number }>())!.d;

      it("P1-6: a $49 loss caps the held $49 refund to zero WITHOUT completing it; a $15 reinstatement reopens it: $15 paid, original op and deadline; final only after the window", async () => {
        await heldRefund("dp_r9z");
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r9z", "lost", [withdrawn("txn_r9z_w", 4900)])))).status).toBe(200);
        await advance();
        expect(refundPosts()).toEqual([]);
        const first = (await op())!;
        expect(first).toMatchObject({ a: 0, done: 0, e: "refund_dispute_reinstatement_possible" });
        const back = disputeObj("dp_r9z", "lost", [withdrawn("txn_r9z_w", 4900), reinstated("txn_r9z_r", 1500)]);
        expect((await hook(disputeEvent("charge.dispute.funds_reinstated", back))).status).toBe(200);
        // The reinstatement made the operation due at once (no waiting for its daily look).
        expect(await env.DB.prepare("SELECT next_attempt_at AS n FROM refund_ops WHERE id=?").bind(first.id).first()).toEqual({ n: later });
        await advance();
        expect(refundPosts()).toEqual([1500]);
        expect(await op()).toMatchObject({ id: first.id, a: 1500, paid: 1, done: 0, c: first.c });
        expect(await decided()).toBe(1500);
        await advance();
        expect(refundPosts()).toEqual([1500]); // never paid twice
        // The reinstatement window passes with nothing more coming back: completed, once.
        later = NOW + 121 * DAY;
        await advance();
        expect(await op()).toMatchObject({ a: 1500, done: 1 });
        expect(refundPosts()).toEqual([1500]);
      });

      it("P1-6: a partial loss already paid at the capped amount: the reinstated money is paid by ONE remainder operation (ledger-capped, the parent's deadline)", async () => {
        await heldRefund("dp_r9p");
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r9p", "lost", [withdrawn("txn_r9p_w", 3000)], 3000)))).status).toBe(200);
        await advance();
        expect(refundPosts()).toEqual([1900]);
        const parent = (await op())!;
        expect(parent).toMatchObject({ a: 1900, paid: 1, done: 0 });
        expect((await hook(disputeEvent("charge.dispute.funds_reinstated", disputeObj("dp_r9p", "lost", [withdrawn("txn_r9p_w", 3000), reinstated("txn_r9p_r", 1500)], 3000)))).status).toBe(200);
        await advance(); await advance();
        expect(refundPosts()).toEqual([1900, 1500]);
        expect(await env.DB.prepare("SELECT id,kind,amount_cents AS a,basis,done_at IS NOT NULL AS done,created_at AS c FROM refund_ops WHERE id LIKE 'disputerest:%'").all().then((x) => x.results))
          .toEqual([{ id: `disputerest:${parent.id}:1`, kind: "first_month", a: 1500, basis: "dispute_reinstated", done: 1, c: parent.c }]);
        expect(await decided()).toBe(3400); // 1,900 + 1,500 refunded + 1,500 still kept by the bank = 4,900 paid
        await advance();
        expect(refundPosts()).toEqual([1900, 1500]);
        expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE id LIKE 'disputerest:%'")).toBe(1);
      });

      it("P2-a: a refund already submitted, adopted by its saved id after the dispute is lost, goes through the combined refund + dispute cap: held, never completed", async () => {
        await paidUs(); signedIn = OWNER;
        const r = await request();
        await replaceWithB(); await frozenA();
        refundStatus = "pending";
        stripeCalls = [];
        await execute({ requestId: r.requestId });
        expect(refundPosts()).toEqual([4900]);
        expect((await op())!.e).toBe("refund_pending");
        // The bank takes 3,000 back through a dispute; then Stripe says the submitted refund succeeded.
        expect((await hook(disputeEvent("charge.dispute.created", disputeObj("dp_r9a", "needs_response", [withdrawn("txn_r9a_w", 3000)], 3000)))).status).toBe(200);
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r9a", "lost", [withdrawn("txn_r9a_w", 3000)], 3000)))).status).toBe(200);
        refundsMade[0].status = "succeeded";
        await advance();
        expect(await op()).toMatchObject({ a: 4900, paid: 0, done: 0, e: "payment_dispute_returned" });
        expect(refundPosts()).toEqual([4900]);
      });

      it("currency: a dispute movement in another currency is never converted: the row is inexact, its returned money unset, the held refund stays held for an operator", async () => {
        await heldRefund("dp_r9c");
        const eur = { id: "txn_r9c_w", amount: -4500, fee: 1500, currency: "eur", exchange_rate: 1.0889, reporting_category: "dispute" };
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r9c", "lost", [eur])))).status).toBe(200);
        expect(await env.DB.prepare("SELECT movement_exact AS x,returned_cents AS r,withdrawn_cents AS w FROM payment_disputes WHERE dispute_id='dp_r9c'").first())
          .toEqual({ x: 0, r: null, w: 0 });
        expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='dispute.movement_inexact' AND resolved_at IS NULL")).toBe(1);
        await advance();
        expect(refundPosts()).toEqual([]);
        expect(await op()).toMatchObject({ a: 4900, done: 0, e: "payment_dispute_inexact" });
        expect(await decided()).toBe(4900); // nothing lowered on a guess
      });

      it("dispute credits: a LOST dispute records the owed credit reversal as an obligation + alert (targets count refunds only); reinstatements lower and clear it; nothing is sent to Flux", async () => {
        await heldRefund("dp_r9k");
        fluxLog = [];
        const obligation = () => env.DB.prepare("SELECT invoice_id AS i,returned_cents AS r,state FROM dispute_credit_obligations WHERE dispute_id='dp_r9k'").first();
        const alert = () => env.DB.prepare("SELECT detail,resolved_at IS NULL AS open FROM cloud_alerts WHERE kind='credit.dispute_reversal_owed'").first<{ detail: string; open: number }>();
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r9k", "lost", [withdrawn("txn_r9k_w", 4900)])))).status).toBe(200);
        expect(await obligation()).toEqual({ i: "in_1", r: 4900, state: "owed" });
        expect((await alert())!.open).toBe(1);
        expect(JSON.parse((await alert())!.detail).obligations).toEqual([{ disputeId: "dp_r9k", invoiceId: "in_1", returnedCents: 4900, exact: 1, appliedCents: null }]);
        // The same event again: the same row, the same alert.
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r9k", "lost", [withdrawn("txn_r9k_w", 4900)])))).status).toBe(200);
        expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.dispute_reversal_owed'")).toBe(1);
        expect((await hook(disputeEvent("charge.dispute.funds_reinstated", disputeObj("dp_r9k", "lost", [withdrawn("txn_r9k_w", 4900), reinstated("txn_r9k_r", 1500)])))).status).toBe(200);
        expect(await obligation()).toEqual({ i: "in_1", r: 3400, state: "owed" });
        expect((await hook(disputeEvent("charge.dispute.funds_reinstated", disputeObj("dp_r9k", "lost", [withdrawn("txn_r9k_w", 4900), reinstated("txn_r9k_r", 1500),
          reinstated("txn_r9k_r2", 3400)])))).status).toBe(200);
        expect(await obligation()).toEqual({ i: "in_1", r: 0, state: "cleared" });
        expect((await alert())!.open).toBe(0);
        expect(fluxLog.filter((l) => l.hook === "revoke" || l.hook === "target" || l.hook === "stop")).toEqual([]);
      });
    });

    describe("round 10 (Astra TAXCOUNTRY-9)", () => {
      const opRow = () => env.DB.prepare(`SELECT id,amount_cents AS a,decided_at IS NOT NULL AS decided,done_at IS NOT NULL AS done,last_error AS e,
        json_extract(detail,'$.disputeCappedFromCents') AS capFrom FROM refund_ops WHERE payment_intent='pi_1' AND id NOT LIKE 'disputerest:%'`)
        .first<{ id: string; a: number | null; decided: number; done: number; e: string | null; capFrom: number | null }>();
      const eur = (id: string, cents: number) => ({ id, amount: cents, fee: 0, currency: "eur", exchange_rate: 1.0889, reporting_category: cents < 0 ? "dispute" : "dispute_reversal" });
      /** The refund is asked for and the order replaced (as heldRefund), but NOT yet executed: the first decision comes after `before`. */
      const askedNotDecided = async () => { await paidUs(); signedIn = OWNER; const r = await request(); await replaceWithB(); await frozenA(); return r; };
      const alertOpen = async (kind: string) => count(`SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='${kind}' AND resolved_at IS NULL`);

      it("P1-1: loss before the first refund decision then reinstatement: the decision is CAPPED (its uncapped amount kept), and the reinstated money is paid by its remainder", async () => {
        const r = await askedNotDecided();
        expect((await hook(disputeEvent("charge.dispute.created", disputeObj("dp_r10a", "needs_response", [withdrawn("txn_r10a_w", 3000)], 3000)))).status).toBe(200);
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r10a", "lost", [withdrawn("txn_r10a_w", 3000)], 3000)))).status).toBe(200);
        stripeCalls = [];
        await execute({ requestId: r.requestId });
        await advance();
        expect(refundPosts()).toEqual([1900]);
        expect(await opRow()).toMatchObject({ a: 1900, capFrom: 4900, done: 0 });
        expect((await hook(disputeEvent("charge.dispute.funds_reinstated", disputeObj("dp_r10a", "lost", [withdrawn("txn_r10a_w", 3000), reinstated("txn_r10a_r", 1500)], 3000)))).status).toBe(200);
        await advance(); await advance();
        expect(refundPosts()).toEqual([1900, 1500]);
        expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE id LIKE 'disputerest:%' AND amount_cents=1500")).toBe(1);
      });

      it("P1-1: a full loss before the decision lowers it to zero (not a refusal); a reinstatement after it completed raises the late-reinstatement alert", async () => {
        const r = await askedNotDecided();
        expect((await hook(disputeEvent("charge.dispute.created", disputeObj("dp_r10b", "needs_response", [withdrawn("txn_r10b_w", 4900)])))).status).toBe(200);
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r10b", "lost", [withdrawn("txn_r10b_w", 4900)])))).status).toBe(200);
        stripeCalls = [];
        await execute({ requestId: r.requestId });
        await advance();
        expect(refundPosts()).toEqual([]);
        expect(await opRow()).toMatchObject({ a: 0, capFrom: 4900, done: 0, e: "refund_dispute_reinstatement_possible" });
        expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='refund_declined'")).toBe(0);
        later = NOW + 121 * DAY;
        await advance();
        expect(await opRow()).toMatchObject({ a: 0, done: 1 });
        expect((await hook(disputeEvent("charge.dispute.funds_reinstated", disputeObj("dp_r10b", "lost", [withdrawn("txn_r10b_w", 4900), reinstated("txn_r10b_r", 1500)])))).status).toBe(200);
        expect(await alertOpen("refund.dispute_reinstated_after_final")).toBe(1);
      });

      it("P1-2: inexact -> WON: nothing was returned: the hold is released and the refund is paid in full; the inexact alerts close", async () => {
        await heldRefund("dp_r10w");
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r10w", "won", [eur("txn_r10w_w", -4500), eur("txn_r10w_r", 4500)])))).status).toBe(200);
        expect(await env.DB.prepare("SELECT movement_exact AS x,outcome FROM payment_disputes WHERE dispute_id='dp_r10w'").first()).toEqual({ x: 0, outcome: "won" });
        await advance();
        expect(refundPosts()).toEqual([4900]);
        expect(await alertOpen("dispute.movement_inexact")).toBe(0);
        expect(await alertOpen("dispute.inexact_lost")).toBe(0);
      });

      it("P1-2: inexact -> LOST: the hold stays (nothing lowered on a guess), HIGH alert with its deadline, escalated past it; ops resolves with evidence and the refund pays the proven remainder", async () => {
        await heldRefund("dp_r10l");
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r10l", "lost", [eur("txn_r10l_w", -4500)])))).status).toBe(200);
        const alert = await env.DB.prepare("SELECT severity,subject,detail FROM cloud_alerts WHERE kind='dispute.inexact_lost' AND resolved_at IS NULL").first<{ severity: string; subject: string; detail: string }>();
        expect(alert).toMatchObject({ severity: "high", subject: "dp_r10l" });
        expect(JSON.parse(alert!.detail)).toMatchObject({ resolveBy: later + 5 * DAY, action: "POST /v1/admin/disputes/dp_r10l/resolve-returned {returnedCents, evidence, by}" });
        await advance();
        expect(refundPosts()).toEqual([]);
        expect(await opRow()).toMatchObject({ a: 4900, done: 0, e: "payment_dispute_inexact" });
        later = NOW + 6 * DAY;
        await advance();
        expect(await alertOpen("dispute.inexact_overdue")).toBe(1);
        expect(refundPosts()).toEqual([]);
        // The resolution needs evidence and who records it; only a lost, inexact, unresolved dispute is resolvable.
        expect((await send("/v1/admin/disputes/dp_r10l/resolve-returned", { body: { returnedCents: 3000, evidence: "short", by: "ops" }, headers: admin })).status).toBe(400);
        expect((await send("/v1/admin/disputes/dp_r10l/resolve-returned", { body: { returnedCents: 3000, evidence: "bank statement 2026-10 line 14: CAD 41.10 = USD 30.00", by: "ops-sean" }, headers: admin })).status).toBe(200);
        expect((await send("/v1/admin/disputes/dp_r10l/resolve-returned", { body: { returnedCents: 3000, evidence: "bank statement 2026-10 line 14: CAD 41.10 = USD 30.00", by: "ops-sean" }, headers: admin })).status).toBe(409);
        expect(await alertOpen("dispute.inexact_lost")).toBe(0);
        expect(await alertOpen("dispute.inexact_overdue")).toBe(0);
        await advance();
        expect(refundPosts()).toEqual([1900]);
        expect(await opRow()).toMatchObject({ a: 1900, capFrom: 4900 });
      });

      /** An inexact LOST dispute resolved by ops at $30 returned: the $49 refund is paid at $19 (capped from $49). */
      const resolvedAt30 = async (id: string) => {
        await heldRefund(id);
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj(id, "lost", [eur(`txn_${id}_w`, -4500)])))).status).toBe(200);
        expect((await send(`/v1/admin/disputes/${id}/resolve-returned`, { body: { returnedCents: 3000, evidence: "bank statement 2026-10 line 14: CAD 41.10 = USD 30.00", by: "ops-sean" }, headers: admin })).status).toBe(200);
        await advance();
        expect(refundPosts()).toEqual([1900]);
        expect(await opRow()).toMatchObject({ a: 1900, capFrom: 4900 });
      };
      const rests = () => env.DB.prepare("SELECT amount_cents AS a,done_at IS NOT NULL AS done FROM refund_ops WHERE id LIKE 'disputerest:%'").all().then((x) => x.results);

      it("INTEGRATED-7 P1 late inexact WIN: $49 paid, $30 inexact loss resolved, $19 refunded, final after 120 days, then WON: the $30 remainder is reopened, paid and alerted", async () => {
        await resolvedAt30("dp_i7w");
        later = NOW + 121 * DAY;
        await advance();
        expect(await opRow()).toMatchObject({ a: 1900, done: 1 });
        // The card network reverses the outcome after the window: the bank gives the $30 back.
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_i7w", "won", [eur("txn_dp_i7w_w", -4500), eur("txn_dp_i7w_r", 4500)])))).status).toBe(200);
        // Before the fix: nothing reopened, nothing alerted (no reinstated_cents moved), the $30 lost.
        expect(await alertOpen("refund.dispute_returned_lowered")).toBe(1);
        expect(await rests()).toEqual([{ a: null, done: 0 }]);
        await advance(); await advance();
        expect(refundPosts()).toEqual([1900, 3000]);
        expect(await rests()).toEqual([{ a: 3000, done: 1 }]);
        await advance();
        expect(refundPosts()).toEqual([1900, 3000]); // never twice
      });

      it("INTEGRATED-7 P1 foreign-currency reinstatement after finalisation (reinstated_cents stays 0): reopened and alerted, held until ops resolves again, then the difference is paid", async () => {
        await resolvedAt30("dp_i7r");
        later = NOW + 121 * DAY;
        await advance();
        expect(await opRow()).toMatchObject({ a: 1900, done: 1 });
        expect((await hook(disputeEvent("charge.dispute.funds_reinstated", disputeObj("dp_i7r", "lost", [eur("txn_dp_i7r_w", -4500), eur("txn_dp_i7r_r", 1500)])))).status).toBe(200);
        expect(await env.DB.prepare("SELECT reinstated_cents AS r,resolved_at FROM payment_disputes WHERE dispute_id='dp_i7r'").first()).toEqual({ r: 0, resolved_at: null });
        expect(await alertOpen("refund.dispute_returned_lowered")).toBe(1);
        expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE id LIKE 'disputerest:%' AND done_at IS NULL")).toBe(1);
        await advance();
        expect(refundPosts()).toEqual([1900]); // held: the returned money is unknown again
        // Ops records the lower amount the bank now keeps: $20. The remainder pays the $10 difference.
        expect((await send("/v1/admin/disputes/dp_i7r/resolve-returned", { body: { returnedCents: 2000, evidence: "bank statement 2026-11 line 3: CAD 13.70 = USD 10.00 back", by: "ops-sean" }, headers: admin })).status).toBe(200);
        await advance(); await advance();
        expect(refundPosts()).toEqual([1900, 1000]);
      });

      const restRows = () => env.DB.prepare("SELECT id,amount_cents AS a,done_at IS NOT NULL AS done FROM refund_ops WHERE id LIKE 'disputerest:%' ORDER BY id").all().then((x) => x.results);
      /** $49 paid, $30 exact loss, $19 refunded and completed as final past the 120-day window. */
      const finalAt19 = async (id: string) => {
        await heldRefund(id);
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj(id, "lost", [withdrawn(`txn_${id}_w`, 3000)], 3000)))).status).toBe(200);
        await advance();
        expect(refundPosts()).toEqual([1900]);
        later = NOW + 121 * DAY;
        await advance();
        expect(await opRow()).toMatchObject({ a: 1900, done: 1 });
      };
      const keeps = (id: string, back: number[]) => hook(disputeEvent("charge.dispute.funds_reinstated",
        disputeObj(id, "lost", [withdrawn(`txn_${id}_w`, 3000), ...back.map((c, i) => reinstated(`txn_${id}_r${i}`, c))], 3000)));

      it("INTEGRATED-8 P1 second reinstatement while the remainder is SUBMITTED: back to $20 kept opens $10; down to $10 kept while it is in flight: its completion opens the next $10; never twice", async () => {
        await finalAt19("dp_i8s");
        expect((await keeps("dp_i8s", [1000])).status).toBe(200);
        refundStatus = "pending";
        await advance(); await advance();
        expect(refundPosts()).toEqual([1900, 1000]);
        const opId = (await opRow())!.id;
        expect(await restRows()).toEqual([{ id: `disputerest:${opId}:1`, a: 1000, done: 0 }]);
        // The bank gives another $10 back while remainder 1 is submitted: nothing may open beside it.
        expect((await keeps("dp_i8s", [1000, 1000])).status).toBe(200);
        expect(await restRows()).toHaveLength(1);
        // Remainder 1 completes: before the fix the parent was never re-judged ($10 owed, zero pending operations).
        refundStatus = "succeeded"; for (const r of refundsMade) r.status = "succeeded";
        await advance();
        expect(await restRows()).toEqual([{ id: `disputerest:${opId}:1`, a: 1000, done: 1 }, { id: `disputerest:${opId}:2`, a: null, done: 0 }]);
        await advance(); await advance();
        expect(refundPosts()).toEqual([1900, 1000, 1000]);
        expect(await restRows()).toEqual([{ id: `disputerest:${opId}:1`, a: 1000, done: 1 }, { id: `disputerest:${opId}:2`, a: 1000, done: 1 }]);
        await advance(); await advance();
        expect(refundPosts()).toEqual([1900, 1000, 1000]); // never twice: $39 refunded + $10 the bank keeps = $49 paid
        expect(await env.DB.prepare("SELECT decided_cents FROM refund_invoice_ledger WHERE invoice_id='in_1'").first()).toEqual({ decided_cents: 3900 });
        expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE done_at IS NULL")).toBe(0);
      });

      it("INTEGRATED-8 P1 repeated reductions BEFORE remainder submission and AFTER its completion: each fall is paid exactly once (combined cap)", async () => {
        await finalAt19("dp_i8b");
        // Two falls before the remainder is decided: it decides the whole $20 at once.
        expect((await keeps("dp_i8b", [1000])).status).toBe(200);
        expect((await keeps("dp_i8b", [1000, 1000])).status).toBe(200);
        expect(await restRows()).toHaveLength(1);
        await advance(); await advance();
        expect(refundPosts()).toEqual([1900, 2000]);
        // A third fall after that remainder completed: a new remainder pays the last $10.
        expect((await keeps("dp_i8b", [1000, 1000, 1000])).status).toBe(200);
        await advance(); await advance();
        expect(refundPosts()).toEqual([1900, 2000, 1000]);
        await advance();
        expect(refundPosts()).toEqual([1900, 2000, 1000]);
        expect((await restRows()).map((r) => (r as { a: number }).a)).toEqual([2000, 1000]);
        expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE done_at IS NULL")).toBe(0);
      });

      it("INTEGRATED-7 P2 renewed inexact hold re-arms its alerts: resolved LOST + overdue alerts reopen as a new revision when a new movement invalidates the resolution", async () => {
        await heldRefund("dp_i7a");
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_i7a", "lost", [eur("txn_dp_i7a_w", -4500)])))).status).toBe(200);
        later = NOW + 6 * DAY;
        await advance();
        expect(await alertOpen("dispute.inexact_lost")).toBe(1);
        expect(await alertOpen("dispute.inexact_overdue")).toBe(1);
        expect((await send("/v1/admin/disputes/dp_i7a/resolve-returned", { body: { returnedCents: 3000, evidence: "bank statement 2026-10 line 14: CAD 41.10 = USD 30.00", by: "ops-sean" }, headers: admin })).status).toBe(200);
        expect(await alertOpen("dispute.inexact_lost")).toBe(0);
        expect(await alertOpen("dispute.inexact_overdue")).toBe(0);
        // A new movement in another currency invalidates the resolution: the hold is renewed, and so are both alerts (before: left resolved).
        expect((await hook(disputeEvent("charge.dispute.funds_reinstated", disputeObj("dp_i7a", "lost", [eur("txn_dp_i7a_w", -4500), eur("txn_dp_i7a_r", 1000)])))).status).toBe(200);
        expect(await env.DB.prepare("SELECT resolved_at FROM payment_disputes WHERE dispute_id='dp_i7a'").first()).toEqual({ resolved_at: null });
        expect(await alertOpen("dispute.inexact_lost")).toBe(1);
        expect(await alertOpen("dispute.inexact_overdue")).toBe(1);
        const lost = await env.DB.prepare("SELECT detail,delivered_at FROM cloud_alerts WHERE kind='dispute.inexact_lost'").first<{ detail: string; delivered_at: number | null }>();
        expect(JSON.parse(lost!.detail)).toMatchObject({ disputeId: "dp_i7a", revision: 1 });
        expect(lost!.delivered_at).toBeNull();
        expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind IN ('dispute.inexact_lost','dispute.inexact_overdue')")).toBe(2);
      });

      it("P1-2: an inexact loss before the first decision never decides anything (least of all zero): held undecided until resolved", async () => {
        const r = await askedNotDecided();
        expect((await hook(disputeEvent("charge.dispute.created", disputeObj("dp_r10u", "needs_response", [eur("txn_r10u_w", -4500)])))).status).toBe(200);
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r10u", "lost", [eur("txn_r10u_w", -4500)])))).status).toBe(200);
        stripeCalls = [];
        await execute({ requestId: r.requestId });
        await advance();
        expect(refundPosts()).toEqual([]);
        expect(await opRow()).toMatchObject({ a: null, decided: 0, e: "payment_dispute_inexact" });
      });

      it("P2-a: a LOST chargeback's credit adjustment has an applied receipt: alerted until applied (with evidence, for the amount owed now); a later reinstatement re-opens it", async () => {
        await heldRefund("dp_r10k");
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_r10k", "lost", [withdrawn("txn_r10k_w", 4900)])))).status).toBe(200);
        expect(await alertOpen("credit.dispute_reversal_owed")).toBe(1);
        const url = "/v1/admin/dispute-credit-obligations/dp_r10k/applied";
        // INTEGRATED-10: Flux off (launch): nothing to adjust, nothing read or written.
        expect((await send(url, { body: { token: crypto.randomUUID(), appliedCents: 4900, evidence: "Flux adjustment adj_123 (by hand)", by: "ops-sean" }, headers: admin })).status).toBe(503);
        expect((await creditOp(url, { token: crypto.randomUUID(), appliedCents: 4900, evidence: "Flux adjustment adj_123 (by hand)", by: "ops-sean" })).status).toBe(409); // no claim
        const { token } = await (await creditOp("/v1/admin/dispute-credit-obligations/dp_r10k/claim", { by: "ops-sean" })).json<{ token: string }>();
        expect((await creditOp(url, { token, appliedCents: 3000, evidence: "Flux adjustment adj_123 (by hand)", by: "ops-sean" })).status).toBe(409);
        expect((await creditOp(url, { token, appliedCents: 4900, evidence: "x", by: "ops-sean" })).status).toBe(400);
        expect((await creditOp(url, { token, appliedCents: 4900, evidence: "Flux adjustment adj_123 (by hand)", by: "ops-sean" })).status).toBe(200);
        expect(await env.DB.prepare("SELECT state,applied_returned_cents AS a,applied_by AS b,applied_evidence AS e FROM dispute_credit_obligations WHERE dispute_id='dp_r10k'").first())
          .toEqual({ state: "owed", a: 4900, b: "ops-sean", e: "Flux adjustment adj_123 (by hand)" });
        expect(await alertOpen("credit.dispute_reversal_owed")).toBe(0);
        expect((await hook(disputeEvent("charge.dispute.funds_reinstated", disputeObj("dp_r10k", "lost", [withdrawn("txn_r10k_w", 4900), reinstated("txn_r10k_r", 1500)])))).status).toBe(200);
        const detail = JSON.parse((await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='credit.dispute_reversal_owed' AND resolved_at IS NULL").first<{ detail: string }>())!.detail);
        expect(detail.obligations).toEqual([{ disputeId: "dp_r10k", invoiceId: "in_1", returnedCents: 3400, exact: 1, appliedCents: 4900 }]);
      });

      it("INTEGRATED-9 the dispute obligation never covers a B4 grant: its alert lists none and its receipt is never blocked by one; the B4 grant's share of the loss is its own ledger account's", async () => {
        await heldRefund("dp_i8k");
        const { refreshStatements, grantScope } = await import("../src/b4-flux-ledger");
        // A delivered B4 grant of the same invoice, with a revoke of it still open at the router.
        await env.DB.prepare(`INSERT INTO flux_grants (grant_id,entitlement_key,home_id,invoice_id,plan,amount_microcents,period_start,period_end,expires_at,status,attempts,created_at)
          VALUES ('g_b4','ek:g_b4',(SELECT home_id FROM billing_subscriptions LIMIT 1),'in_1','starter',100,0,1,?,'done',1,0)`).bind(Date.now() + 30 * 86_400_000).run();
        await env.DB.batch(refreshStatements(env.DB, grantScope("g_b4"), Date.now()));
        await env.DB.prepare(`INSERT INTO flux_grant_dispatches (dispatch_id,grant_id,kind,revision,target_microcents,claimed_at,expires_at)
          VALUES ('tok_open','g_b4','revoke',1,0,?,?)`).bind(Date.now(), Date.now() + 300_000).run();
        expect((await hook(disputeEvent("charge.dispute.closed", disputeObj("dp_i8k", "lost", [withdrawn("txn_i8k_w", 1000)], 1000)))).status).toBe(200);
        const detail = JSON.parse((await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='credit.dispute_reversal_owed' AND resolved_at IS NULL").first<{ detail: string }>())!.detail);
        // Before: the alert listed B4 grants for a hand adjustment that a B4 revoke could also make (both removing the same credit).
        expect(detail.obligations).toEqual([{ disputeId: "dp_i8k", invoiceId: "in_1", returnedCents: 1000, exact: 1, appliedCents: null }]);
        const url = "/v1/admin/dispute-credit-obligations/dp_i8k/applied";
        const { token } = await (await creditOp("/v1/admin/dispute-credit-obligations/dp_i8k/claim", { by: "ops-sean" })).json<{ token: string }>();
        expect((await creditOp(url, { token, appliedCents: 1000, evidence: "Flux adjustment adj_i8 (B5 grants, by hand)", by: "ops-sean" })).status).toBe(200);
        // The B4 grant's share of the loss is its ledger account's cause, adjusted only through its own claim (b4-flux-ledger.ts).
        await env.DB.batch(refreshStatements(env.DB, grantScope("g_b4"), Date.now()));
        expect(await env.DB.prepare("SELECT cause,ref,returned_cents FROM flux_grant_causes WHERE grant_id='g_b4'").all().then((r) => r.results))
          .toEqual([{ cause: "dispute_loss", ref: "dp_i8k", returned_cents: 1000 }]);
        expect(await env.DB.prepare("SELECT returned_cents,applied_microcents,router_state FROM flux_grant_accounts WHERE grant_id='g_b4'").first())
          .toEqual({ returned_cents: 1000, applied_microcents: 100, router_state: "delivered" });
      });
    });
  });
});

describe("journey A2 (Astra JOURNEY-A-3 #7): a lane-B-shaped quote composed through the whole intake keeps its ready-start window", () => {
  it("{deadline:null, startsWhenReady:true} reaches the stored request, the answer and the email as eligible and open", async () => {
    await paidUs(); signedIn = OWNER; notices = [];
    const laneB = async () => ({ eligible: true, reason: null, deadline: null, startsWhenReady: true, refundCents: 4900 });
    const res = await send("/v1/account/refund-request", { body: {} }, { ...deps(), refundIntakeQuote: laneB });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ eligible: true, status: "eligible", windowOpen: true, startsWhenReady: true, deadline: null });
    expect(await env.DB.prepare("SELECT eligible,window_open,deadline,pending_reasons FROM refund_requests").first())
      .toEqual({ eligible: 1, window_open: 1, deadline: null, pending_reasons: null });
    expect((notices.find((n) => n.kind === "refund_request_received")!.data as { emailText: string }).emailText).toContain("has not started yet");
    // Asked again: the stored answer keeps the flag.
    expect(await (await send("/v1/account/refund-request", { body: {} }, { ...deps(), refundIntakeQuote: laneB })).json())
      .toMatchObject({ alreadyRequested: true, eligible: true, windowOpen: true, startsWhenReady: true });
    // Every outcome shape carries it: nested window, a window_expired verdict against a window not started, and the lane A shape.
    const { requestWindow } = await import("../src/journey");
    expect(requestWindow({ eligible: true, reason: null, windowEndsAt: null, window: { deadline: null, startsWhenReady: true } }, NOW))
      .toEqual({ deadline: null, windowOpen: true, startsWhenReady: true, eligible: true });
    expect(requestWindow({ eligible: false, reason: "window_expired", deadline: null, startsWhenReady: true }, NOW))
      .toEqual({ deadline: null, windowOpen: true, startsWhenReady: true, eligible: true });
    expect(requestWindow({ eligible: false, reason: "identity_check_unavailable", deadline: null, startsWhenReady: true }, NOW))
      .toEqual({ deadline: null, windowOpen: true, startsWhenReady: true, eligible: false });
  });
});

describe("journey A2 (Astra JOURNEY-A-10 #2): a never-ready home's refund window starts when the server is ready, in production quoting", () => {
  const post = () => send("/v1/account/refund-request", { body: {} });
  const execute = (body: Record<string, unknown>) => send("/v1/admin/refund-first-month", { body, headers: admin });
  it("paid 10 days ago, never ready: the request is open and eligible, startsWhenReady, and the receipt says the window starts when the server is ready", async () => {
    await paidUs(); signedIn = OWNER;
    // Never ready: no ready_at, not a legacy-ready home, no ready email handed off. No readiness flag is injected anywhere.
    await env.DB.prepare("UPDATE cloud_homes SET ready_at=NULL,ready_legacy=0 WHERE id='home-1'").run();
    await env.DB.prepare("DELETE FROM billing_notices WHERE id='server_ready:home-1:first'").run();
    vi.mocked(Date.now).mockReturnValue(NOW + 10 * DAY);
    notices = [];
    const res = await post();
    expect(res.status).toBe(201);
    const body = await res.json() as { requestId: string };
    // The probe answered window_expired, startsWhenReady false and an expired-window receipt here.
    expect(body).toMatchObject({ eligible: true, status: "eligible", windowOpen: true, deadline: null, startsWhenReady: true, pendingReasons: [] });
    const text = (notices.find((n) => n.kind === "refund_request_received")!.data as { emailText: string }).emailText;
    expect(text).toContain("it starts when your server is first ready, so your request is inside it");
    expect(text).not.toMatch(/after the refund window|window_expired/);
    expect(await env.DB.prepare("SELECT eligible,deadline,window_open,pending_reasons FROM refund_requests WHERE id=?").bind(body.requestId).first())
      .toEqual({ eligible: 1, deadline: null, window_open: 1, pending_reasons: null });
    // The account answer agrees.
    expect(((await (await get("/v1/account/cloud")).json()) as { subscription: Record<string, unknown> }).subscription)
      .toMatchObject({ refundWindowEndsAt: null, refundWindowStartsWhenReady: true });
    // Execution, as of the receipt: the same window (open, starts when ready), so the refund is not refused as window_expired.
    vi.mocked(Date.now).mockReturnValue(NOW + 20 * DAY);
    expect(await (await execute({ requestId: body.requestId, dryRun: true })).json())
      .toMatchObject({ quote: { eligible: true, windowEndsAt: null, startsWhenReady: true, window: { deadline: null, startsWhenReady: true } } });
  });
});

describe("journey A2 (Astra JOURNEY-A-11 #2): a replacement during intake never mixes two payments into one receipt", () => {
  it("payment A (already refunded) captured, replacement B lands before the quote: A's own eligibility and A's snapshot are recorded", async () => {
    await paidUs(); signedIn = OWNER;
    const original = (await env.DB.prepare("SELECT subscription_id,consent_id FROM billing_subscriptions WHERE home_id='home-1'").first<{ subscription_id: string; consent_id: string | null }>())!;
    // Payment A was already refunded in full.
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,detail,created_at,updated_at,decided_at,done_at,amount_cents,target_cents,basis,notified_at)
      VALUES ('op-a-refunded','first_month','home-1',?,'in_1',0,'{}',?,?,?,?,4900,0,'seven_day_offer',?)`).bind(OWNER, NOW, NOW, NOW, NOW, NOW).run();
    // The replacement checkout (B) commits right after the intake read its payment (the probe's interleaving).
    let fired = false;
    const real = env.DB;
    envOver = { DB: new Proxy(real, { get(t, k) {
      if (k === "withSession") return undefined;
      if (k === "prepare") return (sql: string) => {
        const st = t.prepare(sql);
        if (!sql.includes("FROM cloud_homes h JOIN billing_subscriptions b ON b.home_id=h.id") || !sql.includes("ORDER BY h.desired_state='deleted', h.created_at DESC LIMIT 1")) return st;
        return new Proxy(st, { get(s0, k0) {
          if (k0 !== "bind") { const v = Reflect.get(s0, k0); return typeof v === "function" ? v.bind(s0) : v; }
          return (...a: unknown[]) => { const b = s0.bind(...a); return new Proxy(b, { get(b0, k1) {
            if (k1 !== "first") { const v = Reflect.get(b0, k1); return typeof v === "function" ? v.bind(b0) : v; }
            return async () => {
              const r = await b0.first();
              if (!fired) {
                fired = true;
                await t.prepare(`UPDATE billing_subscriptions SET subscription_id='sub_b',first_invoice_id='in_b',first_payment_intent='pi_b',first_paid_at=?,
                  status='active' WHERE home_id='home-1'`).bind(NOW + 1).run();
              }
              return r;
            };
          } }); };
        } });
      };
      const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v;
    } }) as D1Database };
    const res = await send("/v1/account/refund-request", { body: {} });
    envOver = {};
    expect(fired).toBe(true);
    expect(res.status).toBe(201);
    const body = await res.json() as { requestId: string; eligible: boolean; pendingReasons: string[] };
    // The probe recorded A as eligible:true using B's eligibility, with payment_snapshot NULL.
    expect([body.eligible, body.pendingReasons]).toEqual([false, ["already_refunded"]]);
    const row = (await env.DB.prepare("SELECT payment_key,eligible,consent_id,subscription_id,payment_snapshot FROM refund_requests WHERE id=?").bind(body.requestId)
      .first<{ payment_key: string; eligible: number; consent_id: string | null; subscription_id: string; payment_snapshot: string | null }>())!;
    expect([row.payment_key, row.eligible, row.consent_id, row.subscription_id]).toEqual(["in_1", 0, original.consent_id, original.subscription_id]);
    expect(row.payment_snapshot).not.toBeNull();
    expect(JSON.parse(row.payment_snapshot!)).toMatchObject({ invoiceId: "in_1", paidCents: 4900 });
  });
});

describe("journey A2 (Astra JOURNEY-B-1 #17): a window that starts when the server is ready is open", () => {
  it("deadline null with startsWhenReady is OPEN and eligible; deadline null without it stays unknown; a real deadline decides", async () => {
    const { requestWindow } = await import("../src/journey");
    expect(requestWindow({ eligible: true, reason: null, windowEndsAt: null, startsWhenReady: true }, NOW))
      .toEqual({ deadline: null, windowOpen: true, startsWhenReady: true, eligible: true });
    expect(requestWindow({ eligible: false, reason: "window_expired", windowEndsAt: null, startsWhenReady: true }, NOW))
      .toMatchObject({ windowOpen: true, eligible: true });
    expect(requestWindow({ eligible: false, reason: "already_refunded", windowEndsAt: null, startsWhenReady: true }, NOW))
      .toMatchObject({ windowOpen: true, eligible: false });
    expect(requestWindow({ eligible: false, reason: "no_first_payment", windowEndsAt: null }, NOW))
      .toEqual({ deadline: null, windowOpen: false, startsWhenReady: false, eligible: false });
    expect(requestWindow({ eligible: true, reason: null, windowEndsAt: NOW + DAY, startsWhenReady: false }, NOW)).toMatchObject({ deadline: NOW + DAY, windowOpen: true });
    expect(requestWindow({ eligible: false, reason: "window_expired", windowEndsAt: NOW - 1 }, NOW)).toMatchObject({ windowOpen: false, eligible: false });
  });
});

describe("journey A2 (Astra JOURNEY-A-1): intake says window and eligibility apart, from the canonical checks", () => {
  const post = () => send("/v1/account/refund-request", { body: {} });
  const mailText = () => (notices.find((n) => n.kind === "refund_request_received")!.data as { emailText: string }).emailText;
  it("an existing refund for the person is pending (not eligible) inside the window, and the email never says the window ended", async () => {
    await paidUs(); signedIn = OWNER; notices = [];
    await env.DB.prepare("INSERT INTO first_month_refunds (user_id,home_id,invoice_id,amount_cents,used_credit_cents,created_at) VALUES (?,?,?,?,0,?)")
      .bind(OWNER, "home-other", "in_other", 4900, NOW).run();
    const body = await (await post()).json() as { eligible: boolean; status: string; pendingReasons: string[]; windowOpen: boolean; deadline: number };
    expect(body).toMatchObject({ eligible: false, status: "pending", pendingReasons: ["already_refunded"], windowOpen: true });
    expect(body.deadline).toBeGreaterThan(NOW);
    expect(mailText()).toContain("arrived inside the refund window");
    expect(mailText()).not.toContain("ended");
    expect(mailText()).toContain("We still need to check a few things");
  });
  it("an abuse closure is never reported eligible", async () => {
    await paidUs(); signedIn = OWNER;
    expect((await send("/v1/admin/abuse-closure", { body: { homeId: "home-1", evidence: "evidenced abuse for this test" }, headers: admin })).status).toBe(200);
    expect(await (await post()).json()).toMatchObject({ eligible: false, status: "pending", pendingReasons: ["abuse_closure"], windowOpen: true });
  });
  it("after the deadline the window is closed and the email says so; a repeat answers the stored request", async () => {
    await paidUs(); signedIn = OWNER; notices = [];
    vi.mocked(Date.now).mockReturnValue(NOW + 20 * DAY);
    expect(await (await post()).json()).toMatchObject({ eligible: false, status: "pending", pendingReasons: ["window_expired"], windowOpen: false });
    expect(mailText()).toContain("after the refund window for your first payment ended");
    expect(await (await post()).json()).toMatchObject({ alreadyRequested: true, status: "pending", pendingReasons: ["window_expired"], windowOpen: false });
  });
});

describe("journey A3: top-up step-up exemption for off/lower (the handler checks the same rule)", () => {
  const strict = (): BillingDependencies => ({ ...deps(), stepUp: async () => false });
  const set = (body: Record<string, unknown>, d: BillingDependencies = strict()) => send("/v1/account/topup", { body: { amountUsd: 20, thresholdUsd: 5, capUsd: 100, ...body } }, d);
  const code = async (res: Response) => ((await res.json()) as { error?: string }).error ?? null;
  it("without a second factor, off and lower go through; switching on and every raise are refused by the handler itself", async () => {
    await paidUs(); signedIn = OWNER;
    // Today it is off (never enabled): switching it on needs the second factor, whatever the numbers.
    expect(await code(await set({ enabled: true }))).toBe("step_up_required");
    expect(await code(await set({ enabled: true, amountUsd: 5, thresholdUsd: 1, capUsd: 5 }))).toBe("step_up_required");
    expect(await count("SELECT COUNT(*) AS n FROM topup_settings WHERE enabled=1")).toBe(0);
    // With the second factor it goes on.
    expect((await set({ enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 }, deps())).status).toBe(200);
    // Lowering any of the three, or leaving them as they are, or turning it off: sign-in only.
    for (const lower of [{ amountUsd: 20, thresholdUsd: 5, capUsd: 100 }, { amountUsd: 15, thresholdUsd: 5, capUsd: 100 }, { amountUsd: 15, thresholdUsd: 4, capUsd: 100 },
      { amountUsd: 15, thresholdUsd: 4, capUsd: 60 }, { amountUsd: 10, thresholdUsd: 3, capUsd: 40 }]) {
      expect([lower, (await set({ enabled: true, ...lower })).status]).toEqual([lower, 200]);
    }
    // ...and now the "today" numbers are the lowered ones (10/3/40): a raise of any one is refused again.
    expect(await code(await set({ enabled: true, amountUsd: 11, thresholdUsd: 3, capUsd: 40 }))).toBe("step_up_required");
    expect(await code(await set({ enabled: true, amountUsd: 10, thresholdUsd: 4, capUsd: 40 }))).toBe("step_up_required");
    expect(await code(await set({ enabled: true, amountUsd: 10, thresholdUsd: 3, capUsd: 41 }))).toBe("step_up_required");
    expect(await env.DB.prepare("SELECT enabled,amount_cents,threshold_cents,cap_cents FROM topup_settings").first()).toEqual({ enabled: 1, amount_cents: 1000, threshold_cents: 300, cap_cents: 4000 });
    expect((await set({ enabled: false })).status).toBe(200);
    expect(await env.DB.prepare("SELECT enabled FROM topup_settings").first()).toEqual({ enabled: 0 });
    // Off again: enabling is an increase, even with the numbers it had.
    expect(await code(await set({ enabled: true, amountUsd: 10, thresholdUsd: 3, capUsd: 40 }))).toBe("step_up_required");
  });
  it("a raise still passes with the second factor, and the operator is not asked", async () => {
    await paidUs(); signedIn = OWNER;
    expect((await set({ enabled: true, amountUsd: 10, thresholdUsd: 3, capUsd: 40 }, deps())).status).toBe(200);
    expect((await set({ enabled: true, amountUsd: 30, thresholdUsd: 6, capUsd: 90 }, deps())).status).toBe(200);
    const op = await send("/v1/account/topup", { body: { homeId: "home-1", enabled: true, amountUsd: 50, thresholdUsd: 9, capUsd: 200 }, headers: admin }, strict());
    expect(op.status).toBe(200);
  });
  it("the rule: only off or no-higher-on-all-three is exempt", async () => {
    const { topupReduces } = await import("../src/legal-routes");
    await paidUs(); signedIn = OWNER;
    await set({ enabled: true }, deps());
    const rule = (b: Record<string, unknown>) => topupReduces(env, "home-1", { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100, ...b });
    expect(await rule({})).toBe(true);
    expect(await rule({ enabled: false, amountUsd: 500, capUsd: 2000 })).toBe(true);
    expect(await rule({ amountUsd: 21 })).toBe(false);
    expect(await rule({ thresholdUsd: 6 })).toBe(false);
    expect(await rule({ capUsd: 101 })).toBe(false);
    expect(await topupReduces(env, "no-such-home", { enabled: true, amountUsd: 5, thresholdUsd: 1, capUsd: 5 })).toBe(false);
  });
});

/** env.DB on which `before(sql)` runs once, just before the first statement (or batch) whose SQL contains `match` (journey race tests). */
function raceDb(match: string, before: () => Promise<unknown>): D1Database {
  let armed = true;
  const fire = async (sql: string) => { if (armed && sql.includes(match)) { armed = false; await before(); } };
  type Stmt = D1PreparedStatement & { __real?: D1PreparedStatement; __sql?: string };
  const wrap = (stmt: D1PreparedStatement, sql: string): Stmt => new Proxy(stmt as Stmt, {
    get(target, prop) {
      if (prop === "__real") return target;
      if (prop === "__sql") return sql;
      if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
      if (prop === "run" || prop === "first" || prop === "all" || prop === "raw") {
        return async (...args: unknown[]) => { await fire(sql); return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string](...args); };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "withSession") return undefined; // the worker would otherwise read and write through an unhooked D1 session (d1-session.ts)
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") return async (statements: Stmt[]) => { await fire(statements.map((x) => x.__sql ?? "").join(";\n")); return target.batch(statements.map((x) => x.__real ?? x)); };
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("journey A4 (Astra JOURNEY-A-1): the invoice email has an account budget, checked before Stripe", () => {
  const inv = (id: string) => ({ object: "invoice", id, number: `MRG-${id.slice(3)}`, created: NOW / 1000, total: 4900, currency: "usd", status: "paid",
    customer: "cus_test1", hosted_invoice_url: `https://invoice.stripe.test/i/${id}`, invoice_pdf: null });
  const strict = (): BillingDependencies => ({ ...deps(), stepUp: async () => false });
  const email = (id: string) => send(`/v1/account/invoices/${id}/email`, { body: {} }, strict());
  const lookups = () => stripeCalls.filter((c) => c.method === "GET" && /^\/v1\/invoices\/in_/.test(c.path)).length;
  it("at most 3 new emails an hour and 10 a day per account: the next one is 429 with retry-after, and Stripe is not asked", async () => {
    await paidUs(); signedIn = OWNER; notices = [];
    customerInvoices = Array.from({ length: 12 }, (_, i) => inv(`in_m${i}`));
    for (let i = 0; i < 3; i++) expect((await email(`in_m${i}`)).status).toBe(200);
    stripeCalls = [];
    const refused = await email("in_m3");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: "too_many_requests", retryAfterSeconds: 3600 });
    expect(refused.headers.get("retry-after")).toBe("3600");
    expect(lookups()).toBe(0);
    expect(notices.filter((n) => n.kind === "invoice_link")).toHaveLength(3);
    // A second press for an invoice already emailed this minute is the same email: it spends no budget and is not refused for it.
    expect((await email("in_m0")).status).toBe(429); // the hour's budget is used up: even the repeat is answered before Stripe
    // An hour later three more; the day stops at ten.
    for (const [h, ids] of [[1, [3, 4, 5]], [2, [6, 7, 8]], [3, [9]]] as const) {
      vi.mocked(Date.now).mockReturnValue(NOW + h * 3_600_000 + 1000);
      for (const i of ids) expect([i, (await email(`in_m${i}`)).status]).toEqual([i, 200]);
    }
    vi.mocked(Date.now).mockReturnValue(NOW + 3 * 3_600_000 + 2000);
    const day = await email("in_m10");
    expect(day.status).toBe(429);
    expect(Number(day.headers.get("retry-after"))).toBeGreaterThan(20 * 3600);
    expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='invoice_link'")).toBe(10);
  });
  it("requests are throttled too (10 an hour), before the Stripe lookup, even when they would all be the same email", async () => {
    await paidUs(); signedIn = OWNER; notices = [];
    customerInvoices = [inv("in_r1")];
    for (let i = 0; i < 10; i++) expect((await email("in_r1")).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='invoice_link'")).toBe(1);
    stripeCalls = [];
    const res = await email("in_r1");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(lookups()).toBe(0);
  });
});

describe("journey A3 (Astra JOURNEY-A-1): the step-up rule is enforced inside the home lease, against the settings the save replaces", () => {
  const strict = (): BillingDependencies => ({ ...deps(), stepUp: async () => false });
  it("a concurrent switch-off lands after the gate compared: the sign-in-only 'lower' request that would now switch it back on is 403 step_up_required", async () => {
    await paidUs(); signedIn = OWNER;
    expect((await send("/v1/account/topup", { body: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } })).status).toBe(200);
    // The gate (and any check before the lease) sees it ON at 20/5/100, so 15/5/100 is a lowering. Then, just before this request takes the
    // home's lease, another request switches the top-up off.
    envOver = { DB: raceDb("INSERT OR IGNORE INTO billing_home_leases", () => env.DB.prepare("UPDATE topup_settings SET enabled=0").run()) };
    const res = await send("/v1/account/topup", { body: { enabled: true, amountUsd: 15, thresholdUsd: 5, capUsd: 100 } }, strict());
    envOver = {};
    expect([res.status, ((await res.json()) as { error?: string }).error]).toEqual([403, "step_up_required"]);
    expect(await env.DB.prepare("SELECT enabled FROM topup_settings").first()).toEqual({ enabled: 0 });
    // With the second factor the same request is an enable and goes through; a real lowering still needs sign-in only.
    expect((await send("/v1/account/topup", { body: { enabled: true, amountUsd: 15, thresholdUsd: 5, capUsd: 100 } })).status).toBe(200);
    expect((await send("/v1/account/topup", { body: { enabled: true, amountUsd: 10, thresholdUsd: 5, capUsd: 100 } }, strict())).status).toBe(200);
  });
});

describe("journey A4: invoices (list under sign-in, email the hosted link, links directly only under step-up)", () => {
  const HOSTED = "https://invoice.stripe.test/i/in_a1";
  const PDF = "https://pay.stripe.test/in_a1/pdf";
  const inv = (id: string, over: Record<string, unknown> = {}) => ({ object: "invoice", id, number: `MRG-${id.slice(3)}`, created: NOW / 1000, total: 4900, currency: "usd", status: "paid",
    customer: "cus_test1", hosted_invoice_url: `https://invoice.stripe.test/i/${id}`, invoice_pdf: `https://pay.stripe.test/${id}/pdf`, ...over });
  const strict = (): BillingDependencies => ({ ...deps(), stepUp: async () => false });
  const list = (d: BillingDependencies = strict()) => send("/v1/account/invoices", { method: "GET" }, d);
  const invoiceCalls = () => stripeCalls.filter((c) => c.method === "GET" && c.path === "/v1/invoices");
  const seed = () => { customerInvoices = [inv("in_a1", { created: NOW / 1000 - 100 }), inv("in_a2", { created: NOW / 1000 }), inv("in_a3", { status: "draft" }), inv("in_b1", { customer: "cus_other" })]; };

  it("lists the customer's own non-draft invoices newest first as {id, number, date, amountCents, currency, status}, with no links", async () => {
    await paidUs(); signedIn = OWNER; seed(); stripeCalls = [];
    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>[];
    expect(body).toEqual([
      { id: "in_a2", number: "MRG-a2", date: isoDate(NOW), amountCents: 4900, currency: "usd", status: "paid" },
      { id: "in_a1", number: "MRG-a1", date: isoDate(NOW - 100_000), amountCents: 4900, currency: "usd", status: "paid" },
    ]);
    expect(JSON.stringify(body)).not.toContain("stripe.test");
    expect(invoiceCalls()[0].path).toBe("/v1/invoices");
  });
  it("caches the list for 60 seconds per account, then asks Stripe again", async () => {
    await paidUs(); signedIn = OWNER; seed(); stripeCalls = [];
    await list(); await list();
    expect(invoiceCalls()).toHaveLength(1);
    vi.mocked(Date.now).mockReturnValue(NOW + 59_000);
    await list();
    expect(invoiceCalls()).toHaveLength(1);
    vi.mocked(Date.now).mockReturnValue(NOW + 61_000);
    customerInvoices = [inv("in_a9")];
    expect(((await (await list()).json()) as { id: string }[]).map((i) => i.id)).toEqual(["in_a9"]);
    expect(invoiceCalls()).toHaveLength(2);
  });
  it("returns hostedInvoiceUrl and invoicePdf directly only under a fresh second factor, and never stores them", async () => {
    await paidUs(); signedIn = OWNER; seed();
    const stepped = await (await list(deps())).json() as Record<string, unknown>[];
    expect(stepped.find((i) => i.id === "in_a1")).toMatchObject({ hostedInvoiceUrl: HOSTED, invoicePdf: PDF });
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM invoice_list_cache").all()).results)).not.toContain("stripe.test");
    expect(JSON.stringify(await (await list()).json())).not.toContain("stripe.test"); // the next, unstepped call is the link-free list
  });
  it("needs sign-in, and a Stripe failure is a plain 503", async () => {
    await paidUs(); seed();
    expect((await list()).status).toBe(401);
    signedIn = OWNER;
    const down = async () => new Response(JSON.stringify({ error: { code: "api_error" } }), { status: 500 });
    const res = await list({ ...strict(), stripeFetch: down });
    expect([res.status, await res.json()]).toEqual([503, { error: "invoices_unavailable" }]);
    expect(await count("SELECT COUNT(*) AS n FROM invoice_list_cache")).toBe(0);
  });
  it("emails the hosted link to the verified address without a second factor, never to an address in the request, and never returns the link", async () => {
    await paidUs(); signedIn = OWNER; seed(); notices = [];
    const res = await send("/v1/account/invoices/in_a1/email", { body: {} }, strict());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, queued: false, invoiceId: "in_a1" });
    const mail = notices.filter((n) => n.kind === "invoice_link");
    expect(mail).toHaveLength(1);
    expect(mail[0].homeId).toBe("home-1");
    expect((mail[0].data as { emailText: string }).emailText).toContain(HOSTED);
    expect((mail[0].data as { emailSubject: string }).emailSubject).toContain("MRG-a1");
    // A second press in the same minute is the same notice (one recorded notice id, which the real notifier sends once); a later minute is a new one.
    await send("/v1/account/invoices/in_a1/email", { body: {} }, strict());
    expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='invoice_link'")).toBe(1);
    vi.mocked(Date.now).mockReturnValue(NOW + 120_000);
    await send("/v1/account/invoices/in_a1/email", { body: {} }, strict());
    expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE kind='invoice_link'")).toBe(2);
  });
  it("only the customer's own, finalized invoices can be emailed; a failed send is recorded and retried by the sweep", async () => {
    await paidUs(); signedIn = OWNER; seed(); notices = [];
    expect((await send("/v1/account/invoices/in_b1/email", { body: {} }, strict())).status).toBe(404); // another customer's
    expect((await send("/v1/account/invoices/in_a3/email", { body: {} }, strict())).status).toBe(404); // a draft
    expect((await send("/v1/account/invoices/in_missing/email", { body: {} }, strict())).status).toBe(404);
    expect((await send("/v1/account/invoices/not-an-invoice/email", { body: {} }, strict())).status).toBe(404);
    customerInvoices.push(inv("in_nolink", { hosted_invoice_url: null }));
    expect((await send("/v1/account/invoices/in_nolink/email", { body: {} }, strict())).status).toBe(409);
    expect((await send("/v1/account/invoices/in_a1/email", { method: "GET" }, strict())).status).toBe(405);
    signedIn = null;
    expect((await send("/v1/account/invoices/in_a1/email", { body: {} }, strict())).status).toBe(401);
    signedIn = OWNER; notifierFails = true;
    expect(await (await send("/v1/account/invoices/in_a1/email", { body: {} }, strict())).json()).toEqual({ sent: false, queued: true, invoiceId: "in_a1" });
    notifierFails = false;
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(notices.filter((n) => n.kind === "invoice_link")).toHaveLength(1);
  });
});

describe("the declared country is the Stripe customer's address before the session (staging: a TH buyer on a German checkout was first shown 19% VAT)", () => {
  // Astra TAXCOUNTRY-5: no checkout ever re-addresses an existing customer. A rewritable home is moved to a NEW customer created with the
  // declared location (its whole address), journaled before the call; protected customers are untouched as before. The round-3..5 tests of
  // the address-update journal (replay, in-flight bound, read reconciliation, read-back of a superseded writer) are replaced by the create
  // model's own: the expectations that changed are "the same customer is updated" -> "a new customer is created and the pointer moves to it",
  // and "a lost answer holds the next checkout" -> "the next checkout creates its own customer; the lost one becomes an orphan record".
  const managed = () => { envOver = { CLOUD_NONUS_SELLER: "managed_payments" } as Partial<Env>; };
  const posts = (path: string) => stripeCalls.filter((c) => c.method === "POST" && c.path === path);
  const sessionPost = () => posts("/v1/checkout/sessions").pop()!;
  const customerUpdates = () => stripeCalls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/customers/"));
  const creates = () => posts("/v1/customers").filter((c) => c.form.has("metadata[checkout_attempt]"));
  const errorOf = async (r: Response) => [r.status, (await r.json<{ error: string }>()).error];
  const presetRecord = async () => (await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key='tax_preset:home-1'").first<{ value: string }>())?.value ?? null;
  const journal = async () => (await env.DB.prepare("SELECT key,value FROM cloud_ops_state WHERE key LIKE 'tax_customer:%' ORDER BY key").all<{ key: string; value: string }>()).results;
  const orphans = async () => (await env.DB.prepare("SELECT key,value FROM cloud_ops_state WHERE key LIKE 'customer_orphan:%' ORDER BY key").all<{ key: string; value: string }>()).results
    .map((r) => ({ key: r.key, ...JSON.parse(r.value) as Record<string, unknown> }));
  const relocationMarker = async () => (await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key='tax_relocated:home-1'").first<{ value: string }>())?.value ?? null;
  const pointer = async () => (await env.DB.prepare("SELECT customer_id FROM billing_subscriptions WHERE home_id='home-1'").first<{ customer_id: string }>())!.customer_id;
  const addressOf = (id: string) => ((id === "cus_test1" ? customerIdentity : newCustomers[id]) as Record<string, unknown> | undefined)?.address as Record<string, unknown> | undefined;
  const age = () => env.DB.prepare("UPDATE cloud_ops_state SET value=json_set(value,'$.createdAt',?) WHERE key LIKE 'tax_customer:%'").bind(Date.now() - 11 * 60_000).run();
  /** A first checkout (customer created with DE), its session left to expire: the next checkout starts from that customer. */
  const firstDe = async () => {
    managed(); await reserve();
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true, postalCode: "10115" })).status).toBe(200);
    customerIdentity = { address: { country: "DE", postal_code: "10115", line1: "Unter den Linden 1", line2: null, city: "Berlin", state: null } };
    stripeCalls = [];
  };
  const berlin = { country: "DE", postal_code: "10115", line1: "Unter den Linden 1", line2: null, city: "Berlin", state: null };

  it("TH consumer, German checkout language, Managed Payments: the customer sent to Stripe carries TH and the postal code; the session names it", async () => {
    managed(); await reserve();
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
    const cust = posts("/v1/customers")[0].form;
    expect(cust.get("address[country]")).toBe("TH"); expect(cust.get("address[postal_code]")).toBe("10110");
    const f = sessionPost().form;
    expect(f.get("managed_payments[enabled]")).toBe("true"); expect(f.get("locale")).toBe("de"); expect(f.get("customer")).toBe("cus_test1");
    for (const k of MANAGED_FORBIDDEN) expect([...f.keys()].filter((x) => x === k || x.startsWith(`${k}[`))).toEqual([]);
  });

  it("DE consumer on Managed Payments: DE", async () => {
    managed(); await reserve();
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true, postalCode: "10115" })).status).toBe(200);
    expect(posts("/v1/customers")[0].form.get("address[country]")).toBe("DE");
    expect(posts("/v1/customers")[0].form.get("address[postal_code]")).toBe("10115");
    expect(sessionPost().form.get("managed_payments[enabled]")).toBe("true");
  });

  it("US direct path: the same customer address, and Stripe Tax reads it (automatic_tax with the customer; the entered address saved back)", async () => {
    await reserve();
    expect((await checkout("starter", { postalCode: "94105" })).status).toBe(200);
    const cust = posts("/v1/customers")[0].form;
    expect(cust.get("address[country]")).toBe("US"); expect(cust.get("address[postal_code]")).toBe("94105");
    const f = sessionPost().form;
    expect(f.get("managed_payments[enabled]")).toBe("false"); expect(f.get("customer")).toBe("cus_test1");
    expect(f.get("automatic_tax[enabled]")).toBe("true"); expect(f.get("customer_update[address]")).toBe("auto");
  });

  it("Astra TAXCOUNTRY-5: a rewritable customer is NEVER written: a NEW customer is created with the declared location as its whole address, journaled first, the pointer moved to it before the session; the old one kept (previous) and untouched", async () => {
    await firstDe();
    const log = vi.spyOn(console, "log");
    try {
      expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
      expect(customerUpdates()).toEqual([]); // no address write to any existing customer
      const [c] = creates();
      const consentId = await latestConsentId("home-1");
      expect(c.headers.get("idempotency-key")).toMatch(new RegExp(`^checkout-customer:${consentId}:\\d+$`));
      expect(Object.fromEntries(c.form)).toEqual({ "metadata[home_id]": "home-1", "metadata[consent_id]": consentId, "metadata[checkout_attempt]": c.headers.get("idempotency-key"),
        "address[country]": "TH", "address[postal_code]": "10110", ...(c.form.has("email") ? { email: c.form.get("email") } : {}) });
      expect(newCustomers.cus_new1.address).toEqual({ country: "TH", postal_code: "10110" });
      expect(stripeCalls.indexOf(c)).toBeLessThan(stripeCalls.indexOf(sessionPost()));
      expect(sessionPost().form.get("customer")).toBe("cus_new1");
      expect(await pointer()).toBe("cus_new1");
      expect(customerIdentity.address).toEqual(berlin); // the previous customer is untouched
      const prev = JSON.parse((await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key='customer_previous:home-1:cus_test1'").first<{ value: string }>())!.value);
      expect(prev).toMatchObject({ homeId: "home-1", customerId: "cus_test1", replacedBy: "cus_new1", consentId,
        evidence: { balance: 0, defaultPaymentMethod: false, defaultSource: false, liveSubscription: false, pendingInvoice: false, creditNotes: false } });
      expect(await journal()).toEqual([]); // settled in the switch batch
      // the receipt keeps only the declared country, the time and the lease generation (Astra TAXCOUNTRY-3 P3)
      const receipt = JSON.parse((await presetRecord())!);
      expect(Object.keys(receipt).sort()).toEqual(["at", "country", "generation"]);
      expect(JSON.stringify(receipt)).not.toContain("10110");
      const lines = log.mock.calls.map((x) => String(x[0])).filter((l) => l.includes("checkout customer switched"));
      expect(lines.map((l) => JSON.parse(l))).toEqual([{ message: "checkout customer switched to the declared location", homeId: "home-1", from: "cus_test1",
        to: "cus_new1", fromCountry: "DE", toCountry: "TH", requestId: null }]);
    } finally { log.mockRestore(); }
  });

  it("an existing customer already at the declared location is left alone (Stripe keeps the address the customer entered)", async () => {
    managed(); await reserve();
    expect((await checkout("starter", { billingCountry: "TH", postalCode: "10110" })).status).toBe(200);
    customerIdentity = { address: { country: "TH", postal_code: "10110", line1: "1 Silom Rd" } };
    stripeCalls = [];
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
    expect(stripeCalls.some((c) => c.method === "GET" && c.path === "/v1/customers/cus_test1")).toBe(true);
    expect(customerUpdates()).toHaveLength(0);
    expect(creates()).toHaveLength(0);
    expect(posts("/v1/checkout/sessions")).toHaveLength(1);
  });

  it("Astra TAXCOUNTRY-1 P1: the preset is REQUIRED: Stripe failing to answer refuses with 503 checkout_unavailable and no session", async () => {
    await firstDe();
    customerGetFails = 5;
    expect(await errorOf(await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" }))).toEqual([503, "checkout_unavailable"]);
    expect(posts("/v1/checkout/sessions")).toHaveLength(0);
    expect(creates()).toHaveLength(0);
    customerGetFails = 0;
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
    expect(addressOf(await pointer())).toMatchObject({ country: "TH" });
  });

  it("Astra TAXCOUNTRY-5: the pointer switch is a compare-and-set on the lease: the lease lost while Stripe created the customer: no session, the pointer unchanged; the sweep records the created customer as an ORPHAN (learnt by replaying its own key), never deleted", async () => {
    await firstDe();
    onCustomerUpdate = async () => {
      await env.DB.prepare("UPDATE billing_home_leases SET holder='winner',generation=generation+1,lease_until=? WHERE home_id='home-1'").bind(Date.now() + 120_000).run();
    };
    const res = await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" });
    expect(res.status).toBe(409);
    expect(creates()).toHaveLength(1);
    expect(posts("/v1/checkout/sessions")).toHaveLength(0);
    expect(await pointer()).toBe("cus_test1");
    const [row] = await journal();
    const key = creates()[0].headers.get("idempotency-key")!;
    expect(row.key).toBe(`tax_customer:home-1:${key}`);
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    await age();
    stripeCalls = [];
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(await journal()).toEqual([]);
    expect(await orphans()).toEqual([expect.objectContaining({ key: `customer_orphan:home-1:${key}`, homeId: "home-1", customerId: "cus_new1", idempotencyKey: key,
      reason: "answer_lost" })]);
    expect(creates().map((c) => c.headers.get("idempotency-key"))).toEqual([key]); // the replay: Stripe's saved answer, the same customer
    expect(newCustomerN).toBe(1);
    expect(stripeCalls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(await pointer()).toBe("cus_test1");
  });

  it("Astra TAXCOUNTRY-1 P2: a customer with a live subscription declared in another country is refused (409 country_mismatch_existing); nothing is rewritten or created", async () => {
    await firstDe();
    customerIdentity = { ...customerIdentity, subscriptions: { data: [{ status: "active" }] } };
    expect(await errorOf(await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" }))).toEqual([409, "country_mismatch_existing"]);
    expect(customerUpdates()).toHaveLength(0);
    expect(creates()).toHaveLength(0);
    expect(posts("/v1/checkout/sessions")).toHaveLength(0);
    expect((customerIdentity.address as Record<string, unknown>).city).toBe("Berlin");
  });

  it("Astra TAXCOUNTRY-1 P2: an open invoice holds the address the same way (409, untouched, nothing created)", async () => {
    await firstDe();
    pendingInvoices = [{ customer: "cus_test1", status: "open" }];
    expect(await errorOf(await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" }))).toEqual([409, "country_mismatch_existing"]);
    expect(customerUpdates()).toHaveLength(0);
    expect(creates()).toHaveLength(0);
  });

  it.each([
    ["a customer balance", () => { customerIdentity = { ...customerIdentity, balance: -500 }; }],
    ["a default payment method", () => { customerIdentity = { ...customerIdentity, invoice_settings: { default_payment_method: "pm_saved" } }; }],
    ["a default source", () => { customerIdentity = { ...customerIdentity, default_source: "card_saved" }; }],
    ["a credit note", () => { customerCreditNotes = [{ customer: "cus_test1" }]; }],
    // Astra TAXCOUNTRY-6 P2-b: an instrument attached WITHOUT being made a default (a SetupIntent), and a legacy source, hold the same way.
    ["an attached non-default card (SetupIntent)", () => { customerInstruments = [{ customer: "cus_test1", id: "pm_setup", kind: "pm" }]; }],
    ["an attached legacy source", () => { customerInstruments = [{ customer: "cus_test1", id: "card_legacy", kind: "source" }]; }],
  ] as [string, () => void][])("Astra TAXCOUNTRY-5 (b): a rewritable customer holding %s (the customer's own money or instrument) is never switched away from: 409 on another location, used as it is at the same one", async (_what, hold) => {
    await firstDe();
    hold();
    expect(await errorOf(await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" }))).toEqual([409, "country_mismatch_existing"]);
    expect([creates().length, customerUpdates().length, posts("/v1/checkout/sessions").length]).toEqual([0, 0, 0]);
    expect(await pointer()).toBe("cus_test1");
    stripeCalls = [];
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true, postalCode: "10115" })).status).toBe(200);
    expect([creates().length, sessionPost().form.get("customer")]).toEqual([0, "cus_test1"]);
  });

  it("Astra TAXCOUNTRY-2 P2: a live-subscription customer in the SAME country with a different postal code is refused (409, the location on file named); nothing is rewritten", async () => {
    await firstDe();
    customerIdentity = { ...customerIdentity, subscriptions: { data: [{ status: "active" }] } };
    const res = await checkout("starter", { billingCountry: "DE", earlyStart: true, postalCode: "80331" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "country_mismatch_existing", country: "DE", postalCode: "10115" });
    expect(customerUpdates()).toHaveLength(0);
    expect(creates()).toHaveLength(0);
    expect(customerIdentity.address).toEqual(berlin);
    expect(posts("/v1/checkout/sessions")).toHaveLength(0);
  });

  it("Astra TAXCOUNTRY-2 P2: a live-subscription customer at the SAME country and postal code keeps its address untouched and checks out", async () => {
    await firstDe();
    customerIdentity = { ...customerIdentity, subscriptions: { data: [{ status: "active" }] } };
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true, postalCode: "10 115" })).status).toBe(200);
    expect(customerUpdates()).toHaveLength(0);
    expect(creates()).toHaveLength(0);
    expect((customerIdentity.address as Record<string, unknown>).city).toBe("Berlin");
    expect(posts("/v1/checkout/sessions")).toHaveLength(1);
  });

  it("Astra TAXCOUNTRY-2 P2: a rewritable customer in the same country with another postal code: a new customer with the whole new address, the ZIP included", async () => {
    await firstDe();
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true, postalCode: "80331" })).status).toBe(200);
    expect(customerUpdates()).toHaveLength(0);
    expect(newCustomers.cus_new1.address).toEqual({ country: "DE", postal_code: "80331" });
    expect(sessionPost().form.get("customer")).toBe("cus_new1");
    expect(stripeCalls.indexOf(creates()[0])).toBeLessThan(stripeCalls.indexOf(sessionPost()));
  });

  it("Astra TAXCOUNTRY-5 (f): a create whose answer was lost refuses (503) and stays journaled, but never blocks: the next press creates its own customer under its own key and issues; the lost one is recorded as an orphan", async () => {
    await firstDe();
    customerCreateMode = "lost_applied";
    expect(await errorOf(await checkout("starter", { billingCountry: "FR", earlyStart: true, postalCode: "75001" }))).toEqual([503, "checkout_unavailable"]);
    const aKey = creates()[0].headers.get("idempotency-key")!;
    expect((await journal()).map((r) => r.key)).toEqual([`tax_customer:home-1:${aKey}`]);
    expect(JSON.parse((await journal())[0].value)).toMatchObject({ homeId: "home-1", idempotencyKey: aKey, body: creates()[0].form.toString(), fromCustomerId: "cus_test1" });
    expect(await pointer()).toBe("cus_test1");
    expect((await env.DB.prepare("SELECT holder FROM billing_home_leases WHERE home_id='home-1'").first<{ holder: string | null }>())!.holder).toBeNull();
    stripeCalls = [];
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
    const [own] = creates();
    expect(own.headers.get("idempotency-key")).not.toBe(aKey);
    expect(sessionPost().form.get("customer")).toBe("cus_new2");
    expect(await pointer()).toBe("cus_new2");
    expect(newCustomers.cus_new1.address).toEqual({ country: "FR", postal_code: "75001" }); // the lost one: unreferenced
    await age();
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(await orphans()).toEqual([expect.objectContaining({ customerId: "cus_new1", idempotencyKey: aKey })]);
    expect(await journal()).toEqual([]);
    expect(await pointer()).toBe("cus_new2");
  });

  it("Astra TAXCOUNTRY-5 P1 (verbatim): a US/90210 create is lost (still executing at Stripe); the customer pays on the customer created next with US/10001; the lost create then lands: it is an ORPHAN, the home's pointer is unaffected and the renewal address stays US/10001", async () => {
    await reserve();
    expect((await checkout("starter", { postalCode: "90001" })).status).toBe(200);
    customerIdentity = { address: { country: "US", postal_code: "90001", line1: "1 Main St", line2: null, city: "Los Angeles", state: "CA" } };
    customerCreateMode = "lost_inflight";
    stripeCalls = [];
    expect(await errorOf(await checkout("starter", { postalCode: "90210" }))).toEqual([503, "checkout_unavailable"]);
    const lostKey = creates()[0].headers.get("idempotency-key")!;
    expect(creates()[0].form.get("address[postal_code]")).toBe("90210");
    expect(await pointer()).toBe("cus_test1");
    // the next attempt is not held by the lost one: its own customer, US/10001, and the customer pays on it
    expect((await checkout("starter", { postalCode: "10001" })).status).toBe(200);
    const paidOn = await pointer();
    expect(paidOn).toBe("cus_new2");
    expect(sessionPost().form.get("customer")).toBe(paidOn);
    const paidAddress = { country: "US", postal_code: "10001", line1: "350 5th Ave", line2: null, city: "New York", state: "NY" };
    newCustomers[paidOn] = { ...newCustomers[paidOn], address: { ...paidAddress }, subscriptions: { data: [{ status: "active" }] } }; // Checkout saved the entered address
    for (const x of sessions) if (x.status === "open") x.status = "complete";
    expect((await sessionCompleted({ id: sessions[0].id, customer: paidOn, customer_details: { address: { country: "US", postal_code: "10001" } } })).status).toBe(200);
    expect(await env.DB.prepare("SELECT customer_id,subscription_id FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ customer_id: paidOn, subscription_id: "sub_test1" });
    // the lost create finishes executing at Stripe now: a NEW customer with 90210, referenced by nobody
    landCreate();
    expect(newCustomers.cus_new1.address).toEqual({ country: "US", postal_code: "90210" });
    expect(await pointer()).toBe(paidOn);
    expect(addressOf(paidOn)).toEqual(paidAddress); // what the renewal invoices of sub_test1 are taxed on: untouched
    await age();
    stripeCalls = [];
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(await orphans()).toEqual([expect.objectContaining({ customerId: "cus_new1", idempotencyKey: lostKey, homeId: "home-1" })]);
    expect(await pointer()).toBe(paidOn);
    expect(addressOf(paidOn)).toEqual(paidAddress);
    expect(customerUpdates()).toEqual([]);
    expect(stripeCalls.filter((c) => c.method === "DELETE")).toEqual([]);
    // accepted, nothing refunded, nothing charged twice
    expect(await env.DB.prepare("SELECT completed_at IS NOT NULL AS c,rejected_at FROM checkout_consents WHERE home_id='home-1' ORDER BY created_at DESC, rowid DESC LIMIT 1").first())
      .toEqual({ c: 1, rejected_at: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM refund_ops").first()).toEqual({ n: 0 });
  });

  it("Astra TAXCOUNTRY-5 (e): a completed session on a customer that is not this home's (not the pointer, not a previous customer, not an orphan of its attempts) is refused as unbound: tombstoned, the pointer never moved", async () => {
    await reserve();
    expect((await checkout("starter")).status).toBe(200);
    expect((await sessionCompleted({ customer: "cus_foreign" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT reason FROM rejected_subscriptions WHERE subscription_id='sub_test1'").first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT customer_id,subscription_id FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ customer_id: "cus_test1", subscription_id: null });
    const alert = await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE home_id='home-1' AND kind='checkout.rejected_consent'").first<{ detail: string }>();
    expect(alert!.detail).toContain("customer_not_bound");
  });

  it("Astra TAXCOUNTRY-5 (e): a completed session on a customer the home was moved away from, or on an orphan of its own attempts, is still this home's", async () => {
    await firstDe();
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
    expect(await pointer()).toBe("cus_new1");
    await env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES ('customer_orphan:home-1:k1',?)").bind(JSON.stringify({ homeId: "home-1", customerId: "cus_orphan9" })).run();
    const { homeKnowsCustomer } = await import("../src/b5-billing");
    expect(await homeKnowsCustomer(env, "home-1", "cus_new1")).toBe(true);
    expect(await homeKnowsCustomer(env, "home-1", "cus_test1")).toBe(true);
    expect(await homeKnowsCustomer(env, "home-1", "cus_orphan9")).toBe(true);
    expect(await homeKnowsCustomer(env, "home-1", "cus_foreign")).toBe(false);
    expect(await homeKnowsCustomer(env, "home-2", "cus_test1")).toBe(false);
    for (const x of sessions) if (x.status === "open") x.status = "complete";
    expect((await sessionCompleted({ id: sessions[0].id, customer: "cus_new1", customer_details: { address: { country: "TH" } } })).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM rejected_subscriptions").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT subscription_id FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ subscription_id: "sub_test1" });
  });

  it("Astra TAXCOUNTRY-5: receipts survive the switch: the account's invoice list reads the customer the home was moved away from as well as the new one", async () => {
    await firstDe();
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
    expect(await pointer()).toBe("cus_new1");
    const inv = (id: string, customer: string, created: number) => ({ object: "invoice", id, number: `MRG-${id.slice(3)}`, created, total: 4900, currency: "usd", status: "paid",
      customer, hosted_invoice_url: `https://invoice.stripe.test/i/${id}`, invoice_pdf: `https://pay.stripe.test/${id}/pdf` });
    customerInvoices = [inv("in_old", "cus_test1", NOW / 1000 - 100), inv("in_new", "cus_new1", NOW / 1000)];
    signedIn = OWNER;
    const res = await send("/v1/account/invoices", { method: "GET" }, { ...deps(), stepUp: async () => false });
    expect(res.status).toBe(200);
    expect((await res.json() as { id: string }[]).map((i) => i.id)).toEqual(["in_new", "in_old"]);
  });

  it("Astra TAXCOUNTRY-3 P1 (c): the create journal cannot be written: NO Stripe call is made (503), and the home is free for the retry", async () => {
    await firstDe();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await env.DB.prepare("CREATE TRIGGER tax_journal_down BEFORE INSERT ON cloud_ops_state WHEN NEW.key LIKE 'tax_customer:%' BEGIN SELECT RAISE(ABORT, 'd1 unavailable'); END").run();
    try {
      expect(await errorOf(await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" }))).toEqual([503, "checkout_unavailable"]);
    } finally { await env.DB.prepare("DROP TRIGGER IF EXISTS tax_journal_down").run(); }
    expect(creates()).toHaveLength(0);
    expect(posts("/v1/checkout/sessions")).toHaveLength(0);
    expect(await pointer()).toBe("cus_test1");
    expect((await env.DB.prepare("SELECT holder FROM billing_home_leases WHERE home_id='home-1'").first<{ holder: string | null }>())!.holder).toBeNull();
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
    expect(addressOf(await pointer())).toMatchObject({ country: "TH" });
  });

  it("Astra TAXCOUNTRY-3 P2-b: an identical submission whose open session was made on a customer at another location is NOT reused: the home is moved to a new customer, that session expired, a fresh one issued on the new customer", async () => {
    managed(); await reserve();
    const first = await (await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).json<{ sessionId: string }>();
    // A pre-fix session: the customer was on DE when it was made (and is still).
    customerIdentity = { address: { country: "DE", postal_code: "10115", city: "Berlin" } };
    stripeCalls = [];
    const again = await (await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).json<{ sessionId: string; reused?: boolean }>();
    expect(again.reused).toBeUndefined();
    expect(again.sessionId).not.toBe(first.sessionId);
    const [c] = creates();
    const x = posts(`/v1/checkout/sessions/${first.sessionId}/expire`)[0];
    expect(stripeCalls.indexOf(c)).toBeLessThan(stripeCalls.indexOf(x));
    expect(stripeCalls.indexOf(x)).toBeLessThan(stripeCalls.indexOf(sessionPost()));
    expect(sessionPost().form.get("customer")).toBe("cus_new1");
    expect(sessions.find((z) => z.id === first.sessionId)!.status).toBe("expired");
    // the fresh session's publication clears the relocation marker; the next identical press reuses IT (no second customer)
    expect(await relocationMarker()).toBeNull();
    expect(await (await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).json()).toMatchObject({ sessionId: again.sessionId, reused: true });
    expect(newCustomerN).toBe(1);
  });

  it("Astra TAXCOUNTRY-5: a definitive refusal of the create (a 4xx answer) created nothing: its journal row is settled at once and the home is free", async () => {
    await firstDe();
    customerCreateMode = "refused";
    expect(await errorOf(await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" }))).toEqual([503, "checkout_unavailable"]);
    expect(await journal()).toEqual([]);
    expect(await relocationMarker()).toBeNull();
    expect(await pointer()).toBe("cus_test1");
    expect((await env.DB.prepare("SELECT holder FROM billing_home_leases WHERE home_id='home-1'").first<{ holder: string | null }>())!.holder).toBeNull();
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
  });

  it("Astra TAXCOUNTRY-2 P3: the acknowledged preset is deleted when the session completes", async () => {
    await firstDe();
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
    expect(await presetRecord()).not.toBeNull();
    await sessionCompleted({ id: sessions[0].id, customer: await pointer() });
    expect(await presetRecord()).toBeNull();
  });

  it("Astra TAXCOUNTRY-3 P3: the receipt is deleted when the session expires", async () => {
    await firstDe();
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
    expect(await presetRecord()).not.toBeNull();
    const consentId = await latestConsentId("home-1");
    expect((await hook(stripeEvent("checkout.session.expired", { object: "checkout.session", id: sessions[0].id, mode: "subscription",
      customer: await pointer(), client_reference_id: "home-1", created: NOW / 1000, metadata: { home_id: "home-1", consent_id: consentId } }))).status).toBe(200);
    expect(await presetRecord()).toBeNull();
  });

  it("Astra TAXCOUNTRY-3 P3: the receipt is deleted when the order is rejected (the collected country is not the declared one)", async () => {
    await firstDe();
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
    expect(await presetRecord()).not.toBeNull();
    await sessionCompleted({ id: sessions[0].id, customer: await pointer(), customer_details: { address: { country: "DE" } } });
    expect((await env.DB.prepare("SELECT rejected_at FROM checkout_consents WHERE home_id='home-1' ORDER BY created_at DESC, rowid DESC LIMIT 1").first<{ rejected_at: number | null }>())!.rejected_at).not.toBeNull();
    expect(await presetRecord()).toBeNull();
  });

  it("Astra TAXCOUNTRY-3 P3: the billing sweep deletes receipts, relocation markers and retired address-update rows older than 48 hours (newer ones kept) and records an abandoned create as an orphan", async () => {
    await firstDe();
    customerCreateMode = "lost_applied";
    expect(await errorOf(await checkout("starter", { billingCountry: "FR", earlyStart: true, postalCode: "75001" }))).toEqual([503, "checkout_unavailable"]);
    expect((await journal()).length).toBe(1);
    const old = Date.now() - 49 * 3_600_000, recent = Date.now() - 47 * 3_600_000;
    await env.DB.prepare(`INSERT INTO cloud_ops_state (key,value) VALUES ('tax_preset:home-old',?),('tax_relocated:home-old',?),('tax_preset:home-1',?),('tax_relocated:home-1',?),
      ('tax_dispatch:cus_old:taxpreset:x',?),('tax_dispatch:cus_new:taxpreset:y',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .bind(JSON.stringify({ country: "FR", at: old, generation: 1 }), JSON.stringify({ customerId: "cus_old", at: old }),
        JSON.stringify({ country: "FR", at: recent, generation: 2 }), JSON.stringify({ customerId: "cus_test1", at: recent }),
        JSON.stringify({ homeId: "home-old", createdAt: old, body: "address%5Bpostal_code%5D=75001" }), JSON.stringify({ homeId: "home-1", createdAt: recent, body: "x" })).run();
    await age();
    stripeCalls = [];
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    const keys = (await env.DB.prepare("SELECT key FROM cloud_ops_state WHERE key LIKE 'tax_%' ORDER BY key").all<{ key: string }>()).results.map((r) => r.key);
    expect(keys).toEqual(["tax_dispatch:cus_new:taxpreset:y", "tax_preset:home-1", "tax_relocated:home-1"]);
    expect(await orphans()).toEqual([expect.objectContaining({ customerId: "cus_new1" })]);
    expect(customerUpdates()).toHaveLength(0);
  });
});

describe("Astra TAXCOUNTRY-6: historical and orphan customers stay routed (the ownership ledger); the settled rule, the recheck and the orphan lifecycle", () => {
  const managed = () => { envOver = { CLOUD_NONUS_SELLER: "managed_payments" } as Partial<Env>; };
  const creates = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/customers" && c.form.has("metadata[checkout_attempt]"));
  const errorOf = async (r: Response) => [r.status, (await r.json<{ error: string }>()).error];
  const pointer = async () => (await env.DB.prepare("SELECT customer_id FROM billing_subscriptions WHERE home_id='home-1'").first<{ customer_id: string }>())!.customer_id;
  const orphans = async () => (await env.DB.prepare("SELECT key,value FROM cloud_ops_state WHERE key LIKE 'customer_orphan:%' ORDER BY key").all<{ key: string; value: string }>()).results
    .map((r) => ({ key: r.key, ...JSON.parse(r.value) as Record<string, unknown> }));
  const journal = async () => (await env.DB.prepare("SELECT key FROM cloud_ops_state WHERE key LIKE 'tax_customer:%'").all()).results;
  const age = () => env.DB.prepare("UPDATE cloud_ops_state SET value=json_set(value,'$.createdAt',?) WHERE key LIKE 'tax_customer:%'").bind(Date.now() - 11 * 60_000).run();
  /** The event was handled under its home: processed, with an outcome that is not a routing failure (stripe_events.error keeps the outcome). */
  const eventError = async (id: string) => {
    const r = await env.DB.prepare("SELECT processed_at IS NOT NULL AS done, error FROM stripe_events WHERE id=?").bind(id).first<{ done: number; error: string | null }>();
    return { done: r?.done ?? 0, error: r?.error && /unresolved|home_changed|lease/.test(r.error) ? r.error : null };
  };
  const subDeleted = () => stripeEvent("customer.subscription.deleted", { object: "subscription", id: "sub_test1", customer: "cus_test1", status: "canceled",
    items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }, NOW / 1000 + 5);
  const reopen = async () => {
    await env.DB.prepare("UPDATE open_checkouts SET state='failed'").run();
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='payment_pending', entitlement='pending' WHERE id='home-1'").run();
  };
  /** The verbatim P1 sequence: C_old (cus_test1) paid, its subscription cancelled, zero balance, nothing held; the home is moved to C_new. */
  async function paidCancelledSwitched() {
    managed(); await reserve();
    const q = await quoteFor("starter", "DE", "10115");
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true }, q)).status).toBe(200);
    expect((await sessionCompleted({ currency: "eur", amount_total: 5390, total_details: { amount_tax: 900 }, customer_details: { address: { country: "DE" } } })).status).toBe(200);
    expect((await hook(stripeEvent("invoice.paid", invoice({ amount_paid: 5390, tax: 900 })))).status).toBe(200);
    expect((await hook(subDeleted())).status).toBe(200);
    await reopen();
    customerIdentity = { address: { country: "DE", postal_code: "10115", line1: "Unter den Linden 1", line2: null, city: "Berlin", state: null } };
    stripeCalls = [];
    expect((await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" })).status).toBe(200);
    expect(await pointer()).toBe("cus_new1");
    expect(JSON.parse((await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key='customer_home:cus_new1'").first<{ value: string }>())!.value))
      .toMatchObject({ homeId: "home-1", role: "attempt" });
    expect(JSON.parse((await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key='customer_home:cus_test1'").first<{ value: string }>())!.value))
      .toMatchObject({ homeId: "home-1" });
    stripeCalls = [];
  }

  it("P1: Link refunds C_old's charge after the switch: the charge.refunded webhook routes to the home and is reconciled on the old contract (never home_unresolved)", async () => {
    await paidCancelledSwitched();
    refundsMade.push({ id: "re_link_old", amount: 5390, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    const ev = stripeEvent("charge.refunded", { object: "charge", id: "ch_old", customer: "cus_test1", payment_intent: "pi_1", refunded: true, amount_refunded: 5390 });
    expect((await hook(ev)).status).toBe(200);
    expect(await eventError(ev.id)).toEqual({ done: 1, error: null });
    expect(await env.DB.prepare("SELECT kind, home_id AS h, subscription_id AS s, payment_intent AS p, amount_cents AS a FROM refund_ops").all().then((r) => r.results))
      .toEqual([{ kind: "external", h: "home-1", s: "sub_test1", p: "pi_1", a: 5390 }]);
    expect(await pointer()).toBe("cus_new1");
  });

  it("P1: a dispute of C_old's charge after the switch routes to the home (also from the pre-ledger previous-customer record alone)", async () => {
    await paidCancelledSwitched();
    // the pre-ledger shape: only customer_previous names C_old
    await env.DB.prepare("DELETE FROM cloud_ops_state WHERE key LIKE 'customer_home:%'").run();
    const ev = stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_old", charge: "ch_1", reason: "fraudulent" });
    expect((await hook(ev)).status).toBe(200);
    expect(await eventError(ev.id)).toEqual({ done: 1, error: null });
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ status: "disputed" });
  });

  it("P1: old-customer completion through its final webhooks: the subscription's end redelivered, and invoice / subscription / refund events of C_old's earlier contract (known only by its customer) are all handled under the home", async () => {
    await paidCancelledSwitched();
    // sub_gone: an earlier contract of C_old the home's record no longer names: these events resolve ONLY through the customer
    const outcomes: string[] = [];
    for (const ev of [subDeleted(),
      stripeEvent("invoice.payment_failed", invoice({ id: "in_gone", subscription: "sub_gone", customer: "cus_test1" })),
      stripeEvent("customer.subscription.updated", { object: "subscription", id: "sub_gone", customer: "cus_test1", status: "canceled",
        items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] } }),
      stripeEvent("charge.refunded", { object: "charge", id: "ch_old", customer: "cus_test1", payment_intent: "pi_1", refunded: false, amount_refunded: 0 })]) {
      const r = await hook(ev);
      const row = await env.DB.prepare("SELECT error FROM stripe_events WHERE id=?").bind(ev.id).first<{ error: string | null }>();
      expect([ev.type, r.status]).toEqual([ev.type, 200]);
      expect(await eventError(ev.id)).toEqual({ done: 1, error: null });
      outcomes.push(row?.error ?? "applied");
    }
    expect(outcomes.slice(1, 3)).toEqual(["foreign_subscription", "foreign_subscription"]);
    expect(await pointer()).toBe("cus_new1");
  });

  it("P1: a stray charge on an ORPHAN customer (a lost create the sweep recorded) is attributed to the home's attempt and handled", async () => {
    managed(); await reserve();
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true, postalCode: "10115" })).status).toBe(200);
    customerIdentity = { address: { country: "DE", postal_code: "10115" } };
    customerCreateMode = "lost_applied";
    expect(await errorOf(await checkout("starter", { billingCountry: "FR", earlyStart: true, postalCode: "75001" }))).toEqual([503, "checkout_unavailable"]);
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    await age();
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    const [o] = await orphans();
    expect(o).toMatchObject({ customerId: "cus_new1", homeId: "home-1" });
    expect(JSON.parse((await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key='customer_home:cus_new1'").first<{ value: string }>())!.value))
      .toMatchObject({ homeId: "home-1", role: "orphan", attempt: (o as Record<string, unknown>).idempotencyKey });
    const ev = stripeEvent("charge.refunded", { object: "charge", id: "ch_stray", customer: "cus_new1", refunded: false, amount_refunded: 0 });
    expect((await hook(ev)).status).toBe(200);
    expect(await eventError(ev.id)).toEqual({ done: 1, error: null });
    // a customer nobody knows still fails closed (retried), never handled under a guessed home
    const unknown = stripeEvent("charge.refunded", { object: "charge", id: "ch_x", customer: "cus_nobody", refunded: false, amount_refunded: 0 });
    expect((await hook(unknown)).status).toBe(500);
  });

  it("P2-a: a price-mismatch refund that ended sub_old never settles sub_new's completed session", async () => {
    await reserve();
    expect((await checkout("starter")).status).toBe(200);
    const [sql, binds] = refundOpInsert({ id: "op-pm-old", kind: "price_mismatch", homeId: "home-1", userId: OWNER, invoiceId: "in_old", paidCents: 4900, targetCents: 4900,
      endPlan: true, subscriptionId: "sub_old", inheritSubscription: false }, NOW);
    await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    const { completedSessionSettled } = await import("../src/b5-billing");
    expect(await completedSessionSettled(env, "home-1", { subscription: "sub_new", metadata: {} }, null)).toBe(false);
    expect(await completedSessionSettled(env, "home-1", { subscription: "sub_old", metadata: {} }, null)).toBe(true);
  });

  it.each([
    ["a SetupIntent's card", () => { customerInstruments.push({ customer: "cus_test1", id: "pm_race", kind: "pm" }); }],
    ["a credit note", () => { customerCreditNotes.push({ customer: "cus_test1" }); }],
  ] as [string, () => void][])("race: %s reaches the old customer while the new one is created: treated as a holder (409), the pointer stays, the new customer recorded as an orphan", async (_w, land) => {
    managed(); await reserve();
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true, postalCode: "10115" })).status).toBe(200);
    customerIdentity = { address: { country: "DE", postal_code: "10115" } };
    stripeCalls = [];
    onCustomerUpdate = async () => { land(); };
    expect(await errorOf(await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" }))).toEqual([409, "country_mismatch_existing"]);
    expect(creates()).toHaveLength(1);
    expect(await pointer()).toBe("cus_test1");
    expect(await orphans()).toEqual([expect.objectContaining({ customerId: "cus_new1", homeId: "home-1", reason: "holder_on_recheck" })]);
    expect(await journal()).toEqual([]);
    expect(stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions")).toHaveLength(0);
    expect(await env.DB.prepare("SELECT 1 FROM cloud_ops_state WHERE key LIKE 'customer_previous:%'").first()).toBeNull();
  });

  it("P2-d: ops lists the orphans with their age (operator only); one past 30 days raises the review alert, a fresh one does not", async () => {
    await reserve();
    const old = Date.now() - 31 * DAY;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?)").bind("customer_orphan:home-1:checkout-customer:c-old:1",
        JSON.stringify({ homeId: "home-1", consentId: "c-old", idempotencyKey: "checkout-customer:c-old:1", customerId: "cus_orph_old", createdAt: old, recordedAt: old, reason: "answer_lost" })),
      env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?)").bind("customer_orphan:home-1:checkout-customer:c-new:1",
        JSON.stringify({ homeId: "home-1", consentId: "c-new", idempotencyKey: "checkout-customer:c-new:1", customerId: "cus_orph_new", createdAt: Date.now(), recordedAt: Date.now(), reason: "answer_lost" })),
    ]);
    expect((await send("/v1/admin/customer-orphans", { method: "GET" })).status).toBe(401);
    const res = await send("/v1/admin/customer-orphans", { method: "GET", headers: admin });
    expect(res.status).toBe(200);
    const body = await res.json<{ orphans: { customerId: string; ageDays: number; overdue: boolean; reviewDueAt: number }[]; reviewAfterDays: number }>();
    expect(body.reviewAfterDays).toBe(30);
    // Astra TAXCOUNTRY-7 P2-e: oldest first (age order), one page here.
    expect(body.orphans.map((o) => [o.customerId, o.ageDays, o.overdue])).toEqual([["cus_orph_old", 31, true], ["cus_orph_new", 0, false]]);
    expect(body.orphans.find((o) => o.customerId === "cus_orph_old")!.reviewDueAt).toBe(old + 30 * DAY);
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    const alerts = (await env.DB.prepare("SELECT kind,detail FROM cloud_alerts WHERE kind='billing.customer_orphan_review'").all<{ kind: string; detail: string }>()).results;
    expect(alerts.map((a) => JSON.parse(a.detail).customerId)).toEqual(["cus_orph_old"]);
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined); // idempotent
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='billing.customer_orphan_review'")).toBe(1);
    // never deleted automatically
    expect(stripeCalls.filter((c) => c.method === "DELETE" && c.path.startsWith("/v1/customers"))).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_ops_state WHERE key LIKE 'customer_orphan:%'")).toBe(2);
  });
  it("Astra TAXCOUNTRY-7: recheck-failure recovery: a failed holds-nothing re-read is a retryable 503 that keeps the pointer; the retry switches", async () => {
    managed(); await reserve();
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true, postalCode: "10115" })).status).toBe(200);
    customerIdentity = { address: { country: "DE", postal_code: "10115" } };
    // The re-read of the old customer after the new one exists fails (Stripe unavailable once).
    onCustomerUpdate = async () => { customerGetFails = 1; };
    stripeCalls = [];
    expect(await errorOf(await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" }))).toEqual([503, "checkout_unavailable"]);
    expect(await pointer()).toBe("cus_test1");
    expect(stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions")).toHaveLength(0);
    // The journal row learnt the created customer: it is this home's (ledger) and will become an orphan record, never lost.
    expect(JSON.parse((await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key='customer_home:cus_new1'").first<{ value: string }>())!.value)).toMatchObject({ homeId: "home-1" });
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    const res = await checkout("starter", { billingCountry: "TH", checkoutLanguage: "de", postalCode: "10110" });
    expect(res.status).toBe(200);
    expect(await pointer()).toBe("cus_new2");
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    await age();
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect((await orphans()).map((o) => (o as Record<string, unknown>).customerId)).toEqual(["cus_new1"]);
  });

  it("Astra TAXCOUNTRY-7 P2-d: initial-create abandonment: a first customer whose answer was lost is journaled before the call and recorded as an orphan by the sweep", async () => {
    await reserve();
    firstCustomerLost = true;
    const res = await checkout("starter");
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await env.DB.prepare("SELECT customer_id FROM billing_subscriptions WHERE home_id='home-1'").first()).toBeNull();
    expect((await journal()).map((r) => (r as { key: string }).key)).toEqual(["tax_customer:home-1:cust:home-1"]);
    const sent = stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/customers");
    expect(sent.map((c) => c.form.get("metadata[customer_create]"))).toEqual(["cust:home-1"]);
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    await age();
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(await orphans()).toEqual([expect.objectContaining({ key: "customer_orphan:home-1:cust:home-1", customerId: "cus_test1", homeId: "home-1", reason: "answer_lost" })]);
    expect(await journal()).toEqual([]);
    // The customer is on the ownership ledger as the home's orphan: its events still route to the home.
    expect(JSON.parse((await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key='customer_home:cus_test1'").first<{ value: string }>())!.value))
      .toMatchObject({ homeId: "home-1", role: "orphan" });
    // The next attempt replays the same key, binds that customer and clears its orphan record.
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    expect((await checkout("starter")).status).toBe(200);
    expect(await pointer()).toBe("cus_test1");
    expect(await orphans()).toEqual([]);
  });

  it("Astra TAXCOUNTRY-8 P2-c (round 9b): A created, answer lost, no sweep, key pruned: the retry's customer B binds and A's outstanding journal becomes an orphan record (customer unknown), never deleted unrecorded", async () => {
    await reserve();
    firstCustomerLost = true;
    expect((await checkout("starter")).status).toBeGreaterThanOrEqual(500);
    expect((await journal()).map((r) => (r as { key: string }).key)).toEqual(["tax_customer:home-1:cust:home-1"]);
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    // The sweep never ran; Stripe pruned the key: the retry under the same key makes a NEW customer (no idempotent replay).
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    expect((await checkout("starter")).status).toBe(200);
    expect(await pointer()).toBe("cus_test1");
    expect(await journal()).toEqual([]);
    expect(await orphans()).toEqual([expect.objectContaining({ key: `customer_orphan:home-1:cust:home-1:earlier:${NOW + 60_000}`, customerId: null,
      reason: "earlier_create_unsettled", boundCustomerId: "cus_test1", homeId: "home-1", createdAt: NOW })]);
  });

  it("Astra TAXCOUNTRY-9 P2-c (round 10): repeated lost creates across key expiry: each attempt has its own journal row and key; the replayed answer binds ONLY its own row; the earlier execution stays an orphan for review", async () => {
    await reserve();
    firstCustomerKeys = {};
    // Create A under the base key: executed at Stripe, answer lost.
    firstCustomerLostApplied = 1;
    expect((await checkout("starter")).status).toBeGreaterThanOrEqual(500);
    expect((await journal()).map((r) => (r as { key: string }).key)).toEqual(["tax_customer:home-1:cust:home-1"]);
    // A's row ages past the replay window (Stripe may have pruned its key): never reused. The next attempt is a NEW create under a NEW key.
    await env.DB.prepare("UPDATE cloud_ops_state SET value=json_set(value,'$.createdAt',?) WHERE key='tax_customer:home-1:cust:home-1'").bind(Date.now() - 21 * 3_600_000).run();
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    firstCustomerLostApplied = 1;
    expect((await checkout("starter")).status).toBeGreaterThanOrEqual(500);
    const keys = (await journal()).map((r) => (r as { key: string }).key);
    expect(keys).toHaveLength(2);
    const bKey = keys.find((k) => k !== "tax_customer:home-1:cust:home-1")!;
    expect(bKey).toMatch(/^tax_customer:home-1:cust:home-1:r\d+$/);
    // The retry within B's window replays B's key: Stripe answers B's cached customer (Idempotent-Replayed) and only B's row is settled.
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    expect((await checkout("starter")).status).toBe(200);
    expect(await pointer()).toBe("cus_first2");
    expect((await journal()).map((r) => (r as { key: string }).key)).toEqual(["tax_customer:home-1:cust:home-1"]);
    expect(await orphans()).toEqual([]);
    expect(Object.keys(firstCustomerKeys)).toHaveLength(2); // never a third execution
    // A stays outstanding until the sweep records it: past the replay window, as an orphan with its customer unknown; never deleted unrecorded.
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(await journal()).toEqual([]);
    expect(await orphans()).toEqual([expect.objectContaining({ key: "customer_orphan:home-1:cust:home-1", customerId: null, reason: "key_expired_customer_unknown", homeId: "home-1" })]);
  });

  it("INTEGRATED-7 P2 sweeping restores expired create-key reuse: A swept into an orphan past its key's window; B gets a NEW key; B's orphan never overwrites A's", async () => {
    await reserve();
    firstCustomerKeys = {};
    // A under the base key: executed at Stripe (cus_first1), answer lost.
    firstCustomerLostApplied = 1;
    expect((await checkout("starter")).status).toBeGreaterThanOrEqual(500);
    expect((await journal()).map((r) => (r as { key: string }).key)).toEqual(["tax_customer:home-1:cust:home-1"]);
    // Past the replay window the sweep records A with its customer unknown and removes its journal row.
    await env.DB.prepare("UPDATE cloud_ops_state SET value=json_set(value,'$.createdAt',?) WHERE key='tax_customer:home-1:cust:home-1'").bind(Date.now() - 21 * 3_600_000).run();
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(await journal()).toEqual([]);
    const aRecord = (await orphans()).find((o) => (o as { key: string }).key === "customer_orphan:home-1:cust:home-1");
    expect(aRecord).toMatchObject({ customerId: null, reason: "key_expired_customer_unknown", idempotencyKey: "cust:home-1" });
    // Stripe prunes A's key. B: before the fix the base key was reused (no journal row left) and executed as new under A's identity.
    delete firstCustomerKeys!["cust:home-1"];
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    firstCustomerLostApplied = 1;
    expect((await checkout("starter")).status).toBeGreaterThanOrEqual(500);
    const keys = (await journal()).map((r) => (r as { key: string }).key);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^tax_customer:home-1:cust:home-1:r\d+$/);
    expect(Object.keys(firstCustomerKeys!)).toEqual([keys[0].slice("tax_customer:home-1:".length)]);
    // B's answer is lost too; the sweep records it under ITS OWN key, and A's record is untouched.
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    await age();
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    const all = await orphans();
    expect(all).toHaveLength(2);
    expect(all.find((o) => (o as { key: string }).key === "customer_orphan:home-1:cust:home-1")).toEqual(aRecord);
    expect(all.find((o) => (o as { key: string }).key !== "customer_orphan:home-1:cust:home-1")).toMatchObject({ customerId: "cus_first2", reason: "answer_lost" });
  });

  it("INTEGRATED-8 P2 replay uncached 400: A's lost create is replayed and answered a FRESH 400: A's row is kept (never deleted unrecorded); after key expiry the base key never executes again; the sweep records A", async () => {
    await reserve();
    firstCustomerKeys = {};
    firstCustomerLostApplied = 1;
    expect((await checkout("starter")).status).toBeGreaterThanOrEqual(500);
    expect((await journal()).map((r) => (r as { key: string }).key)).toEqual(["tax_customer:home-1:cust:home-1"]);
    // The retry replays A's key; Stripe answers an UNCACHED 400 (a fresh validation failure: says nothing about A's execution).
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    firstCustomerReplayError = "uncached";
    expect((await checkout("starter")).status).toBeGreaterThanOrEqual(400);
    expect((await journal()).map((r) => (r as { key: string }).key)).toEqual(["tax_customer:home-1:cust:home-1"]); // before the fix: deleted, no orphan
    // Key expiry: Stripe prunes A's key and A's row ages past the window. The next attempt is a NEW key; the base key never executes again.
    delete firstCustomerKeys!["cust:home-1"];
    await env.DB.prepare("UPDATE cloud_ops_state SET value=json_set(value,'$.createdAt',?) WHERE key='tax_customer:home-1:cust:home-1'").bind(Date.now() - 21 * 3_600_000).run();
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    expect((await checkout("starter")).status).toBe(200);
    expect(Object.keys(firstCustomerKeys!)).toHaveLength(1);
    expect(Object.keys(firstCustomerKeys!)[0]).toMatch(/^cust:home-1:r\d+$/);
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    await sweepBilling(baseEnv(envOver), deps()).catch(() => undefined);
    expect(await journal()).toEqual([]);
    expect(await orphans()).toEqual([expect.objectContaining({ key: "customer_orphan:home-1:cust:home-1", customerId: null, reason: "key_expired_customer_unknown", idempotencyKey: "cust:home-1" })]);
  });

  it("INTEGRATED-8 P2 replay cached 400 / timeout: a CACHED refusal settles A's row; a replay timing out keeps it", async () => {
    await reserve();
    firstCustomerKeys = {};
    firstCustomerLostApplied = 1;
    expect((await checkout("starter")).status).toBeGreaterThanOrEqual(500);
    // Replay times out: A unsettled.
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    firstCustomerLost = true;
    expect((await checkout("starter")).status).toBeGreaterThanOrEqual(500);
    expect((await journal()).map((r) => (r as { key: string }).key)).toEqual(["tax_customer:home-1:cust:home-1"]);
    // Stripe's cached (Idempotent-Replayed) refusal is the original execution's own answer: terminal, the row is settled.
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    firstCustomerReplayError = "cached";
    expect((await checkout("starter")).status).toBeGreaterThanOrEqual(400);
    expect(await journal()).toEqual([]);
  });

  it("INTEGRATED-7 P3 orphan queries use the age index: every page and sweep query walks cloud_ops_state_orphan_age with no temporary sort", async () => {
    const { ORPHAN_SQL } = await import("../src/b5-billing");
    const rows: D1PreparedStatement[] = [];
    for (let i = 0; i < 300; i++) {
      rows.push(env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?)").bind(`customer_orphan:home-p${i}:k`, JSON.stringify({ recordedAt: i, homeId: `home-p${i}` })));
      rows.push(env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?)").bind(`other-p:${i}`, "{}"));
    }
    for (let i = 0; i < rows.length; i += 100) await env.DB.batch(rows.slice(i, i + 100));
    const plan = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>())
      .results.map((r) => r.detail).join(" | ");
    for (const p of [await plan(ORPHAN_SQL.firstPage, 10), await plan(ORPHAN_SQL.nextPage, 5, "x", 10),
      await plan(ORPHAN_SQL.due("reviewAlertedAt"), 5, 10), await plan(ORPHAN_SQL.due("escalatedAt"), 5, 10)]) {
      expect(p).toContain("cloud_ops_state_orphan_age");
      expect(p).not.toMatch(/TEMP B-TREE/);
    }
  });

  it("Astra TAXCOUNTRY-7 P2-e: more than 1,000 orphans: every one is listed (oldest first, paged by cursor) and every overdue one alerted; 60 days escalate", async () => {
    const now = Date.now();
    const rows: D1PreparedStatement[] = [];
    for (let i = 0; i < 1105; i++) {
      // 1,100 overdue (31..40 days), 3 of them past 60 days, and 2 fresh; keys deliberately sort the OLDEST last.
      const ageDays = i < 1100 ? 31 + (i % 10) : 0;
      const at = now - (i < 3 ? 61 : ageDays) * DAY - i;
      const key = `customer_orphan:home-o${i % 4}:checkout-customer:c-${String(9999 - i).padStart(5, "0")}:1`;
      rows.push(env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?)").bind(key,
        JSON.stringify({ homeId: `home-o${i % 4}`, consentId: `c-${i}`, idempotencyKey: `checkout-customer:c-${i}:1`, customerId: `cus_o${i}`, createdAt: at, recordedAt: at, reason: "answer_lost" })));
    }
    for (let i = 0; i < rows.length; i += 100) await env.DB.batch(rows.slice(i, i + 100));
    const seen: { customerId: string; recordedAt: number }[] = [];
    let after: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const res = await send(`/v1/admin/customer-orphans?limit=400${after ? `&after=${encodeURIComponent(after)}` : ""}`, { method: "GET", headers: admin });
      expect(res.status).toBe(200);
      const body = await res.json<{ orphans: { customerId: string; recordedAt: number }[]; next: string | null; escalateAfterDays: number }>();
      expect(body.escalateAfterDays).toBe(60);
      seen.push(...body.orphans);
      after = body.next;
      if (!after) break;
    }
    expect(seen).toHaveLength(1105);
    expect(new Set(seen.map((o) => o.customerId)).size).toBe(1105);
    expect(seen.map((o) => o.recordedAt)).toEqual([...seen.map((o) => o.recordedAt)].sort((a, b) => a - b));
    expect(seen.slice(0, 3).map((o) => o.customerId).sort()).toEqual(["cus_o0", "cus_o1", "cus_o2"]);
    // The sweep reaches every overdue one, whatever their number (each pass continues where the last stopped).
    const { alertOverdueOrphans } = await import("../src/b5-billing");
    let passes = 0;
    while (await alertOverdueOrphans(env, now) > 0) passes++;
    expect(passes).toBeGreaterThan(5);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_ops_state WHERE key LIKE 'customer_orphan:%' AND json_extract(value,'$.reviewAlertedAt') IS NOT NULL")).toBe(1100);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_ops_state WHERE key LIKE 'customer_orphan:%' AND json_extract(value,'$.escalatedAt') IS NOT NULL")).toBe(3);
    expect(await count("SELECT COALESCE(SUM(json_extract(detail,'$.count')),0) AS n FROM cloud_alerts WHERE kind='billing.customer_orphan_review'")).toBe(1100);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='billing.customer_orphan_review'")).toBe(4);
    expect(await env.DB.prepare("SELECT severity,json_extract(detail,'$.count') AS c FROM cloud_alerts WHERE kind='billing.customer_orphan_overdue' ORDER BY home_id").all().then((r) => r.results))
      .toEqual([{ severity: "high", c: 1 }, { severity: "high", c: 1 }, { severity: "high", c: 1 }]);
    expect(await alertOverdueOrphans(env, now)).toBe(0);
    expect(stripeCalls.filter((c) => c.method === "DELETE" && c.path.startsWith("/v1/customers"))).toEqual([]);
  });
});

describe("Astra INTEGRATED-13 (reachable with Flux off): cancelling is never gated by a dispute hold", () => {
  const refund = (body: Record<string, unknown>) => send("/v1/admin/refund-first-month", { body, headers: admin });
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds").map((c) => Number(c.form.get("amount")));
  const subDeletes = () => stripeCalls.filter((c) => c.method === "DELETE" && c.path.startsWith("/v1/subscriptions/")).map((c) => c.path);
  const euPaid = async () => {
    await reserve();
    expect((await checkout("starter", { billingCountry: "DE", earlyStart: true })).status).toBe(200);
    await sessionCompleted({ customer_details: { address: { country: "DE" } } });
    await hook(stripeEvent("invoice.paid", invoice())); await reconcile(); await serviceUp();
  };
  /** Another customer's dispute whose charge cannot be attributed at all (Stripe down): ATTRIBUTION PENDING, so it holds every refund. */
  const unrelatedPendingHold = () => env.DB.prepare(`INSERT INTO dispute_holds (event_id,charge_id,dispute_id,event_type,held_at,scope_pending)
    VALUES ('evt_u13','ch_u13','dp_u13','charge.dispute.created',?,1)`).bind(NOW).run();
  const sweep = async (at: number) => {
    vi.mocked(Date.now).mockReturnValue(at);
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=0").run();
    await sweepBilling(baseEnv(envOver), deps());
  };
  /** Prepaid and spent credit are never read or touched (no credit use is read, nothing is revoked); Flux is off on this path. */
  const noCreditTouched = () => expect(fluxLog.filter((l) => l.hook === "used" || l.hook === "revoke")).toEqual([]);

  it("INTEGRATED-13 P1-2 an eligible EU 14-day refund that ends the plan, behind an UNRELATED attribution-pending hold: its eligibility is recorded and the contract is cancelled now; only the money waits; once the hold is released it is paid once and nothing is cancelled twice", async () => {
    await euPaid();
    await unrelatedPendingHold();
    vi.mocked(Date.now).mockReturnValue(NOW + 10 * DAY); // inside the 14 days
    stripeCalls = []; fluxLog = [];
    expect((await refund({ homeId: "home-1" })).status).toBeLessThan(500);
    const op = await env.DB.prepare(`SELECT end_plan,decided_at,canceled_at IS NOT NULL AS canceled,last_error,json_extract(detail,'$.endEligibleAt') IS NOT NULL AS eligible
      FROM refund_ops WHERE id='eu14:in_1'`).first();
    // Before the fix: the decision threw before the end step existed: canceled_at stayed NULL and no cancellation call was made.
    expect(op).toEqual({ end_plan: 1, decided_at: null, canceled: 1, last_error: "payment_dispute_hold", eligible: 1 });
    expect(subDeletes()).toEqual(["/v1/subscriptions/sub_test1"]);
    expect(refundPosts()).toEqual([]);
    // Still held on the next pass: nothing paid, nothing cancelled twice.
    await sweep(NOW + 10 * DAY + 3_600_000);
    expect(refundPosts()).toEqual([]);
    expect(subDeletes()).toHaveLength(1);
    // The operator closes the unrelated hold with evidence: the refund is decided and paid once, in full.
    expect((await send("/v1/admin/dispute-holds/evt_u13/close", { body: { by: "ops-sean", evidence: "Stripe dashboard: dispute dp_u13 is on another account's charge" },
      headers: admin })).status).toBe(200);
    await sweep(NOW + 10 * DAY + 2 * 3_600_000);
    expect(refundPosts()).toEqual([4900]);
    expect(await env.DB.prepare("SELECT basis,amount_cents FROM refund_ops WHERE id='eu14:in_1'").first()).toEqual({ basis: "eu_uk_full_refund", amount_cents: 4900 });
    await sweep(NOW + 10 * DAY + 3 * 3_600_000);
    expect(refundPosts()).toEqual([4900]);
    expect(subDeletes()).toHaveLength(1);
    noCreditTouched();
  });

  it("INTEGRATED-13 P1-2 ordinary cancellation is unaffected by the hold: the customer's cancel is recorded and acknowledged", async () => {
    await euPaid();
    await unrelatedPendingHold();
    signedIn = OWNER;
    const cancelled = await send("/v1/account/cancel-plan", { body: {} });
    expect([200, 202]).toContain(cancelled.status);
    expect(await count("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE home_id='home-1' AND cancel_intent_rev>0")).toBe(1);
    noCreditTouched();
  });
});
