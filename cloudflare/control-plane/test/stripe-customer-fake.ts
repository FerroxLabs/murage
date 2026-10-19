/** A Stripe customer as the test fakes keep it: POST /v1/customers/{id} PERSISTS what it sets (address fields, an empty string unsets one,
 *  and metadata), so a later GET reads it back (Astra TAXCOUNTRY-1: a fake that only acknowledges updates proves nothing). */
export interface FakeCustomer { address?: Record<string, string | null> | null; metadata?: Record<string, string>;
  subscriptions?: { data: { status: string }[] }; [k: string]: unknown }
export function applyCustomerForm(c: FakeCustomer, form: URLSearchParams): FakeCustomer {
  const out: FakeCustomer = { ...c };
  for (const [k, v] of form) {
    const a = k.match(/^address\[(\w+)\]$/);
    if (a) out.address = { ...(out.address ?? {}), [a[1]]: v === "" ? null : v };
    const m = k.match(/^metadata\[(\w+)\]$/);
    if (m) out.metadata = { ...(out.metadata ?? {}), [m[1]]: v };
  }
  return out;
}
/** A store of customers by id for a fake that had none: GET/POST /v1/customers/{id}, and GET /v1/invoices?customer=&status= (pending ones).
 *  Astra TAXCOUNTRY-3: POST /v1/customers/{id} under an idempotency key follows Stripe's idempotency (docs.stripe.com/api/idempotent_requests):
 *  the first EXECUTION of a key is stored and every later request under it gets the stored answer (Idempotent-Replayed: true) without
 *  executing again; a key still executing is answered 409 idempotency_key_in_use; a refusal before execution (a 400 validation error) is not
 *  stored. `nextUpdate` (one-shot) simulates the next update's fate: "lost_unsent" (the connection fails before Stripe sees it), "lost_applied"
 *  (executed, the answer lost), "lost_inflight" (Stripe still executing: held in `inflight` until land() applies it), "refused" (400).
 *  Astra TAXCOUNTRY-4 (test gaps): the rest of Stripe's documented idempotency (docs.stripe.com/api/idempotent_requests,
 *  docs.stripe.com/error-low-level):
 *  - PARAMETER COMPARISON: a key reused with different parameters is refused (400 idempotency_error) and recorded in `violations`, which
 *    every test can assert stays empty (our code must never produce one);
 *  - KEY PRUNING: Stripe keeps a key for AT LEAST 24 hours with no promised deadline; prune(key) forgets one, and a later request under it
 *    EXECUTES AS NEW (recorded in `executed`, like every execution);
 *  - CACHED vs UNCACHED errors: "error_cached" (execution began and failed: the 500 is stored and replayed for every later request under the
 *    key, nothing applied); "error_unsaved" (a 503 before execution: nothing stored, nothing applied, a replay executes); "error_after_apply"
 *    (applied and stored as 200, but the client got a 502 from the edge: an uncached 5xx that DID apply).
 *  `getFailFor` makes every GET of those customers fail (a persistent outage for them). */
/** Astra TAXCOUNTRY-5: a checkout never updates an existing customer's address any more; a rewritable home is moved to a NEW customer
 *  (POST /v1/customers carrying metadata[checkout_attempt]). This fake answers those creates (ids cus_new1, cus_new2, ...) with Stripe's
 *  idempotency (a key executes once, its saved answer is replayed; a key in flight is 409; parameters compared): `nextCreate` (one-shot)
 *  is the next create's fate ("lost_unsent", "lost_applied", "lost_inflight" held until landCreate(), "refused", "error_cached"), `onCreate`
 *  runs when one executes. A first customer (no attempt) is left to the test's own handler. GET /v1/customers/{id} answers balance 0 and no
 *  default payment method unless the stored customer says otherwise; GET /v1/credit_notes?customer= lists `creditNotes`. */
export function customerFake() {
  const s = {
    created: [] as { id: string; key: string | null; body: string }[],
    createN: 0,
    nextCreate: null as null | "lost_unsent" | "lost_applied" | "lost_inflight" | "refused" | "error_cached",
    onCreate: null as null | (() => Promise<void>),
    inflightCreate: null as null | { id: string; key: string; form: URLSearchParams },
    creditNotes: [] as { customer: string }[],
    /** Attached payment methods (GET /v1/payment_methods?customer=) and legacy sources (GET /v1/customers/{id}/sources), default or not. */
    paymentMethods: [] as { customer: string; id: string }[],
    sources: [] as { customer: string; id: string }[],
    /** The held in-flight create finishes executing at Stripe: the customer exists, its answer stored under its key. */
    landCreate() {
      const f = s.inflightCreate!; s.inflightCreate = null;
      s.customers[f.id] = applyCustomerForm({ email: f.form.get("email") }, f.form);
      s.byKey[f.key] = { status: 200, body: { id: f.id, object: "customer", ...s.customers[f.id] } };
      s.created.push({ id: f.id, key: f.key, body: f.form.toString() });
    },
    customers: {} as Record<string, FakeCustomer>,
    pendingInvoices: [] as { customer: string; status: string }[],
    getFails: 0,
    onUpdate: null as null | (() => Promise<void>),
    byKey: {} as Record<string, { status: number; body: unknown } | "inflight">,
    nextUpdate: null as null | "lost_unsent" | "lost_applied" | "lost_inflight" | "refused" | "error_cached" | "error_unsaved" | "error_after_apply",
    /** The parameters each stored key was executed with (Stripe compares them on reuse). */
    keyBody: {} as Record<string, string>,
    /** Requests that reused a key with DIFFERENT parameters (Stripe: 400 idempotency_error). Must stay empty. */
    violations: [] as { key: string; body: string }[],
    /** Every update Stripe EXECUTED (a fresh write, a pruned key's replay included), in order. */
    executed: [] as { id: string; key: string | null; body: string }[],
    getFailFor: new Set<string>(),
    /** Stripe pruned this key (at least 24 hours after its first use, no promised deadline): a later request under it executes as new. */
    prune(key: string) { delete s.byKey[key]; delete s.keyBody[key]; },
    inflight: null as null | { id: string; key: string; form: URLSearchParams },
    /** The held in-flight update finishes executing at Stripe: applied, its answer stored under its key. */
    land() {
      const f = s.inflight!; s.inflight = null;
      s.customers[f.id] = applyCustomerForm(s.customers[f.id] ?? {}, f.form);
      s.byKey[f.key] = { status: 200, body: { id: f.id, object: "customer", ...s.customers[f.id] } };
      s.executed.push({ id: f.id, key: f.key, body: f.form.toString() });
    },
    reset() { s.created = []; s.createN = 0; s.nextCreate = null; s.onCreate = null; s.inflightCreate = null; s.creditNotes = []; s.paymentMethods = []; s.sources = []; s.customers = {}; s.pendingInvoices = []; s.getFails = 0; s.onUpdate = null; s.byKey = {}; s.nextUpdate = null; s.inflight = null;
      s.keyBody = {}; s.violations = []; s.executed = []; s.getFailFor = new Set(); },
    async handle(method: string, url: URL, form: URLSearchParams, key: string | null = null): Promise<Response | null> {
      const j = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st });
      const m = url.pathname.match(/^\/v1\/customers\/([^/]+)$/);
      if (m && method === "GET") {
        if (s.getFails > 0 || s.getFailFor.has(m[1])) { if (!s.getFailFor.has(m[1])) s.getFails--; return j({ error: { code: "api_error" } }, 500); }
        return j({ id: m[1], object: "customer", email: null, balance: 0, invoice_settings: { default_payment_method: null }, default_source: null, ...(s.customers[m[1]] ?? {}) });
      }
      if (url.pathname === "/v1/customers" && method === "POST" && form.has("metadata[checkout_attempt]")) {
        const stored = key ? s.byKey[key] : undefined;
        if (key && stored !== undefined && s.keyBody[key] !== undefined && s.keyBody[key] !== form.toString()) {
          s.violations.push({ key, body: form.toString() });
          return j({ error: { type: "idempotency_error" } }, 400);
        }
        if (stored === "inflight") return j({ error: { code: "idempotency_key_in_use", type: "idempotency_error" } }, 409);
        if (stored) return new Response(JSON.stringify(stored.body), { status: stored.status, headers: { "idempotent-replayed": "true" } });
        const mode = s.nextCreate; s.nextCreate = null;
        if (mode === "lost_unsent") throw new TypeError("fetch failed");
        if (mode === "refused") return j({ error: { code: "parameter_invalid", type: "invalid_request_error" } }, 400);
        if (key) s.keyBody[key] = form.toString();
        if (mode === "error_cached") {
          const err = { error: { type: "api_error", message: "An unknown error occurred" } };
          if (key) s.byKey[key] = { status: 500, body: err };
          return j(err, 500);
        }
        const id = `cus_new${++s.createN}`;
        if (mode === "lost_inflight") { if (key) s.byKey[key] = "inflight"; s.inflightCreate = { id, key: key ?? "", form }; throw new TypeError("fetch failed"); }
        s.customers[id] = applyCustomerForm({ email: form.get("email") }, form);
        s.created.push({ id, key, body: form.toString() });
        const body = { id, object: "customer", ...s.customers[id] };
        if (key) s.byKey[key] = { status: 200, body };
        if (s.onCreate) { const f = s.onCreate; s.onCreate = null; await f(); }
        if (mode === "lost_applied") throw new TypeError("fetch failed");
        return j(body);
      }
      if (url.pathname === "/v1/payment_methods" && method === "GET" && url.searchParams.has("customer")) {
        return j({ object: "list", data: s.paymentMethods.filter((p) => p.customer === url.searchParams.get("customer")) });
      }
      const src = url.pathname.match(/^\/v1\/customers\/([^/]+)\/sources$/);
      if (src && method === "GET") return j({ object: "list", data: s.sources.filter((p) => p.customer === src[1]) });
      if (url.pathname === "/v1/credit_notes" && method === "GET" && url.searchParams.has("customer")) {
        return j({ data: s.creditNotes.filter((n) => n.customer === url.searchParams.get("customer")) });
      }
      if (m && method === "POST") {
        const stored = key ? s.byKey[key] : undefined;
        if (key && stored !== undefined && s.keyBody[key] !== undefined && s.keyBody[key] !== form.toString()) {
          s.violations.push({ key, body: form.toString() });
          return j({ error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } }, 400);
        }
        if (stored === "inflight") return j({ error: { code: "idempotency_key_in_use", type: "idempotency_error" } }, 409);
        if (stored) return new Response(JSON.stringify(stored.body), { status: stored.status, headers: { "idempotent-replayed": "true" } });
        const mode = s.nextUpdate; s.nextUpdate = null;
        if (mode === "lost_unsent") throw new TypeError("fetch failed");
        if (mode === "refused") return j({ error: { code: "parameter_invalid", type: "invalid_request_error" } }, 400);
        if (mode === "error_unsaved") return j({ error: { type: "api_error", message: "upstream unavailable" } }, 503);
        if (key) s.keyBody[key] = form.toString();
        if (mode === "error_cached") {
          const err = { error: { type: "api_error", message: "An unknown error occurred" } };
          if (key) s.byKey[key] = { status: 500, body: err };
          return j(err, 500);
        }
        if (mode === "lost_inflight") { if (key) s.byKey[key] = "inflight"; s.inflight = { id: m[1], key: key ?? "", form }; throw new TypeError("fetch failed"); }
        s.customers[m[1]] = applyCustomerForm(s.customers[m[1]] ?? {}, form);
        s.executed.push({ id: m[1], key, body: form.toString() });
        const body = { id: m[1], object: "customer", ...s.customers[m[1]] };
        if (key) s.byKey[key] = { status: 200, body };
        if (mode === "error_after_apply") return j({ error: { type: "api_error", message: "bad gateway" } }, 502);
        if (s.onUpdate) { const f = s.onUpdate; s.onUpdate = null; await f(); }
        if (mode === "lost_applied") throw new TypeError("fetch failed");
        return j(body);
      }
      if (url.pathname === "/v1/invoices" && method === "GET" && url.searchParams.has("customer") && url.searchParams.has("status")) {
        return j({ data: s.pendingInvoices.filter((i) => i.customer === url.searchParams.get("customer") && i.status === url.searchParams.get("status")) });
      }
      return null;
    },
  };
  return s;
}
