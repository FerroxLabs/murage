# Cloud alerts: two tiers, built against alert fatigue (2026-10-25)

Sean's decisions, made 10-25 and relayed by MurageMain:
- alerts land in Slack, on his phone channel;
- Better Stack does the external uptime monitoring;
- HARD rule: no alert fatigue. He is already blind to Flux alerts.

## Today (cloud-v2/release, ops-monitor.ts)
- Every `cloud_alerts` row is posted to `ALERT_WEBHOOK_URL` one by one, one message per home per kind. The sweep sends up to 60 a run.
- About 70 kinds, nearly all `high`.
- A daily summary exists.
- Result: twelve silent homes are twelve pings. This is the fatigue Sean described. It must not be wired to Slack as it is.

## Design
1. **Two tiers only.** Every kind maps to exactly one tier in a single table (`ALERT_TIER`). A kind missing from the table is DIGEST, and a test fails the build if any kind raised in `src/` is missing from the table.
   - **PAGE**: urgent, actionable and rare. Sent to Slack with an @-mention.
   - **DIGEST**: everything else. One daily message, never a ping.
2. **Pages are grouped by cause, not by row.** A page is a *group*, keyed by the cause (e.g. `homes.unhealthy`), with a count, up to 5 example homes and a "see the digest" link for the rest. Rows stay one per home in `cloud_alerts`, as the evidence; only the delivery is grouped.
3. **Rate limits.**
   - A group pages once when it opens.
   - It re-pages only if the count doubles, or after 4 h still open, with at most 1 reminder every 4 h.
   - At most 6 pages an hour across all groups. Past that, ONE page reads "alert storm: N groups open, see the digest".
   - P1 (control plane down) and P8 (possible account compromise) bypass both the 6 an hour cap and the storm page. A compromise page is never swallowed, and it is not counted against the cap. Tested: in a storm, a P8 page still goes out.
   - **Built as** (`alert-tiers.ts`, `alert-pages.ts`, migration 0127): group state in `cloud_alert_groups`, page log in `cloud_alert_pages`; the page kinds, thresholds and action lines are the `ALERT_TIER` table. P8's "action not made by us" is the new alert kind `access.provider_action_unexpected`, raised when the provider shows rescue, console or password reset on a home's server (it closes itself after 24 h).
4. **Auto-resolve.** When a group closes, it posts "resolved after X min" with no mention.
5. **Every page names its action**, as a fixed line in the table: "Do this: ...". A page kind without an action line fails the test.
6. **Weekly review.** The Monday digest lists, for each page kind: times fired, time open, and whether a human action was recorded (a Slack reply, or an operator route call against that home within the open window). Any kind that fired with no action is flagged "retune or demote". I propose the change, and Sean decides.

## The page list (everything else is digest)
| # | Page group | Fires when | Do this |
|---|---|---|---|
| P1 | Control plane down | Better Stack: the `/health/readiness` monitor of the prod Worker fails 2 checks in a row (external, outside our infra) | Check the last Worker deploy, roll back with `wrangler rollback`, check Cloudflare status |
| P2 | Rollout halted | The rollout controller stops a wave (a home rolled back, got Stuck, or went silent or unrendered during the soak) | Open the release, look at the failed homes, then cancel the release or ship a fixed N+1 |
| P3 | New customers not getting homes | `provision.failed` x2 in 30 min, OR `pool.empty`, `pool.create_failing`, `pool.spend_cap_reached`, OR `home.ui_render_missing` on 2 or more homes | Check Hetzner stock, the server limit and the spend cap, and grab stock in another region |
| P4 | Many homes unhealthy | `home.heartbeat_missed` on 3 or more homes, or 5% of the fleet, within 10 min | Check Hetzner status and the last deploy or rollout. ONE page with the count |
| P5 | A customer home is down and auto-repair gave up | `home.watchdog_exhausted`, `home.fixit_exhausted`, `update.stuck` | Open the home in admin, then resume, or rebuild from backup. Grouped: one page for N homes |
| P6 | Sales stopped | `image.sales_hold`, `image.trust_unreadable`, `image.pubkey_invalid`, `image.env_conflict` | Check the pinned image IDs, the digest and the trust key against PROD-RUNBOOK. Sales stay closed until it's fixed |
| P7 | A paying customer is stuck at checkout | `billing.webhook_stuck` (customer waiting) | Look at the Stripe event in the dashboard, then replay it, or refund |
| P8 | Possible account compromise | `pool.secret_misuse`, or an access-audit action not made by us (the kind is confirmed in the build) | Rotate the Hetzner token, review the provider's audit log, and freeze provisioning |

**The daily digest** starts with one line: "Nothing needs you today." or "N things need you:" followed by the open page groups with their actions. Below that: the fleet line, counts by kind for 24 h, and the open digest items grouped by kind. On Mondays the weekly review follows. Operator actions are recorded only where an operator route writes `selfservice_audit` (actor `operator`); a Slack reply is not recorded, so "no action recorded" is a prompt to look, not proof.

DIGEST: single silent homes (bounded auto-recovery handles them), disk and backup warnings, refunds and disputes in progress, resize and plan steps, pool levels above empty, the image-changed notices, notice or mail delivery retries, the alert backlog, and every `access.*` configuration notice.

## Wiring order
1. Build the tiers, grouping and limits on a fix branch, with tests including the fixed table test. Grok reviews it.
2. Show Sean a Slack preview of each page in staging (with his word, set the staging secret only).
3. Then, with Sean's word, set the prod secret, and add the Better Stack monitor for the prod Worker with the same Slack policy as Flux.
