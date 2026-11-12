# PROD-RUNBOOK.md: Murage Cloud production go-live

The one ordered runbook for taking the control plane from dark to open. The code points here
(`wrangler.jsonc:189`). Nothing in this file deploys anything by itself; every step is a thing a
person runs on Sean's word.

**Where production lives:** Cloudflare account `b83123326a4b9ad76831b9cb9365b33b` (the one that holds
the `murage.ai` zone), Worker `murage-control-plane`, env `production`, D1 `murage-cloud-prod`.
Staging is a different account and is never touched by these steps.

**The only supported deploy command:**

```
node scripts/deploy.mjs production
```

It refuses every extra argument, then runs `scripts/check-deploy.mjs`, which **refuses the deploy**
(exit 1, nothing ships) while any of these is still true in the `env.production` block:
- any `PROD_TODO_` placeholder remains,
- any staging id, staging host, or test-Stripe value (`sk_test_`, `pk_test_`, `rk_test_`, the staging
  account/db ids, `workers.dev`, `murage.test`, `192.0.2.*`) appears,
- the mail sink (`MAIL_SINK` / `STAGING_MAIL_SINK`) appears anywhere,
- a superseded home image id or digest appears, or the image digest does not match the pinned one,
- a required production secret is unset.

So the guard is the backstop: if a step below is missed, the deploy stops rather than shipping a
half-dark config.

**A dirty tree refuses every deploy.** The deploy stamps the git sha on the Worker version (`--message` is the full sha, `--tag` its first 12
hex), so it first runs `git status --porcelain --untracked-files=all` and refuses on ANY output. That covers a stray untracked file anywhere in the
repository, not just under `cloudflare/control-plane/`, because git reports the whole worktree. Check before you deploy: from this folder run
`git status --porcelain --untracked-files=all` and expect no output (`.wrangler/` is gitignored, so wrangler's own temp files do not count).
Commit or remove what it lists; do not edit the script.

---

## Sean's three infrastructure items (do these first; they are the prerequisites)

These are the accounts and resources that must exist before any placeholder below can be filled.
They are Sean's to create (new money / new accounts / account settings).

1. **provider `murage-live` project**: the production provider project that holds the home servers and
   the warm pool. Its project name, SSH key id, firewall ids, and storage box fill the
   provider project and storage box placeholders.
2. **Cloudflare account `b8312…` on the Workers Paid plan**: production runs on this account; it must
   be Paid before the first `deploy.mjs production`.
3. **New Murage Stripe account, live mode**: a Stripe account that is Murage's own (never FluxRouter's
   `acct_1TU1NSI`). Its live price ids and portal configuration fill the `PROD_TODO_STRIPE_LIVE_*`
   placeholders; its live secret key and webhook secret are production secrets (Part B).

---

## Part A: fill the `env.production` config (one commit, reviewed, then merged to release)

Replace every `PROD_TODO_` placeholder in `cloudflare/control-plane/wrangler.jsonc` `env.production`
with the real value. The full set the guard checks for:

| Placeholder | Source |
|---|---|
| `PROD_TODO_D1_DATABASE_ID` | production D1 `murage-cloud-prod` (create on the b8312 account) |
| `PROD_TODO_AWS_KMS_KEY_ARN` | production AWS KMS key (its own IAM user; not staging's) |
| `PROD_TODO_IMAGE_4C_X86_ID`, `PROD_TODO_IMAGE_4C_ARM_ID`, `PROD_TODO_IMAGE_4C_DIGEST_sha256` | the home image proven on staging; digest must match exactly |
| Production provider project name, SSH key ID, home firewall ID, and quarantine firewall ID | the `murage-live` provider project |
| `PROD_TODO_QUARANTINE_RELAY_IPV4` | production quarantine relay IP |
| `PROD_TODO_STORAGEBOX_ID`, `PROD_TODO_STORAGEBOX_HOST`, `PROD_TODO_STORAGEBOX_MAIN_USER`, `PROD_TODO_STORAGEBOX_KNOWN_HOSTS` | production provider storage box |
| `PROD_TODO_STRIPE_LIVE_PRICE_STARTER`, `PROD_TODO_STRIPE_LIVE_PRICE_PRO`, `PROD_TODO_STRIPE_LIVE_PRICE_MAX`, `PROD_TODO_STRIPE_LIVE_PORTAL_CONFIGURATION` | the live Murage Stripe account |

Leave `CLOUD_SALES_OPEN` at `"false"` and do **not** add `STRIPE_ALLOW_LIVE` yet. Those are Parts C
and D, each its own commit on Sean's word.

**Customer surface and cross-origin (verified in control-plane, 2026-10-24):** the customer account
and billing surface is the murage.ai members area (apps/web, Supabase auth), not the cloud-portal
(retired to a redirect). For the members area to reach the control plane, prod `ALLOWED_ORIGINS` MUST
include `https://murage.ai` (`index.ts:458` rejects any origin not in `config.allowedOrigins`;
`config.ts:123`), and `CHECKOUT_SITE_ORIGIN` / the return origin MUST be `https://murage.ai` so the
Stripe success and cancel pages return to `/home/cloud` (`b5-billing.ts:1089-1091`, `b5-config.ts:100`,
`CLOUD_MEMBERS_PATH`).

The identity reader must already be deployed on the production account first
(`cloudflare/identity-reader`, top-level config = production).

---

## Part B: set the production secrets

Migrations first (launch item 8, PROD-FLUX-SWITCH.md step 1b): the prod D1 migrations through `0143_flux_email_hold` (the flux_email_proof
rollout marker that `scripts/deploy.mjs` reads) and `0144_flux_email_proof_autosend` (with `first_at`) are applied with
`npx wrangler d1 migrations apply murage-cloud-prod --env production --remote` BEFORE Sean's Flux secret puts and before the first deploy
of the item 8 head. `npx wrangler d1 migrations list murage-cloud-prod --env production --remote` must then say nothing is unapplied.

0150 precondition (8b, `0150_flux_resume_via_poller.sql` header): 0150 has no repair step, and its step 1 marks EVERY active key row as
acked by the home. Pre-8b code records no delivery for an owner mint or rotation (it commits the new generation with every pending field
NULL), so no query can tell a delivered key from an undelivered one (Astra cp-r4 Medium). The gate is therefore the number of active rows,
read right before the apply on that D1 (staging first, then prod):

```
zsh ~/murage-cloud-work/d1q.sh <staging|production> "SELECT count(*) n FROM flux_home_keys WHERE state='active'"
zsh ~/murage-cloud-work/d1q.sh <staging|production> "SELECT home_id, lifecycle_version, generation, pending_op_id IS NOT NULL open_op FROM flux_home_keys WHERE state='active'"
```

- n = 0: apply.
- Staging, n > 0: apply, then right after the roll re-key EVERY listed home (the owner turns spending Off, then On; On goes through the
  poller, which delivers the key and records the ack). Each listed home is checked afterwards: acked_generation equals generation and the
  ack came from the poller (last_acked_op_id is the resume op). No D1 hand edits.
- Prod, n > 0: STOP, apply nothing, list the homes to MurageMain. Sean picks per home: re-key after the roll as above, or hold the roll.
The second query is for that list only (an open op or a lifecycle at 2 or more marks a home that also had a Stop or renewal in flight).
Right AFTER the apply, run both queries again (Grok cp-8b-r6: the count and the apply are separate statements, so a row that turns
active, or gets a new generation, in between is marked acked too). The post-apply list is the re-key list. Staging: re-key every home on
it. Prod: any home on it that was not on the pre-apply list, or whose generation moved, is listed to MurageMain at once and gets the same
per-home yes from Sean to re-key it. Once 0150 is applied, holding the roll undoes nothing, so the roll does not count as done until
every home on the post-apply list is re-keyed and checked (Astra cp-r7 Low).

Set each with `wrangler secret put --env production` (these are secrets, never written into
`wrangler.jsonc`). A deploy without any of them is refused by wrangler. Required set:

```
BETTER_AUTH_SECRET            CLOUDFLARE_API_TOKEN          SENDLANE_API_KEY
SENDLANE_HASH_KEY             CLOUD_ADMIN_TOKEN             CHECKOUT_DISCLOSURE_TOKEN_SECRET
CANCELLATION_MAIL_KEY         NOTICE_MAIL_KEY               REFUND_KEY_SECRET
STRIPE_SECRET_KEY             STRIPE_WEBHOOK_SECRET         CLOUD_HOME_API_TOKEN
AWS_ACCESS_KEY_ID             AWS_SECRET_ACCESS_KEY         HCLOUD_TOKEN
STORAGEBOX_API_TOKEN          STORAGEBOX_MAIN_PASSWORD      CLOUD_B3_SIGNING_JWK
SUPABASE_URL                  SUPABASE_PUBLISHABLE_KEY      FIRSTPROMOTER_API_KEY
FIRSTPROMOTER_ACCOUNT_ID
```

`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are the **live** Murage Stripe values.
`FIRSTPROMOTER_API_KEY` and `FIRSTPROMOTER_ACCOUNT_ID` are the FirstPromoter v2 API key and account id (account d5vrmq6s;
Settings, Integrations, Manage API Keys). They enroll every paying member as a referral partner (`src/referral.ts`). Put the same
two on staging (`--env staging`); without them enrollment is skipped with a logged warning and billing is unaffected.
`CLOUD_B3_SIGNING_JWK` is the production signing key (see `gen-prod-signing-key.mjs` and
`docs/cloud/b5/SIGNING-KEY-RUNBOOK.md`).

Then the first production deploy, still dark:

```
node scripts/deploy.mjs production
```

With Part A complete and secrets set, the guard passes and the Worker ships with sales closed and live
billing off. Verify `GET /v1/status` responds and reports the plane up.

---

## Part C: open the pre-launch (sales on)

On Sean's explicit word only. Edit `env.production`:

```
"CLOUD_SALES_OPEN": "true"
```

as its own commit, then `node scripts/deploy.mjs production`. Now reserve / checkout / resume answer
normally instead of `503 sales_closed`.

To **close** sales again: set it back to `"false"` and redeploy. Reserve/checkout/resume return
`503 sales_closed`; `GET /v1/status` still reports `live:true` for existing customers; keep
`STRIPE_ALLOW_LIVE` as it is.

### Invite-only sales (charter clients)

`CLOUD_SALES_OPEN` is read strictly: exactly `"true"` is open to everyone, exactly `"invite"` is open to invited emails only, exactly
`"false"` is shut, and anything else (unset, a typo, a capital) is shut. In `"invite"` mode reserve, checkout and checkout/resume pass only
when the signed-in member's confirmed email is in the production D1 table `sales_invites` (migration `0146_sales_invites.sql`, apply it
before the first deploy that sets `"invite"`); anyone else gets `403 not_invited` before anything is reserved or charged.

Add an invite (the email is saved lowercase and trimmed; the table refuses anything else, and re-adding the same email fails with a clear
"UNIQUE constraint" error instead of changing the row):

```
npx wrangler d1 execute murage-cloud-prod --env production --remote --command "INSERT INTO sales_invites (email, added_at, added_by, note) VALUES (lower(trim('client@example.com')), CAST(strftime('%s','now') AS INTEGER) * 1000, 'sean', 'charter client');"
```

Remove an invite (it deletes at most that one row; check the count it reports is 1):

```
npx wrangler d1 execute murage-cloud-prod --env production --remote --command "DELETE FROM sales_invites WHERE email = lower(trim('client@example.com'));"
```

Check the list: `SELECT email, added_by, note FROM sales_invites ORDER BY added_at;`

---

## Part D: turn on live billing

On Sean's explicit word only. This is the live-billing gate, separate from the sales switch:
`billingConfig()` refuses a live Stripe key unless this is exactly `"1"` (any other value is refused).
Add to `env.production`, **as its own commit**:

```
"STRIPE_ALLOW_LIVE": "1"
```

then `node scripts/deploy.mjs production`. Live charges can now be created against the live Stripe
account.

---

## Part E: warm pool

The provisioner warm pool is built but stays **off** until switched on. Control is the
`warm_pool_control` row `'pool'` in production D1 (migration `0110_warm_pool.sql`), column `grabber`:

- `off` (default): no pool servers created.
- `observe`: plans but does not create (watch the numbers first).
- `on`: creates and holds the pool (targets: Starter 60, Pro 25; idle cap EUR 700/month).
- `drain`: retires pool servers.

Move it `off` → `observe` → `on` on Sean's word, watching that creates stay inside the per-tick (10)
and per-day (150) caps and the EUR 700 idle cap.

---

## Rollback

`node scripts/deploy.mjs production` redeploys whatever the committed `env.production` says. To revert
a flip, revert that one commit and redeploy. The fastest way to stop new paying signups without a
redeploy race is Part C close (sales off); the fastest way to stop live charges is reverting the
Part D commit and redeploying. Never force-push; a revert is a new commit.

---

## Flux email proof (alerts credit.email_unverified_hold and credit.email_proof_disputed)

When a new owner's email already belongs to a Flux Router account, Flux will not connect it until the owner proves the inbox. The owner's
homes wait (no Flux key, no credit) and the Cloud page shows "This email already has a Flux Router account." with an "Email me a code"
button. The code goes only to the email stored on the Cloud account.

- Support never confirms an email by hand. There is no route for it. The only proof is the owner typing the emailed code on the Cloud page.
- The code never arrived: `POST /v1/internal/flux/email-proof/resend {account_id, by}` (admin token). It mails a fresh code to the stored
  email, with the same limits as the page (5 a day, 30 s apart). Never send a code to an address from a ticket.
- Someone says the email is not theirs: `POST /v1/internal/flux/email-proof/dispute {account_id, note, by}`. Not linked yet: the proof is
  cleared and nothing can confirm or connect it until `POST /v1/internal/flux/email-proof/dispute-clear {account_id, by}`. Already linked:
  the link is left as it is and credit.email_proof_disputed pages; Sean decides.
- Every resend, dispute and clear writes a row in `flux_email_proof_audit`.
