# Murage control plane

This directory is an isolated Cloudflare Worker for cloud account identity,
installation ownership, and per-installation managed companion endpoints. It
does **not** store or move local bots, chats, desktop SQLite state, prompts, or
tool output.

## What is included

- Better Auth 1.7.1 with email OTP, signed bearer sessions, hashed OTP storage,
  and D1-backed IP plus recipient rate limits.
- A Cloudflare Email Sending binding that produces both HTML and plain-text OTP
  messages. Authentication responses remain generic even when delivery fails;
  email addresses, OTPs, secrets, and provider errors are never logged.
- Owner-scoped desktop installations and independently revocable
  `murage_install_…` credentials. Account bearer tokens are never accepted as
  installation credentials, or vice versa.
- Exact-origin CORS, bounded JSON bodies, redacted errors, and `no-store` on
  every response.
- One remotely managed Cloudflare Tunnel per installation. Its opaque public
  hostname routes to the Electron-owned gateway at `http://127.0.0.1:8812`
  (never the reusable LAN listener on `8810`) and is followed by a mandatory
  `http_status:404` catch-all. A proxied CNAME points to
  `<tunnel-id>.cfargotunnel.com`.
- D1-backed generation/lease claims, recovery by stable opaque tunnel name, and
  retryable partial cleanup. Cloudflare API credentials and raw connector
  tokens are never written to D1 or logs.
- The onboarding announcement signup, and the Sendlane write credentials it
  needs. These used to live in the desktop app, where `asar: true` made them
  readable by everyone who installed it; they are Worker secrets now and a
  desktop build carries only this Worker's URL.

The D1 schema is pinned in `migrations/`. `0001_better_auth_1_7_1.sql` was
generated from the exact Better Auth configuration. `0002_installations.sql`
contains only cloud ownership and credential metadata. `0003` adds a
recipient-scoped OTP limiter whose keys are HMACs rather than email addresses,
plus an authenticated installation-creation limiter. `0004` adds managed
endpoint resource IDs, lifecycle state, generation leases, redacted error
codes, and installation-scoped action limits. `0005` adds the cleanup-attempt
counter used for scheduled retry backoff. `0006` adds the announcement-signup
limiter, whose keys are HMACs of the address and of the caller rather than
either in plaintext. Endpoint rows deliberately do not
cascade away with a hard installation deletion: losing the tunnel and DNS IDs
would make operator cleanup impossible.

## API surface

| Method | Path | Authentication |
| --- | --- | --- |
| `GET` | `/healthz` | none |
| any | `/api/auth/*` | Better Auth |
| `GET` | `/v1/me` | account bearer |
| `GET`, `POST` | `/v1/installations` | account bearer |
| `POST` | `/v1/installations/:id/credentials/rotate` | owning account bearer |
| `DELETE` | `/v1/installations/:id` | owning account bearer |
| `GET` | `/v1/installations/self` | installation credential |
| `GET`, `POST`, `DELETE` | `/v1/installations/self/endpoint` | installation credential |
| `POST` | `/v1/announcements/subscribe` | none |

Installation registration requires a stable `clientInstanceId`, a display
`name`, and a `platform` of `darwin`, `windows`, or `linux`; `appVersion` is
optional. A client ID is unique among one account's active installations. After
revocation, that account may register the stable ID again. Other accounts may
independently use the same client ID. An account may have at most 100 active
installations, matching the complete management-list limit. Creation is also
limited to 100 attempts per account per hour.

Raw installation credentials contain a random lookup ID plus 32 random bytes.
Only a SHA-256 digest is stored, and the raw value is returned only when an
installation is created or its credential is rotated. Credentials expire after
90 days even if they are not revoked; the response includes their expiry so a
signed-in desktop can rotate ahead of time. `/v1/installations/self` rejects
expired credentials and records both credential use and installation
`lastSeenAt`. Rotations are serialized with a one-minute cooldown, so concurrent
requests cannot both return credentials while one invalidates the other.

### Legal flows (Murage Cloud checkout and account)

What the Cloud terms and `plans/cloud-legal/CHECKOUT.md` (site repo) promise, as routes. Code: `src/legal-flows.ts` (wording, dates, consent, tax quote, emails, refund maths), `src/legal-refunds.ts` (the refund ledger), `src/legal-routes.ts` (HTTP), migrations `0022_legal_flows.sql` and `0023_legal_fixes.sql`.

- `GET /v1/legal/disclosure?plan=` the renewal statement, box wording, dates and document versions. `POST /v1/legal/quote {plan,country,postalCode?,topupAmountUsd?}` (signed in) prices it with the Stripe Tax Calculations API for that address and returns the same disclosure with the total including tax, "due today" kept apart from the monthly total, and the top-up total. If Stripe Tax fails the quote answers `409 tax_unavailable`; the portal retries once, then says "We couldn't calculate tax just now. Please try again in a moment." There is no checkout without a quote (Sean, 2026-10-10: the fallback is gone), for an immediate and a delayed start alike.
- `POST /v1/billing/checkout` requires `consent` with `documentVersions` (the versions shown) and, when priced, `quoteId`. The server checks both boxes, the region, the versions in force, the quote (same user, plan, country, postal code, top-up amount, not expired) and the exact renewal text before anything is created; writes one `checkout_consents` record (including the frozen `disclosure` JSON, the quoted tax, claimed and observed IP/user agent in `client_meta`) and a `terms_acceptances` row; archives the exact document text. One open checkout per home (`open_checkouts`): the same choices reuse the session; changed choices expire every open session of the customer first; a completed session for the home blocks a new one. A second subscription that still completes is cancelled at Stripe and refunded in full through the ledger (`checkout.duplicate_subscription` alert).
- Activation gate, on every path (`checkout.session.completed` and `invoice.paid`): consent on record, checkout completed, durable confirmation handed off (`confirmation_sent_at`). Otherwise the event throws and is retried. The confirmation is built only from the archived document versions recorded with the consent (`loadAcceptedDocs`, hash-checked; missing or altered fails closed).
- Stripe's collected billing address is the authority. EU/EEA/UK with no start-now request is never started at once: the start is held to day 15 after the contract (`region_hold`), the subscription's trial moves there, and the checkout payment is refunded in full.
- Withdrawal (`POST /v1/account/withdraw`, EU/EEA/UK by Stripe's address, 14 days from the completed checkout) and the first-month refund (`POST /v1/admin/refund-first-month`) share one ledger (`refund_ops`): billing stops first; the amount is decided only when the payment is known (from our records, else Stripe's paid-invoice list, else a late `invoice.paid` resumes it) and is net of every earlier refund of the same payment; deductions count from `service_supplied_at`; a withdrawal that applies the 7-day offer uses the customer's one first-month refund. Each step is checkpointed and retried by the sweep; an ambiguous Stripe call is settled by the op id in refund metadata; `refund.stuck` alerts ops.
- `POST /v1/account/export-request`: refused once the home is `deleting`/`deleted`; one non-extendable 7-day pause per deletion cycle (a later request in the same cycle is accepted and answered but does not pause again); `reconcileB3` re-checks for an open request inside the batch that moves a home to `deleting`.
- `GET /v1/account/cloud` (My Cloud summary, `src/legal-routes.ts`): `subscription` carries `plan`, `planName`, `priceUsd`, `status`, `cancelAtPeriodEnd`, `activeUntil`, `ended`, `endedAt`, `refundWindowEndsAt`, `cancellation {state, endsAt, id, kind, keepable, keepIds}` and, from follow-up 1, `endedReason` and `refundState` (`src/plan-end-reason.ts`, derived from existing rows only). `endedReason` is `"setup_failed_refunded"` (setup was given up, `provision_attempts.gave_up_at`, and the payment is refunded in full), `"withdrawn"` (a withdrawal or the first-month refund ended it), `"cancelled"` (a public or in-app cancellation, or Delete my Cloud), `"dispute"` (a payment dispute; also reported for a disputed plan whose `ended` is still false), or `null` while the plan has not ended; when several apply, the earliest wins. `refundState` is `"pending"` while a refund operation that came with the end (`refund_ops.end_plan=1`, or a failed setup's queued `refund_required`) has not refunded yet, `"sent"` once Stripe refunded it (`refunded_at`), else `null`. A public or in-app cancellation whose plan ended earlier for one of these reasons is completed and superseded (`cancellation_requests.superseded_by = "plan_ended:<reason>"`) once Stripe's end is on record; its receipt and declared date never change, and the summary shows the real end (`endedAt`) and reason.
- `GET /v1/account/terms`, `POST /v1/account/terms/accept`: when a document changes, the sweep sends a 30-day notice with full copies; the account page asks for a fresh, logged acceptance at the next sign-in. Never accepted: at the effective date the plan is set not to renew (old terms run to the end of the paid period), with reminders 7 days before and at the end; accepting before then lifts it; a renewal is never an acceptance. Operator: `POST /v1/admin/abuse-closure {homeId, evidence}` (only an evidenced closure disqualifies the 7-day refund).
- Cron sweep: Stripe events and notices are retried with backoff and no attempt or age limit (alerts `billing.event_stuck`, `notice.undelivered`); notices are claimed atomically per id; yearly reminders run from `reminder_due_at` (no starvation); refund operations; top-up authorizations not yet applied.
- `src/legal-docs.generated.ts` comes from `node scripts/gen-legal-text.mjs <site (legal) dir> [out] [site-ref]` (TSX walker: tables, dates, links and shared components rendered; anything unknown fails). Re-run when the site terms change; the version id is a content hash.

Round 2 (Astra re-review of 0d3a289e0):
- Events about a subscription the home does not keep (a duplicate or repriced checkout) never change the home: `customer.subscription.updated/deleted`, `invoice.payment_failed` and `invoice.paid` check the subscription id.
- A refund is complete only when Stripe reports `succeeded`; `pending`/`requires_action` keep it open (re-checked hourly); `refund.updated`, `refund.failed` and `charge.refund.updated` are applied, and a failed or canceled refund reopens the obligation (`refund.failed` alert, new submission). The submission intent is written BEFORE each Stripe call with its own idempotency key (`refundop:<op>:<n>`) and `metadata[op_id]`/`metadata[submission]`; any unfinished submission is settled from Stripe's refund list by those ids, whatever the error counter says. One worker per operation (lease). Decisions for one payment serialize with a compare-and-swap on `refund_invoice_ledger`.
- The Stripe charge must equal the total including tax the customer agreed to (`quoted_total_cents`), checked at `checkout.session.completed` and, for a delayed start, at the first real invoice. A different total: subscription cancelled, payment refunded in full, checkout reopened, `checkout_repriced` email asking to check out again, `checkout.price_mismatch` alert.
- Withdrawal deductions count only `service_intervals`: from the lifecycle's ready state (canary passed) until the home stops being served.
- Only Stripe's confirmed `canceled` state (or a 404) counts as cancelled (`cancelConfirmed`); any other answer retries.
- The 30-day change notice is owed to everyone who accepted an earlier version, including a customer who already accepted the new one early.
- Email is AT-LEAST-ONCE: the database claim stops concurrent sends, but Cloudflare's `send_email` binding has no idempotency key, so a send whose answer was lost is sent again. Cloudflare rejects a custom `Message-ID` (`E_HEADER_NOT_ALLOWED`, the whole send fails), so none is set; an allowed `X-Notice-ID` header (a hash of the notice id) traces each delivery to its notice. Exactly-once needs a transport with a durable idempotency key; none is available on this binding.

Round 3 (Astra review of 2939441b7):
- Checkout completion claims the home's subscription atomically (`UPDATE ... WHERE subscription_id IS NULL OR = incoming OR status='canceled'`); a completion that loses the claim is a duplicate (cancelled and refunded). A checkout request whose creation was taken over by a newer one expires its own session (`409 checkout_superseded`). A `customer.subscription.updated` before completion adopts nothing.
- Refunds: before any new submission the ledger lists Stripe's refunds for the payment and adopts any refund carrying the operation's `op_id` that has not failed, so one obligation never has two live refunds; a refund event changes an operation only if it is the operation's current refund (an older attempt's late failure is `stale_refund_event`). Migration `0026` (data only, re-runnable) carries pre-0024 decided refunds into `refund_invoice_ledger` and marks unfinished pre-0024 operations for reconciliation.
- A customer's own cancellation (`customer_cancel_at`, also recorded when the plan is already set to end, and from a Stripe-portal `cancellation_requested`) is never lifted by accepting changed terms.
- Change notices: owed notices are queued (`terms_notice_obligations`) independently of delivery; each is delivered on its own with backoff and dead-lettered to ops (`terms.notice_dead`) after 8 tries. Terms enforcement is per customer with its own backoff and dead-letter (`terms.enforcement_dead`). Billing notices dead-letter after 20 tries (`notice.dead`); a confirmation is still sent by its own event retry. An existing customer can accept changed versions only after the notice was delivered (`409 notice_pending`; no prompt before it), and `GET /v1/account/terms` reports the `effective` versions separately: changed versions apply only from the notice's effective date, even if accepted early.
- Region hold: the trial move to day 15 is checkpointed (`trial_moved_at`); after the start date it is not retried (alert `consent.trial_move_failed`).
- SEAN'S DECISION (2026-10-10, replaces the earlier tax fallback): no checkout without a Stripe Tax quote. A failed quote is `409 tax_unavailable`; the portal retries once and then asks the customer to try again in a moment. The fallback consent, its Stripe-page confirmation box (`consent_collection`) and `fallback_confirmed_total_cents` are gone (the column stays, unused).

Round 4 (Astra review of 6bc5e037c): ONE per-home serializer (`src/billing-lease.ts`, the cloud-v2/b4 D1-lease pattern). Every billing operation for a home (Stripe events, refund operations, cancellation and renewal, terms non-renewal, the day-15 move, duplicate handling, the pre-day-15 total check) runs under `billing_home_leases`; intent is written before each Stripe call with an idempotency key derived from the operation (`refundop:<op>:<n>`, `cancelsync:<home>:<rev>:<state>`); a step completes only after Stripe reads back the end state (refund status, `cancel_at_period_end`, `trial_end`, the upcoming invoice); completion writes are fenced to the lease holder, so a holder that lost its lease records nothing and the next one reconciles from Stripe. Cancellation is a revisioned intent (`customer_cancel_at` + unlifted terms non-renewal → desired state; `cancel_intent_rev`/`cancel_synced_rev`). A refund keeps the same submission and key while its outcome is unknown. Ending operations are scoped to their subscription (`refund_ops.subscription_id`). Delayed starts bind `agreed_recurring_cents` (quote, or the fallback total confirmed on Stripe's page) and are checked against Stripe's upcoming invoice at checkout and again within 2 days of the first charge; a difference cancels before any charge and asks for re-consent.

Round 5 (Astra review of ff8cf45be): (1) FENCING: a lease token is `{homeId, holder, generation}` (migration `0028`); the clock is the database's; every write to a billing table goes through `fencedRun` / `fencedBatch` (the lease condition is part of the statement or of the batch's guard row), so a worker that lost its lease can finish a Stripe call but writes nothing (`LeaseLost`). `test/billing-fencing.test.ts` scans the billing modules and fails on any unfenced write (a short allowlist, each with its reason) and proves a stale holder's write changes nothing. Every path takes the home's lease: webhooks (a home that cannot be resolved is a retryable error, no unleased fallback), every sweep, the portal routes (busy: `409 home_busy`) and the admin routes. The live no-capacity refund is a refund operation (`kind no_capacity`); its outbox row and `refunded` entitlement complete only once Stripe says the refund succeeded. (2) Subscription mutations are a journal (`sub_mutations`): an outstanding mutation is reconciled (confirmed or superseded) before anything newer, a corrective mutation always gets its own row and key (`submut:<id>`), and the sweep re-reads Stripe against the customer's intent at least daily (at once after a superseded mutation) and corrects drift. (3) A refund operation cancels, resolves the payment of, and updates only its OWN captured `subscription_id`. (4) Region hold: the checkout-payment refund is opened and advanced first, independent of the day-15 move and the email; if the move cannot be confirmed and the start date has passed (or there is no quoted total) the subscription is cancelled, the refund stands, the checkout reopens and the customer is asked to check out again (`checkout.hold_abandoned`). (5) A preview is never consent: a delayed start requires a Stripe Tax quote (`409 tax_quote_required`), `agreed_recurring_cents` comes only from the quote, `invoice.created` deletes a draft first invoice that differs from the agreed total (and cancels the plan), and the pre-charge check now runs daily from 2 days before the start until the first invoice. (7) Required notices are never abandoned: dead-lettered obligations, enforcement rows and billing notices stay in the queue, retried once a day with an ops alert each time (`dead_at` only marks the escalation); a terms notice is re-rendered at every delivery attempt so the date in the email is the recorded effective date (sent time + 30 days). B4 remains the documented dependency.

Round 6 (Astra review of f693121ae, migration `0029`): (1) a customer's cancellation is TERMINAL per subscription: once Stripe has confirmed it, `billing_subscriptions.cancel_terminal_sub` holds the subscription id and no renewal request is sent for that id again (terms re-acceptance can only lift a terms-only cancellation); a late renewal that still lands is corrected by the read-back, which runs on every sweep for a day after any renewal request. (2) A replacement subscription (a different id) clears the first-payment record, service-supplied mark, period and cancellation fields in the same statement that claims it, so it never inherits the old contract's payment state. (3) The first real invoice of a delayed start is held before money can move: on `invoice.created` the draft gets `auto_advance=false` and is read back before the webhook answers 2xx (a failure answers non-2xx and Stripe retries the event for up to 72 hours; Stripe also waits an hour after a 2xx before it attempts payment: https://docs.stripe.com/billing/subscriptions/webhooks#understand; a draft with auto_advance=false stays a draft until finalized: https://docs.stripe.com/invoicing/integration/automatic-advancement-collection). The LIVE total is compared with the agreed one: equal, it is finalized and paid by us (keys `invhold:`/`invfin:`/`invpay:` plus the invoice id, each step recorded in `first_invoice_holds` and read back); different, it is never finalized, the subscription is cancelled (confirmed) and checkout reopens. Stripe deletes one-off drafts only, so deleting the draft is attempted and a refusal is expected and harmless. (4) Local subscription status only moves forward (claimed < trialing < active/past_due < canceled/disputed, enforced in the SQL); a retried event re-reads the subscription, and a retried `invoice.paid` for an ended subscription records the payment facts for refunds but activates and grants nothing. Portal: a billing action that meets `home_busy` is retried 3 more times (~400 ms apart) before showing "We are finishing another change to your plan. Try again in a moment." B4 stays the documented merge dependency.

Round 7 (Astra review of 8f43de44d, migration `0030`): (1) A confirmed cancellation stops renewal at Stripe at once. Before anything newer is decided, every pending subscription mutation is settled by sending its own recorded request again with its original idempotency key (Stripe applies it now or returns its saved answer, and the key can never change the subscription later; reading the current state proved nothing, because a request an older holder sent can still be on its way), then the cancellation is sent with a fresh key and read back; a racing flip is corrected again, a few times, in the same leased operation, and then fails with a `cancel.unconfirmed` alert. The repair sweep is no longer relied on. (2) The first-invoice handler re-checks the subscription (local status, cancellation intent, terminal flag, and Stripe's own status and `cancel_at_period_end`) inside the lease before finalizing and again before paying; for a cancelled, ending or replaced subscription a draft stays held and an open invoice is voided (https://docs.stripe.com/api/invoices/void). (3) Every refund is tied to the payment it refunds: a first-month operation stores the invoice and payment intent when it is opened (and the exact payment snapshot in its detail), withdrawals use their own contract's consent and payment, the refund call uses that payment intent, and refund reconciliation and refund events match the op id AND the payment intent. A replacement subscription's payment can never satisfy or be refunded by an older operation. B4 stays the documented merge dependency.

Round 9 (Astra review of 6f9e90c02, migration `0031`): (1) Cancellation is confirmed only by Stripe's read-back (`cancel_at_period_end=true`); until then the route answers `{canceled:false, processing:true}`, the portal says it is still being confirmed, and the confirmation email is sent from the read-back step, once. A pending mutation whose replay fails at Stripe (a cached failure, `Idempotent-Replayed`) records Stripe's answer (`sub_mutations.provider_error`), is superseded and the intent is sent with a fresh key; a request still in flight (`idempotency_key_in_use`) stays pending; three failures alert `cancel.provider_failing`. (2) The first-invoice payment is journaled before `/pay` (`first_invoice_holds.pay_requested_at`); a payment that completes after the contract ended is refunded in full through the ledger (`late_payment`, one per invoice) with alert `billing.late_payment_refunded`, from the event retry or `invoice.paid`, and starts nothing. (3) `service_intervals.subscription_id`: a withdrawal counts only service supplied under its own subscription, clipped to the contract and paid period; a replacement claimed while served starts a new interval. (4) The first-month refund and the withdrawal read the contract inside the home's lease and record their own subscription explicitly. Fencing: the notifier, event checkpoints and notice bookkeeping are fenced; the lifecycle writes only `service_intervals` (a test scans every source file).

Seller split (Sean, 2026-10-10; `src/seller.ts`, migration `0032`): Ferrox Labs, LLC is the seller everywhere. US billing countries use our Checkout plus Stripe Tax (`DIRECT_PATH`); every other country gets a Checkout Session with `managed_payments[enabled]=true` (`MANAGED_PATH`), where Link (by Stripe) takes payment as merchant of record for Ferrox (never "the seller"), without the parameters Stripe forbids. `CLOUD_NONUS_SELLER=direct` (the later "$25k/month non-US" switch) moves NEW non-US signups to the direct path; existing subscriptions keep the seller recorded with their consent (`tax_source='managed_payments'`). Managed Payments tax coverage is data (`src/managed-payments-coverage.ts`, from Stripe's tax-compliance page); a Link buyer outside it, with no Ferrox registration in `FERROX_TAX_COUNTRIES`, gets `409 tax_unavailable` (zero tax is never assumed). The seller is chosen from the country on our page and verified against Stripe's collected address at `checkout.session.completed`; a mismatch is refunded in full, cancelled and the customer asked to check out again (`checkout.seller_mismatch`). Link buyers: no Stripe Tax quote (Link prices tax and, with Adaptive Pricing, the currency), the renewal statement names no total in a currency they may not pay in, the confirmation email states the amount and currency actually charged (`checkout_consents.charged_currency`), automatic top-up is not offered (a Managed Payments subscription only authorizes Link to charge it), and refunds Link makes on its own are recorded in the ledger as `external` operations from `charge.refunded`, so later refunds and withdrawals count them. The EU withdrawal function and the confirmation email (with full terms copies) work the same for both. Products need an eligible Managed Payments tax code (txcd_10103001 or an IaaS code) in Stripe before launch. Trader identity (signed-in quote, account summary, withdrawal page, confirmation): the phone comes from the `LEGAL_PHONE` secret, labelled as a legal and contract notice line after the support line, and is left out when unset. Suspended data is kept 30 days: set `retentionMs` to 30 days in `CLOUD_B3_CONFIG`.

#### B4 merge notes (legal flows)

LAUNCH BLOCKER until B4 merges: with the stub, monthly credit grants, paid refunds and credit revocation cannot complete and auto top-up never activates (all fail closed). A live deployment (`CLOUD_B3_MODE=live`) on the stub raises a `flux.not_wired` alert on every billing sweep.

Until `cloud-v2/b4` merges, `stubFluxHooks` in `src/b5-billing.ts` stands in, and it FAILS CLOSED where a guess would cost money. At merge, replace it with the B4 implementations:

1. `usedIncludedCreditMicrocents(env, {homeId, periodStart, periodEnd, usedThrough})`: read B4's included-credit ledger (top-ups excluded), counting only usage recorded at or before `usedThrough`, and throw when it cannot be read. It feeds ONLY the usage summary page (`GET /v1/account/usage`), read-only, and is never used for money: since 2026-10-12 no refund deducts credits used (a first-month refund pays the full fee; the unused grant is reversed by `revokeCredits` when the refund runs). The stub throws `included_credit_unavailable`, so the summary page shows "unavailable"; no refund waits on it.
2. `grantMonthlyCredits(env, {homeId, plan, invoiceId, periodStart, periodEnd, kind, previousPlan})` (REQUIRED): apply one grant at most once per `(invoiceId, kind)`. The stub logs the request and throws `flux_not_wired`, so a grant is never recorded as made when Flux granted nothing: the `invoice.paid` event still completes (service active, period moved), the `credit_grants` row stays claimed with `granted_at` NULL (`attempts`, `last_error`, migration `0082`), the home's ONE `credit.grant_pending` alert (high, detail `{grantIds, grants: [{invoiceId, kind, error}], revision}`) lists it on `flux_not_wired` or after 3 failures (and keeps it listed, `alerted_at`, until it is granted, its reversal is confirmed or ops clears `alerted_at`), and every billing sweep asks again under the home's lease (least recently tried claims and homes first) until the hook resolves, which records the grant and drops it from the alert; the alert is resolved when its list is empty. A grant whose reversal was journaled is never asked again. A claim is asked again only while the subscription it was made for still owns the home and has not ended; otherwise (or a claim from before `0082`, with no period) it is suppressed (`suppressed_at`, `suppressed_reason` `subscription_ended` / `grant_input_missing`) and stays listed for ops. The stub keeps one `flux_hook_stub_log` row per grant id (unique `(hook, grant_id)`, one atomic upsert) with a `count`. ERROR CONTRACT for `grantMonthlyCredits` and `revokeCredits`: B4 throws `FluxHookRetry(code)` when it cannot apply the request now, and ONLY that is recorded as a failed attempt; any other throw (a D1 error, a network error) is not an attempt: it fails the event or sweep pass, which is retried. Each claim's `last_attempt_at` is stamped before B4 is asked, so an infrastructure failure never pins the same claim or home at the front of the sweep (the same for `credit_reversals`: `last_attempt_at`, least recently tried reversals and homes first). The stamp also counts `tries`: 3 asks that failed on infrastructure (`tries-attempts`), or a claim or reversal still pending 2 hours after it was made, escalate it (`infra_failing` / `pending_too_long`). Ops clears a listed claim with `alerted_at=NULL, cleared_at=<now>, cleared_tries=tries`; it is listed again only after a new failed ask or a later suppression.
3. `stopForBilling` is used by refunds to take the plan's credits back. Refund operations refuse to finish against the stub (`flux_not_wired`).
4. `setAutoRecharge(env, {homeId, enabled, amountMicrocents, thresholdMicrocents, monthlyCapMicrocents, revision, consentId})` (REQUIRED): write `flux_subscriptions.autorecharge_*`. Flux auto-recharge does the charging, the monthly cap reservation (`autorecharge_spent_this_month_microcents`, `autorecharge_month_key`) and the single-flight purchase (`flux_try_begin_autorecharge`). Ignore a revision older than the one held. The stub throws `flux_not_wired`; the account page then says automatic top-up is not active, and the sweep re-applies every unapplied revision once the real hook is wired.
5. Remove `readonly stub` from the replacement (or leave it unset). Then run `pnpm exec vitest run test/legal-flows.test.ts` (the `#9` and `#17` tests use the stub explicitly).

### Announcement signup contract

`POST /v1/announcements/subscribe` takes `{ "email": "…", "name": "…" }` — the
name is optional, any other field is `400 invalid_request` — and answers
`{ "ok": true }` once the address is on the list. It is unauthenticated because
the caller is somebody's first run, before any account exists, which also makes
it the one public write into the owner's mailing list. The address is validated
here rather than trusted from the client, and two limits apply before anything
reaches Sendlane: three attempts per address per 15 minutes, and ten per caller
IP per hour. An exhausted limit is `429 rate_limited` and never reaches
Sendlane. A blank name is omitted rather than sent, because Sendlane leaves
omitted fields intact and an empty string would wipe a name the record has.

`SENDLANE_API_KEY` and `SENDLANE_HASH_KEY` are required secrets with no
default: they are write credentials for the whole Sendlane account, they are
never logged or echoed, and they go into the form body of the
`list-subscriber-add` call and nowhere else. A Worker without them answers
`503 announcements_unconfigured` on every signup and logs the missing names —
it never pretends to have collected an address. `wrangler deploy` also refuses
while a name in `secrets.required` is unset.

`SENDLANE_LIST_ID` is a plaintext `var` and defaults to `37`, which is Murage's
own list. A list id is configuration, not a secret; a value that is not a
number is treated as unconfigured rather than guessed at.

Sendlane's legacy v1 API answers an HTML error page instead of JSON when it is
unhappy, including under concurrency, and does it with a `200`. Any HTML body
is therefore a retryable failure, retried up to three times with backoff. A
non-HTML 4xx is a deliberate rejection and is not retried. A signup that does
not succeed is `502 announcements_upstream`; the desktop turns every failure
into a logged line and never blocks entry to the app on it.

### Managed endpoint contract

All three endpoint methods require `Authorization: Bearer <murage_install_…>`.
Account bearer tokens are rejected.

- `GET` returns `{ "endpoint": null }` before allocation or after deletion.
  Otherwise it returns the HTTPS URL, hostname, lifecycle status, generation,
  timestamps, and a redacted `lastErrorCode`. It never returns a connector
  token.
- `POST` has no required body. It idempotently reserves or reconciles the
  endpoint, adopts a tunnel/DNS record created by an interrupted earlier run,
  and returns `{ endpoint, connectorToken }`. The raw token is obtained only
  after tunnel configuration and DNS are ready. The caller must place it
  directly in the operating system's secure credential store; it is not
  recoverable from GET or D1.
- `DELETE` removes DNS first and then the tunnel. It returns `204` when done or
  when already deleted. A partial Cloudflare failure returns
  `503 endpoint_cleanup_pending` and retains only the IDs needed for a retry.
  A concurrent mutation returns `409 endpoint_busy` with `Retry-After: 2`.

Hostnames have exactly one opaque label in front of the configured suffix:
`c-<32-lowercase-hex>.<COMPANION_HOST_SUFFIX>`. Set the suffix to a zone name
covered by the zone's edge certificate (normally the zone apex) so the endpoint
does not depend on deep-subdomain TLS coverage. Tunnel names are stable opaque
identifiers and contain no account email, display name, or client-supplied ID.

Endpoint provisioning is limited to 20 attempts per installation per hour;
deletion is limited to 30. A 60-second D1 lease and monotonically increasing
generation serialize concurrent requests. The owner renews and fences that
lease before every provider call, so an expired request cannot roll back a
resource adopted by its successor. Cloudflare calls have a five-second
per-request timeout, reject redirects, bound response bodies, and validate the
response shape before persisting an ID. Ambiguous create/update responses are
reconciled by the stable tunnel name and exact DNS identity. Before any
destructive cleanup, both stored IDs and provider-side names/targets are
revalidated; a renamed or repurposed resource is retained for an operator
instead of being guessed at. A newly created partial resource is rolled back;
an adopted resource is never deleted by a failed reconciliation.

Revoking an installation first revokes its local installation credentials, then
schedules best-effort endpoint cleanup. Cloud cleanup failure cannot restore or
delay credential revocation. Repeating the owner-scoped installation DELETE is
safe and retries retained cleanup state. A five-minute cron also processes at
most four expired-lease rows per run when they are already deleting, belong to
a revoked installation, or outlive a hard-deleted installation. The four-row
bound leaves the worst-case 40 external provider calls below the Workers Free
plan's 50-subrequest ceiling. Failed scheduled cleanups back off from five
minutes through 15 minutes, one hour, six hours, and then 24 hours. Once a
deletion has been pending for 24 hours, each eligible sweep emits a distinct
aggregate operator-attention log without installation or account identifiers.
This bounded sweep prevents a transient provider failure from orphaning
resources forever without creating an unbounded scheduled invocation.

### Trusted factors: the first-factor hold and its one waiver

Money routes and the desktop pairing code need a fresh proof from a factor on the account's trusted list (`src/trusted-factors.ts`,
CONTRACT.md section 3a). The first factor is trusted only by an 8-digit code emailed to the account's current Supabase address
(10 minutes, 5 attempts, 5 codes a day), then a 24-hour hold. The emailed code is never skipped.

The hold is waived (`usableAt` = now in the verify answer) only when the account has **nothing to protect**: no `billing_subscriptions`
row of any status, no `cloud_homes` row in any state, no `machine_owners` assignment, and no trust history of any state (any
`cloud_trusted_factors` row, removed factors included, or any trusted event). At most once per account: the code request reserves
`cloud_factor_bootstraps` (migration 0084); the verify consumes it in the same batch that spends the code, bound to that factor and
Supabase session; the activation `UPDATE` decides `usable_at` itself, re-checking the predicate (excluding only its own staged row) and
that this operation consumed the reservation. Anything that appears meanwhile keeps the hold. An unconsumed reservation can be
reclaimed after the code's 10 minutes; a consumed one is kept and never reused. Design: TRUST-FIRST-FACTOR.md revision 2 (part B),
reviewed in Astra TRUST-1 and TRUST-2.

### The first purchase on the email sign-in alone

On an account with nothing to protect, POST `/v1/billing/reserve`, `/v1/billing/checkout` and `/v1/billing/checkout/resume` accept the
email sign-in alone (any aal) under one purchase authorization, `cloud_purchase_bootstraps` (migration 0085, `src/purchase-bootstrap.ts`).
The reserve claims it in the batch that inserts the home, by an `INSERT ... SELECT ... WHERE` over the whole protect-set (any `cloud_homes`
row but its own, billing rows and contract links with a Stripe customer, `machine_owners`, any trusted factor or `trusted_*` event, a
retry/replacement route, a completed, paid, rejected or parked order). Checkout and resume continue it only from the reserving Supabase
session, for the reserved home (sent as `homeId`, required on this path, and checked against the resolved one), before `issue_until`
(30 minutes; later: 403 `step_up_required` with `step_up.bootstrap_expired` and an emailed-code intent, while an issued Stripe session still pays), with only its own records on the account; each
write that binds the new Stripe customer (always created, never looked up) or an issued session re-checks all of it in the statement,
fenced by the row's generation. Top-up is not covered on this path: it answers the shared 403 `step_up_required` with its emailed-code intent, and the exact retry checks out under that approval. The worker gate and the handlers ask the same
read-only check through `billingDependencies.stepUp`; every other route is unchanged, and a refusal on the three routes carries
`step_up.bootstrap: false`. Lifecycle: `submitted` on an unpaid completion, `consumed` in the paid-moment batch on every paid path, `parked`,
`closed` on rejection or failed payment (final), `expired` after `issue_until` once every issued session is terminal; then one more
generation by compare-and-swap, only while the account holds nothing but that attempt's own records (kept in
`cloud_purchase_bootstrap_history`). Design: TRUST-FIRST-FACTOR.md revision 4 (part D), Astra TRUST-3 and TRUST-4.

### Staging mail sink

Staging cannot send real mail (the `send_email` binding needs the sender's zone on the Worker's own account). Every sender in `src/`
goes through `transactionalSender(env)` in `src/email.ts`, which writes to a sink database instead of the `EMAIL` binding **only when
both** hold: the D1 binding `MAIL_SINK` exists (declared only in `env.staging` of `wrangler.jsonc`, database
`murage-cloud-staging-mailsink`) **and** `STAGING_MAIL_SINK` is `"1"`. Production has no `MAIL_SINK` binding, so the sink cannot engage
there. A test fails on any `EMAIL` binding access outside `src/email.ts`.

Operator setup (staging only, once):

```sh
pnpm --filter @murage/control-plane exec wrangler d1 migrations apply murage-cloud-staging-mailsink --env staging --remote --config wrangler.jsonc
printf 1 | pnpm --filter @murage/control-plane exec wrangler secret put STAGING_MAIL_SINK --env staging --config wrangler.jsonc
```

(The var is kept as a secret so a deploy does not clear it; leaving it unset sends through `EMAIL` as before.)

**Recipient allowlist (required).** With the sink engaged, a mail is written only if its recipient matches `MAIL_SINK_ALLOWLIST`: comma-separated
exact addresses and/or `@domain` entries (an `@domain` entry matches exactly that domain, not its subdomains; case-insensitive). Any other
recipient is **rejected**: the send fails (the trust code answers `503 email_unavailable`, the same failure every caller already handles), no
sink row is written and nothing falls through to the real provider. A missing or empty allowlist with the sink engaged rejects every mail.
Set it as a secret next to the engage flag, with the operator's own test address plus a synthetic suffix:

```sh
printf '%s' 'OPERATOR_TEST_ADDRESS,@staging.murage.test' | pnpm --filter @murage/control-plane exec wrangler secret put MAIL_SINK_ALLOWLIST --env staging --config wrangler.jsonc
```

Rows hold `(id, to_addr, subject, text, created_at)`, never HTML, and the sink logs nothing about a message. They contain sign-in,
trust and pairing codes in plaintext, so:

- No route, export or log reads the sink. The **only** read path is a manual, read-only query by the operator, limited to the last 24 hours:
  ```sh
  pnpm --filter @murage/control-plane exec wrangler d1 execute murage-cloud-staging-mailsink --env staging --remote --config wrangler.jsonc \
    --command "SELECT to_addr, subject, text, created_at FROM staging_mail_sink WHERE created_at > (unixepoch() - 86400) * 1000 ORDER BY created_at DESC LIMIT 20"
  ```
- The cron (every 5 minutes) deletes rows older than 24 hours. D1 Time Travel can still restore deleted rows for up to 30 days; codes
  in them have long expired.
- D1 read access is anyone with D1 access on the staging Cloudflare account (Ferrox Labs): keep that account's members to the named
  operators, and use synthetic test recipients on staging.

### Deploying

```sh
pnpm --filter @murage/control-plane run deploy:staging
```

`scripts/deploy.mjs <env>` is the only supported deploy; do not run `wrangler deploy` by hand. It refuses every argument but the environment name
(no `--name`, `--var`, `--env`, `--config`), validates `wrangler.jsonc` as resolved for that environment through `scripts/check-deploy.mjs`
(Worker name, account id, D1 database ids; `MAIL_SINK` exists only on staging and only with the staging sink id
`7c9c6777-f7a1-4804-8596-7933a523d392`; `STAGING_MAIL_SINK` and `MAIL_SINK_ALLOWLIST` appear nowhere outside `env.staging.vars`), and then runs
exactly `npx --yes wrangler@4.149.0 deploy --env staging` itself. It also refuses a `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_ENV` in the process
environment that disagrees. `pnpm run check-deploy` still checks the config file alone.

### Rollout: evidence epochs (automatic canary)

`wrangler.jsonc` still pins images built before evidence epochs (`CLOUD_B3_CONFIG.imageDigest`, the `B5_PROVISIONER_CONFIG.images`
snapshot ids). A home on such an image runs a daemon that never echoes an epoch: the control plane accepts its heartbeats but shows it as
"needs update" and never promotes it automatically. Order:

1. Build the new home image first (daemon with the `X-Murage-Evidence` header, per-response negotiation and the 5xx retry) and snapshot it.
2. In the SAME deploy as this control plane, update `CLOUD_B3_CONFIG.imageDigest` and the `B5_PROVISIONER_CONFIG.images` snapshot ids.
   Rolling back the control plane alone is safe: the new daemon answers an older control plane's 400 with the oldest shape in the same poll.
3. Reservations already carrying the old digest: `cloud_homes.image_digest` is fixed at reservation and is only a label (the admin canary
   must name it; the canary record copies it). The server image is the snapshot `B5_PROVISIONER_CONFIG.images` names when the home is
   provisioned (kept in `provision_choices` for that resource generation). A home provisioned before the deploy keeps the old snapshot, so it
   is never auto-promoted: the admin canary (`POST /v1/fake-b3/homes/<id>/canary` with the home's stored digest; the `/v1/machines/...` prefix
   carries only `desired`, `heartbeat` and `lease`) is the path. It accepts the stored digest even when the current config names another. Nothing is refunded
   while an operator does that within `PROVISION_MAX_MS` (60 min from the provisioning budget's start); past it the home is given up on
   (`home_never_ready`) and refunded. A reservation paid before the deploy but provisioned after it gets the new snapshot ONLY if its
   `provision_choices` row was not yet written: `create_volume()` persists the snapshot choice per resource generation, so a generation
   that paused after that step resumes on the OLD snapshot after the deploy and belongs to the manual-canary cohort. Classify the cohort by
   the persisted snapshot in `provision_choices`, never by server creation time; a home whose choice names the new snapshot is promoted
   automatically (its canary record names the old digest label).
4. Capability header path: the heartbeat goes from the home straight to `MURAGE_CLOUD_ADMIN_URL` (this Worker through Cloudflare's edge),
   with environment proxies disabled (`ProxyHandler({})`); it never crosses the home's Cloudflare Tunnel or Caddy, which carry inbound
   traffic only. Tested: `server/cloud-home/app-health.test.ts` (the header on the wire on every heartbeat) and `test/b3-control.test.ts`
   (AUTOCANARY-11 P1-3, the Worker acks an epoch for it). Check after the deploy: on one staging home, `journalctl -u murage-control` shows no
   "poll unavailable" and the home's `cloud_home_health.report_echo` becomes 1 within two minutes (the ack carried an epoch, so the header
   arrived).

## Local checks

Install from the repository root, then run:

```sh
pnpm control-plane:check
pnpm control-plane:test
pnpm control-plane:dry-run
```

For local manual development, copy `.dev.vars.example` to `.dev.vars`, replace
`BETTER_AUTH_SECRET` with at least 32 cryptographically random bytes, provide a
non-production scoped `CLOUDFLARE_API_TOKEN`, apply the migrations locally, and
start Wrangler:

```sh
pnpm --filter @murage/control-plane exec wrangler d1 migrations apply DB --local --config wrangler.jsonc
pnpm --filter @murage/control-plane exec wrangler dev --config wrangler.jsonc
```

Do not commit `.dev.vars`.

## Orphan Stripe customers (manual erasure)

A checkout whose billing location changed moves the home to a NEW Stripe customer (`b5-billing.ts` `prepareCheckoutCustomer`). A create whose
answer was lost, a switch that lost its lease, or a switch abandoned because the old customer came to hold something meanwhile leaves an
ORPHAN: a customer made for the home's attempt that the home never used. Every orphan is recorded (`cloud_ops_state`
`customer_orphan:<home>:<attempt>`) and on the ownership ledger (`customer_home:<customer>`), so any Stripe event on it still routes to its home.

Nothing is ever deleted at Stripe automatically. The lifecycle:

1. `GET /v1/admin/customer-orphans` (operator bearer `CLOUD_ADMIN_TOKEN`) lists the orphans OLDEST FIRST, one page at a time
   (`?limit=` 1..1000, default 200; `?after=` the previous page's `next`, a keyset cursor over the age index; `next` is null on the last
   page), each with its customer id (null when it was never learnt: find it in the Stripe Dashboard by `metadata[checkout_attempt]` or
   `metadata[customer_create]` = the listed `idempotencyKey`), its age, `reviewDueAt`/`overdue`, `escalateAt`/`escalated`, and when it was
   alerted (`reviewAlertedAt`, `escalatedAt`). Every customer create (a home's first customer and a purchase bootstrap's included) is
   journaled before the call, so a create whose binding failed or whose answer was lost is always recorded here.
2. 30 days after it was recorded (`ORPHAN_REVIEW_MS`), the billing sweep adds it to its home's open `billing.customer_orphan_review` alert
   (warning); 60 days after (`ORPHAN_ESCALATE_MS`, the retention bound) to the home's `billing.customer_orphan_overdue` alert (high). Each
   orphan is marked when it is added, so every overdue orphan is reached whatever their number (200 per stage and pass, oldest first).
3. The operator confirms, with Stripe reads, that the customer has NO subscription (any status), invoice, charge, dispute, credit note,
   customer balance, payment method or source, and no checkout session that completed. If anything is there, it is NOT an orphan: keep it,
   find its home through `metadata[home_id]`, and handle it as that home's customer.
4. Only then: delete the customer in the Stripe Dashboard, delete its `customer_orphan:` row, and resolve the alert. The `customer_home:`
   ledger row (ids and dates only, no address) stays as the audit trail.

Storage limitation (GDPR Art. 5(1)(e)): an orphan carries the account email, a name and a declared country/postal code with no purpose once
confirmed empty; the 30-day review is the retention bound, and the manual step exists only because a Stripe delete is irreversible.

## Bootstrap holder recovery (contract for the members site)

A first purchase on the sign-in alone (purchase bootstrap) whose Stripe customer HOLDS something of its own (a card attached by a
SetupIntent, a credit note, a balance) and whose declared location differs from the one on file is never switched to a new customer and
never re-addressed silently. `POST /v1/billing/checkout` (and `/checkout/resume`) answer:

```
403 {"error":"step_up_required","country":"<on file>","postalCode":"<on file or null>",
     "step_up":{"bootstrap":false,"reason":"billing_location_on_file","holds":"<what it holds>","country":"<on file>","postalCode":"<on file>",
                "declared":{"country":"<declared>","postalCode":"<declared, normalized, or null>"},
                "methods":["email_code"],"email_code":{"available":true,"digits":6,"ttl_seconds":...,"grant_ttl_seconds":...,"intent_id":"si_<32 hex>"}}}
```

The site handles it exactly like every other `step_up_required`: send the code (`/v1/account/step-up/email/send` with `intentId`), verify it
(`/v1/account/step-up/email/verify`), then resend the IDENTICAL checkout request with `stepUpIntentId`. That approved retry is the member's own
verified act: the control plane journals it (`cloud_ops_state customer_move:<home>:<key>`), sets the customer's billing address to the
declared country and postal code (the whole address; street, city and state cleared), reads it back from Stripe, and the checkout continues
(200 with the session). Only the customer and location of the refused request may be moved, within 24 hours. A customer with a subscription
that still bills is never moved here (409 `country_mismatch_existing`: its move is the address-change flow). A verified member's request
without that refusal on record keeps the 409 `country_mismatch_existing` it always got.

## Payment lines and disputes (lifecycle hand-off)

Every payment event billing hands to the lifecycle names its subscription (`subscriptionId`). The lifecycle orders events per subscription
line (`cloud_homes.payment_line`, `cloud_subscription_lines`): the end of one contract (a Link refund, a dispute, its deletion) closes that
contract's line only and can never outrank the activation of a replacement paid earlier, whatever order the webhooks arrive in.

Dispute policy (scoped): a dispute affects only the contract its payment belongs to. It is recorded in `payment_disputes` and the payment's
reimbursements are held (no new refund or credit note while `closed_at` is unset; ops sets `closed_at` and `outcome` when Stripe closes the
dispute). Only a dispute of the CURRENT contract ends service (disputed, stopped, ended at Stripe). A dispute of a replaced contract, or one
that cannot be attributed, raises `dispute.historical_payment` / `dispute.unattributed_payment` and never touches the paid current service;
closing the account for abuse is an operator decision that refunds the current contract first.

## Production blockers

The checked-in Wrangler file is intentionally non-deployable production
scaffolding. No remote resource was created or changed while preparing it.
Before a production deployment, an operator must:

1. Choose and route an HTTPS hostname, then replace `BETTER_AUTH_URL`. The
   Worker has `workers_dev` disabled and no production route in this PR.
2. Generate a strong production `BETTER_AUTH_SECRET` and add it with Wrangler's
   interactive secret command. Add `CLOUDFLARE_API_TOKEN` the same way. The
   checked-in `secrets.required` names validate local configuration and generate
   binding types; they do not contain or upload values.
3. Create the D1 database, replace the all-zero `database_id`, review the pinned
   migrations, and apply them to that database.
4. Complete Cloudflare Email Sending domain onboarding, replace the placeholder
   sender in both `EMAIL_FROM` and `allowed_sender_addresses`, and grant the
   deployment identity access to the binding. The Cloudflare session used while
   preparing this code could not list Email Sending (`2036 Unauthorized`), so no
   domain or binding activation was attempted.
5. Create a least-privilege Cloudflare API token scoped to the selected account
   and zone. It needs a Cloudflare Tunnel/`cloudflared` connector **Write**
   permission plus DNS **Read** and **Write** for that zone. Set
   `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, and add the token through
   `wrangler secret put CLOUDFLARE_API_TOKEN`. Never put the token in `vars`,
   `.dev.vars.example`, logs, or CI output.
6. Set `COMPANION_HOST_SUFFIX` to the certificate-covered DNS suffix where
   opaque `c-*` records may be created. The configured zone must contain that
   suffix. This change does not create the zone, certificate, or any remote
   tunnel/DNS resources during build or tests.
7. Replace `ALLOWED_ORIGINS` with a comma-separated allow-list of exact HTTPS
   application origins. Wildcards are deliberately unsupported.
8. Deploy the Worker and verify that `GET <BETTER_AUTH_URL>/healthz` returns
   exactly `{ "ok": true, "service": "murage-control-plane" }` over
   HTTPS before shipping the desktop build. Electron probes this endpoint and
   keeps new hosted onboarding hidden until it is healthy; an already signed-in
   user remains visible so cleanup and recovery are not stranded.

9. Add `SENDLANE_API_KEY` and `SENDLANE_HASH_KEY` with `wrangler secret put`,
   and set `SENDLANE_LIST_ID` in `vars` if the signup should not land on list
   `37`. Rotate both keys once: they shipped inside every packaged desktop
   build before this endpoint existed, so they must be treated as disclosed.
   Until they are set, `POST /v1/announcements/subscribe` answers
   `503 announcements_unconfigured` and logs the missing names.

The control-plane API token is never handed to a desktop. A desktop receives
only its tunnel connector token, which can run that one remotely managed tunnel.
The public companion service still enforces its own pairing and application
authentication; the tunnel is transport, not user authentication. The
announcement signup is the one place this control plane touches marketing
consent, and it keeps nothing about it: the address goes to Sendlane, and only
an HMAC of it stays here, in the spam limiter, for at most 24 hours.

## CP0 staging enrollment

`POST /v1/machines` and `POST /v1/machines/:id/rotate` require the
`CLOUD_ADMIN_TOKEN` bearer secret. CP0 uses the home ID as the machine ID; it
creates database records only. Enrollment tokens expire after 30 minutes and
are single use. Rotation invalidates outstanding tokens and the old machine
credential while preserving the encrypted home keys.

`POST /v1/machines/:id/enroll` accepts `{token}`. It returns
`{machineCredential, homeId, adminUrl, publicOrigin, generation}`. The origins
are persisted in migration 0007 because enrollment occurs after the admin
creation request. An omitted `adminUrl` defaults to the creation request origin.
Optional token `bound_server_id` is checked against the stored machine
`server_id`; this checks control-plane record consistency, not provider
attestation. Later host tooling owns establishing that identity. `bound_ip`
is checked against Cloudflare-provided `CF-Connecting-IP`.

`POST /v1/machines/:id/unwrap` accepts `{generation}` and the machine credential
as bearer. `bound_ips`, when populated, is a JSON array of exact IP strings.
A successful response contains only `{dataKey, bootstrapSecret, volumeKey,
generation}`. The keys are base64. The staging AES-256-GCM wrapper authenticates
the home ID as AAD and uses the non-extractable 32-byte base64 `CLOUD_KEK_V1`
secret. No KEK appears in the home protocol. The shared fake protocol lives in
`test/fixtures/cp0-shapes.json`.

The `staging` environment has no routes and uses `workers.dev`. Its all-zero
D1 ID and `.test` auth origin are deliberately inert placeholders; provisioning
and replacement require the later authorized staging setup. No staging token
was supplied for CP0, so verification ends at local workerd tests and Wrangler
`deploy --dry-run`, with telemetry disabled. Production configuration is
unchanged. KMS and live host qualification belong to later batches.
# B3 fake-source construction

This source is **inert by default**. No production Wrangler variables, bindings,
routes or secrets are enabled by this change. To use it in an isolated fixture,
inject `CLOUD_B3_MODE="fake"`, `CLOUD_B3_CONFIG` (JSON), and a test-only private
P-256 JWK as `CLOUD_B3_SIGNING_JWK`, alongside the accepted CP0 fake admin token
and staging KEK. `src/b3-config.ts` validates the exact config shape; the runtime
fixture in `test/b3-control.test.ts` is the executable example. Config includes
explicit reservation, grace and retention periods, image digest, engine gates,
quarantine relay IP and ordered capacity choices with synthetic outcomes.

Fake administration lives under `/v1/fake-b3/`: reserve, payments, reconcile,
and homes/:id/{action,canary,notice,recovery/cancel,recovery/complete,lease/ack}.
These are synthetic fixture protocols, **not live Stripe webhook or account
portal endpoints**. Account ownership is checked against persisted installation
ownership. All administrative operations require the CP0 admin bearer; hold
cancellation instead requires a signature from an already registered device.
There is deliberately no public device-key registration bypass.

The fake adapter uses D1 resources with unique home/generation/role identities.
It has no network transport. `createWorker` accepts an optional third argument
`{provider: (db) => ProviderAdapter}` for boundary fault injection; existing
transport arguments retain their meaning. With fake mode enabled, scheduled
work runs B3 reconciliation without legacy endpoint cleanup transport.

Home routes are `GET /v1/machines/:id/desired` and
`POST /v1/machines/:id/{heartbeat,lease}`. Home bearer credentials and bound IPs
are checked; a desktop lease holder uses the existing installation credential.
The lease lasts 60 minutes with a 60-second renewal cadence and 2-minute handover
skew margin. Heartbeat freshness is reported separately from lease validity.
Actual local CLOCK_BOOTTIME, NTP, sleep detection and work quiescence belong to
the home/desktop consumers and are not proven by these CP tests.

Signed identities and recovery proofs use Web Crypto ECDSA P-256/SHA-256, raw
64-byte signatures over UTF8(base64url payload), with a separately pinned public
JWK. `src/b3-signatures.ts` exports verification functions. Recovery holds last
72 hours; a paired device can cancel, proofs expire after five minutes, and
completion records the home sign-in wipe/channel-pause consumer requirement.
CP0 key and enrollment JSON remains unchanged. Fake provider bindings propagate
through the actual administrative `/v1/machines/:id/rotate` route. Delivery of
that token into cloud-init is still a q04/root integration seam.

Receipts distinguish fake effects from external work. Capacity exhaustion after
payment creates an idempotent **fake** refund record; it never contacts Stripe.
DNS removal precedes fake server/volume destruction by 60 seconds. Suspension
requires explicit synthetic receipt of two notices before retention deletion.
External session/Flux/connected-app revocation, notifications, recovery pairing,
Start fresh/Restore/Start/cancel-renewal consumers and production crypto-shred
remain pending outbox work. Image canary inputs are synthetic checks, not live
engine/browser readiness proof. Quarantine records the allowed relay IP; actual
provider firewall proof remains pending. See `.planning/cloud/b3/RESULT.md` for
the full boundary and required root verification.
