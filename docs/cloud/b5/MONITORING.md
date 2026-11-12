# Monitoring v1

- **Heartbeat**: the existing `POST /v1/machines/<id>/heartbeat` (every 60 s, `murage-control`) now carries an optional
  `health` block: `diskUsedPercent` (int 0-100, `/data`), `lastBackupAt` (ms, from `/var/lib/murage-home/backup-last`),
  `events` (max 5, allowlist, no free text). Schema is strict: unknown fields, free text and credential-looking content are rejected.
  No credential content is ever collected: the home copies only a fixed event name and a timestamp out of spool files.
- **Alerts** (control plane cron, every 5 min; table `cloud_alerts`, one open alert per home and kind, as the evidence). Two tiers
  (design: `lanes/cloud-v2/ALERTS-TWO-TIER-DESIGN.md`; table: `cloudflare/control-plane/src/alert-tiers.ts`, `ALERT_TIER`):
  - **Page**: urgent, actionable, rare. Posted to the webhook at once, one message per cause (group), with a count, up to 5 example
    homes, an `<!here>` mention in `text` and a "Do this:" line. A group pages once when it opens, again when its count doubles or after
    4 h still open, and at most 6 pages an hour overall (past that, one "Alert storm: N groups open, see the digest" page).
    Compromise (P8) and control-plane-down (P1) pages bypass that cap. When a group closes it posts one "resolved after N min"
    message with no mention. Group state: `cloud_alert_groups`, `cloud_alert_pages` (migration 0127).
  - **Digest**: everything else (all other kinds, and any new kind not yet in the table). Never posted one by one; marked handled at once
    (so the delivery backlog does not count it) and listed in the daily digest. `alerts.backlog` is a digest item; above 600 waiting
    it is also the page `alerts.backlog_huge`.
  - A test fails the build if a kind raised in `src/` is missing from `ALERT_TIER`, or a page kind has no action line.
- **The page list**:

  | # | Page group | Fires when | Do this |
  |---|---|---|---|
  | P1 | Control plane down (external) | Better Stack: the `/health/readiness` monitor of the prod Worker fails 2 checks in a row | Check the last Worker deploy, roll back with `wrangler rollback`, check Cloudflare status |
  | P2 | `rollout.halted` | `rollout.halted` (raised by the rollout controller) | Open the release, look at the failed homes, then cancel the release or ship a fixed N+1 |
  | P3 | `homes.not_created` | `provision.failed` on 2 homes in 30 min; `pool.empty`, `pool.create_failing`, `pool.spend_cap_reached`; `home.ui_render_missing` on 2 or more homes | Check build host stock, the server limit and the spend cap, and grab stock in another region |
  | P4 | `homes.unhealthy` | `home.heartbeat_missed` on 3 or more homes, or 5% of the fleet (at least 2 homes), within 10 min | Check build host status and the last deploy or rollout. One page with the count |
  | P5 | `homes.repair_gave_up` | `home.watchdog_exhausted`, `home.fixit_exhausted`, `update.stuck` | Open the home in admin, then resume it, or rebuild it from backup |
  | P6 | `sales.stopped` | `image.sales_hold`, `image.trust_unreadable`, `image.pubkey_invalid`, `image.env_conflict` | Check the pinned image IDs, the digest and the trust key against PROD-RUNBOOK |
  | P7 | `checkout.stuck` | `billing.webhook_stuck` | Look at the Stripe event in the dashboard, then replay it, or refund |
  | P8 | `account.compromise` | `pool.secret_misuse`; `access.provider_action_unexpected` (rescue, console or password reset seen at the provider, which this Worker never does; closes itself after 24 h) | Rotate the build host token, review the provider's audit log, and freeze provisioning |

- **P1 in Better Stack** (outside our infra, set up by hand, not by this Worker): a monitor on `https://<prod worker>/health/readiness`,
  fail after 2 checks in a row, notifying the same Slack channel and policy as Flux. This is the only alert that still works when the
  Worker is down.
- **Digest-only alerts include**: `home.disk_high` (>=85%), `home.backup_stale` (>26 h, only for homes that report backups),
  `abuse.mining_suspected` (home event; stays open until an operator resolves it), the `access.*` notices, refunds and disputes,
  plan and resize steps, image-changed notices, mail retries.
  Recoveries are no longer posted one by one: a closed page group posts one resolve message.
- **Mining flag from lane 1**: the detector drops `{"type":"abuse.mining_suspected","at":<ms>}` as a file in
  `/var/lib/murage-home/events/` (root-owned dir; the control transport sends it on the next heartbeat and deletes it).
- **Daily digest**: first cron tick after 07:00 UTC, once per UTC day. First line "Nothing needs you today." or "N things need you:" with
  the open page groups; then the fleet line, 24 h counts by kind, the open digest items grouped by kind. On Mondays it adds the weekly
  review: for each page kind, times fired, time open, and whether support acted on that home while it was open (recorded only from
  `selfservice_audit`, actor `operator`; a kind with none is flagged "retune or demote").
- **Webhook**: Worker var/secret `ALERT_WEBHOOK_URL` (https only). Body: `{kind, severity, text, at}` plus, for pages, `group`, `count`, `homes`, `mention: "here"`; `text` works as-is for
  Slack/Discord-style hooks; a Telegram or email relay maps `text`. An undelivered page retries with backoff (1 min doubling, at most 1 h; 20 attempts). Set it with
  `printf %s "$URL" | wrangler secret put ALERT_WEBHOOK_URL`. Until set, page rows are stored and retried, not lost.
