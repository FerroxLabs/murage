// SPDX-License-Identifier: AGPL-3.0-or-later
// Two-tier alerts (lanes/cloud-v2/ALERTS-TWO-TIER-DESIGN.md). Every alert kind raised in src/ is in this one table, either as a PAGE (urgent,
// actionable, rare: grouped by cause, sent to Slack with an @here) or as a DIGEST (one silent daily message). A kind missing from the table
// is DIGEST at run time, and test/alert-tiers.test.ts fails the build when a kind raised in src/ is missing, so a new kind must be classified.
//
// P1 (control plane down) is external: a Better Stack monitor on the prod Worker's /health/readiness, two failed checks in a row. It has
// no row here; its group is listed in PAGE_GROUPS only so it carries the same no-cap rule if anything ever routes to it.

/** When a page kind counts toward opening its group. Absent: one open alert is enough. */
export interface PageThreshold {
  /** Distinct homes (alert rows) that must be open together. */
  minHomes: number;
  /** The homes must be raised within this span of each other (any window of this length among the open rows), not within it of now. */
  windowMs?: number;
  /** Or this share of the fleet (at least 2 homes, so one silent home never pages by share alone). */
  fleetShare?: number;
  /** A row counts only once it has been open this long (measured from its raised_at to the sweep's clock). Until then it waits and the
   *  daily digest carries it, like any row under its threshold. Combine with minHomes: 1 for "page when one alert is older than this". */
  minAgeMs?: number;
}
export type AlertTierEntry =
  | { tier: "page"; group: string; action: string; threshold?: PageThreshold }
  | { tier: "digest" };

export interface PageGroup {
  title: string;
  /** Compromise and control-plane-down pages are never held back by the hourly cap or folded into the alert storm page. */
  bypassCap?: boolean;
  /** Never post a "resolved" all-clear for this group: closing it is silent (a compromise watch ending is not "nobody looked, so fine"). */
  silentClose?: boolean;
}
export const PAGE_GROUPS: Record<string, PageGroup> = {
  "restore.stuck": { title: "A customer's restore is stuck" },
  "homes.events_held": { title: "A customer's home is holding activity updates" },
  "control.down": { title: "Control plane down", bypassCap: true },
  "rollout.halted": { title: "Rollout halted" },
  "homes.not_created": { title: "New customers not getting homes" },
  "homes.unhealthy": { title: "Many homes unhealthy" },
  "homes.repair_gave_up": { title: "A customer home is down and auto-repair gave up" },
  "sales.stopped": { title: "Sales stopped" },
  "checkout.stuck": { title: "A paying customer is stuck at checkout" },
  "account.compromise": { title: "Possible account compromise", bypassCap: true, silentClose: true },
  "alerts.backlog_huge": { title: "The alert queue is stuck" },
  "credit.undelivered": { title: "A customer paid and got no credit" },
  "flux.secret_missing": { title: "Flux is switched on with a secret missing" },
  "credit.email_unverified": { title: "A paying customer waits for a Flux email check" },
  "credit.email_proof_disputed": { title: "A Flux email proof is disputed on a linked account" },
  "flux.email_wake_exhausted": { title: "A customer confirmed their email but Flux did not link" },
  "flux.ensure_verified_refused": { title: "Flux held a customer whose email is confirmed" },
  "flux.link_email_mismatch": { title: "A Flux link names a different email" },
  "pool.grabber_failing": { title: "The pool grabber has failed for 2 hours" },
  "flux.spending_off": { title: "A customer's Flux spending stop is not confirmed" },
  "flux.key_unrevoked": { title: "A Flux key that was never delivered is still not revoked" },
  "flux.stop_stuck": { title: "A Flux Stop has waited over an hour" },
  "flux.resume_stuck": { title: "A customer turned spending back on and the home has no key" },
  "flux.stop_unenforced": { title: "A stopped home still has a live key at Flux" },
};

/** Not in the design's P-list: the alert backlog is digest unless it is huge. */
export const ALERT_BACKLOG_HUGE_ALERT = "alerts.backlog_huge";
export const ALERT_BACKLOG_HUGE_AT = 600;
/** Raised by sweepProviderAccess when the hosting provider shows rescue, console or password-reset use that this Worker did not make. */
export const PROVIDER_ACTION_UNEXPECTED_ALERT = "access.provider_action_unexpected";
/** That alert ages out silently this long after it opens (nothing else resolves it; no "resolved" is ever posted for it), so its group
 *  closes and stops re-paging. It is raised again only by a new live provider read (access-audit), never from stored state. */
export const PROVIDER_ACTION_OPEN_MS = 24 * 3_600_000;

const ACT = {
  restoreStuck: "Open the home in admin and read its restore status, then retry the restore or rebuild the home from backup.",
  eventsHeld: "Owner: MurageCloud, in the Cloud alerts channel. The home's /data refuses writes, so its activity updates wait in memory. Open the home in admin, check /data (full or read-only), clear space or repair the volume; the held updates go out by themselves once writes work. Escalate to Sean only if the home cannot be repaired.",
  rollout: "Open the release, look at the failed homes, then cancel the release or ship a fixed N+1.",
  homesNotCreated: "Check build host stock, the server limit and the spend cap, and grab stock in another region.",
  unhealthy: "Check build host status and the last deploy or rollout. This is one page for all of them.",
  repair: "Open the home in admin, then resume it, or rebuild it from backup.",
  sales: "Check the pinned image IDs, the digest and the trust key against PROD-RUNBOOK. Sales stay closed until it is fixed.",
  checkout: "Look at the Stripe event in the dashboard, then replay it, or refund.",
  compromise: "Rotate the build host token, review the provider's audit log, and freeze provisioning.",
  fluxSecret: "Put the missing Flux secret named in the alert on the Worker, then watch the next Flux sweep clear it. Until then Flux gives no new keys or credit.",
  credit: "Open the home in admin and check the Flux account first, because a timed-out grant may still have landed. Then check the paid invoice, and grant the credit by hand or refund the payment.",
  emailUnverified: "See the runbook (PROD-RUNBOOK.md, Flux email proof). Ask the customer to press Email me a code on the Cloud page, or resend it with POST /v1/internal/flux/email-proof/resend. Never stamp by hand.",
  wakeExhausted: "See the runbook (PROD-RUNBOOK.md, Flux email proof). The customer confirmed the code, but the Flux link did not finish in 5 tries. Check Flux status, then the account.",
  verifiedRefused: "See the runbook (PROD-RUNBOOK.md, Flux email proof). Flux answered pending_verification to a confirmed email. Ask FluxMain why; the account is held until it links.",
  linkMismatch: "See the Flux email hold runbook (Escalate to Sean). It is an automatic page to the Cloud alerts channel for its owner (MurageCloud), and to Sean personally only if money is involved. Flux (FluxMain) re-points the link on MurageMain's word, and that decision is posted in the same channel. Do not change anything yourself.",
  emailDisputed: "See the runbook (PROD-RUNBOOK.md, Flux email proof). The Flux link is left as it is. Do not unlink by hand: Sean decides.",
  grabberPersistent: "Check the build host API and the pool reconcile (the digest shows the grabber's stage errors), then look for stray servers in the build host console.",
  spendingOff: "Open the home in admin and check the Flux account. The customer switched spending off and Flux has not confirmed it for over an hour. Stop the spending at Flux by hand, then let the next Flux sweep clear the alert.",
  keyUnrevoked: "Open the key in the alert and revoke it at Flux by hand. Then re-queue it with POST /v1/admin/step-up/undelivered-keys/requeue so the record settles. The customer was never given this key.",
  stopStuck: "Open the home in admin. A refund ended the plan but the Flux Stop has not gone through for over an hour. Check Flux status, then send the Stop again or revoke the credit at Flux by hand.",
  resumeStuck: "Open the home in admin. It is online and its poller has not taken a key for an hour. Check the poller log for renewal-due and subkey answers, then Flux status.",
  stopUnenforced: "Open the home in admin and check Flux status for the key. The sweep re-sends the Stop each pass. Resolve this alert only when Flux reports stopped or revoked for the key, or the customer turned spending back on and Flux shows the current generation. Anything else, or Flux ahead of the CP lifecycle: tell FluxMain.",
  backlog: "Check that the alert webhook answers, then look at the open alerts in the digest.",
};
const page = (group: string, action: string, threshold?: PageThreshold): AlertTierEntry => ({ tier: "page", group, action, ...(threshold ? { threshold } : {}) });

const PAGE_ENTRIES: Record<string, AlertTierEntry> = {
  "home.event_spool_failed": page("homes.events_held", ACT.eventsHeld),
  "restore.stuck": { title: "A customer's restore is stuck" },
  // P2: raised by the rollout controller (src/rollout.ts) when a release halts.
  "rollout.halted": page("rollout.halted", ACT.rollout),
  // P3
  "provision.failed": page("homes.not_created", ACT.homesNotCreated, { minHomes: 2, windowMs: 30 * 60_000 }),
  "pool.empty": page("homes.not_created", ACT.homesNotCreated),
  "pool.create_failing": page("homes.not_created", ACT.homesNotCreated),
  "pool.spend_cap_reached": page("homes.not_created", ACT.homesNotCreated),
  "home.ui_render_missing": page("homes.not_created", ACT.homesNotCreated, { minHomes: 2 }),
  // P4
  "home.heartbeat_missed": page("homes.unhealthy", ACT.unhealthy, { minHomes: 3, windowMs: 10 * 60_000, fleetShare: 0.05 }),
  // P5
  "home.watchdog_exhausted": page("homes.repair_gave_up", ACT.repair),
  "home.fixit_exhausted": page("homes.repair_gave_up", ACT.repair),
  "update.stuck": page("homes.repair_gave_up", ACT.repair),
  // P6
  "image.sales_hold": page("sales.stopped", ACT.sales),
  "image.trust_unreadable": page("sales.stopped", ACT.sales),
  "image.pubkey_invalid": page("sales.stopped", ACT.sales),
  "image.env_conflict": page("sales.stopped", ACT.sales),
  // P7
  "billing.webhook_stuck": page("checkout.stuck", ACT.checkout),
  // P8
  "pool.secret_misuse": page("account.compromise", ACT.compromise),
  [PROVIDER_ACTION_UNEXPECTED_ALERT]: page("account.compromise", ACT.compromise),
  // Money taken with nothing delivered, and nothing else: a charge went through and the router will not take the credit. An alert raised with
  // no charge (topup.flux_ineligible, topup.precheck_refused) is a digest.
  "flux.account_not_fresh": page("credit.undelivered", ACT.credit),
  "topup.paid_not_granted": page("credit.undelivered", ACT.credit),
  "credit.topup_ceiling": page("credit.undelivered", ACT.credit),
  // The grant's 20 automatic tries ran out (b4-flux.ts sendGrant): a paid customer with no credit and no further retry.
  "credit.grant_exhausted": page("credit.undelivered", ACT.credit),
  // PRODFLUX (MurageMain): Flux switched on with a secret missing holds every grant (and, without the service token, every Stop): page it.
  "credit.flux_service_token_absent": page("flux.secret_missing", ACT.fluxSecret),
  "credit.grants_token_absent": page("flux.secret_missing", ACT.fluxSecret),
  // FLUX-ENSURE-EMAIL-VERIFIED (ITEM4-PROOF-CURRENT alert lifecycle): a buyer still unproven 24 h after the home went active (once per account
  // and address revision), and a disputed proof on an account that is already linked.
  "credit.email_unverified_hold": page("credit.email_unverified", ACT.emailUnverified),
  "credit.email_proof_disputed": page("credit.email_proof_disputed", ACT.emailDisputed),
  // Proven, but the wake-up could not link in 5 tries; Flux answered 202 to a proven call; the id is linked at Flux under another email (M-d).
  "flux.email_wake_exhausted": page("flux.email_wake_exhausted", ACT.wakeExhausted),
  "flux.ensure_verified_refused": page("flux.ensure_verified_refused", ACT.verifiedRefused),
  "flux.link_email_mismatch_unlinked": page("flux.link_email_mismatch", ACT.linkMismatch),
  // POOL-GRABBER-PERSISTENT (src/warm-pool.ts pageGrabberPersistent): pool.tick_grabber open 2 h with no clean tick.
  "pool.grabber_persistent": page("pool.grabber_failing", ACT.grabberPersistent),
  // CH1 (charter clients, 11-07): money-adjacent Flux states a person must look at, not wait a day for. The first two page at once; the third is
  // a digest row until it has been open an hour (minAgeMs), then it pages. Below that age the digest carries it, like any row under a threshold.
  "flux.spending_off_unconfirmed": page("flux.spending_off", ACT.spendingOff),
  "flux.undelivered_key_unrevoked": page("flux.key_unrevoked", ACT.keyUnrevoked),
  "flux.stop_pending": page("flux.stop_stuck", ACT.stopStuck, { minHomes: 1, minAgeMs: 60 * 60_000 }),
  // 8b (SPENDING-RESUME-VIA-POLLER 2.7, 2.8): a resume the online home never took; a stopped home whose key is still live at the router.
  "flux.resume_undelivered": page("flux.resume_stuck", ACT.resumeStuck),
  "flux.stopped_key_live": page("flux.stop_unenforced", ACT.stopUnenforced),
  // The alert backlog, only when huge.
  [ALERT_BACKLOG_HUGE_ALERT]: page("alerts.backlog_huge", ACT.backlog),
};

/** Everything else. Listed by name so the table test can tell a classified kind from a forgotten one. */
const DIGEST_KINDS: readonly string[] = [
  "endpoints.tunnel_capacity",
  "abuse.mining_suspected",
  "access.action_time_unreadable", "access.history_too_long", "access.unmonitored",
  "alerts.backlog",
  "backup.storage_boxes_full",
  "billing.adjustment_payment_failed", "billing.customer_move_unsettled", "billing.customer_orphan_overdue", "billing.customer_orphan_review", "billing.event_stuck", "billing.payment_retained", "billing.portal_allows_plan_switch", "billing.resume_lapsed", "billing.resume_required", "billing.resume_unresolvable", "billing.suspended_payment_refunded", "billing.unverified_adjustment", "billing.webhook_api_version",
  "cancel.key_unsettled", "cancel.late_renewal_charge", "cancel.provider_failing", "cancel.resolution_forced_end", "cancel.resolution_unresolved", "cancel.unconfirmed",
  "cancellation.drafts_unsettled", "cancellation.execution_unsettled", "cancellation.identify", "cancellation.key_unsettled", "cancellation.mail_failing", "cancellation.mutation_unresolved", "cancellation.reason_overdue", "cancellation.receipt_integrity", "cancellation.stripe_drift", "cancellation.stripe_failing", "cancellation.stripe_unconfirmed", "cancellation.subscription_gone", "cancellation.unidentified",
  "checkout.acceptance_line_missing", "checkout.address_change", "checkout.async_payment_failed", "checkout.cutover_no_paid_invoice", "checkout.country_paused", "checkout.duplicate_subscription", "checkout.mismatch", "checkout.parked_order_released", "checkout.rejected_consent", "checkout.renewal_uncovered", "checkout.renewal_uncovered_paid", "checkout.replaced_boundary_unresolved", "checkout.replaced_invoice_unclassified", "checkout.replaced_late_payment", "checkout.replaced_session_invoice_missing", "checkout.replacement_async_payment_failed", "checkout.replacement_expired", "checkout.replacement_unrecoverable", "checkout.stranded_payment_refunded",
  // CLOUD-DISPUTE-UNLINKED-DIGEST (MurageMain 11-03): an email proof disputed on an account not linked to Flux yet. Owner: MurageCloud, who
  // follows up with the buyer within a day. Digest only, never a page (the linked case is the credit.email_proof_disputed page).
  "credit.email_proof_disputed_unlinked",
  "credit.delivery_owed", "credit.dispute_reversal_owed", "credit.flux_off", "credit.grant_held", "credit.grant_pending", "credit.grant_review", "credit.grant_suppressed", "credit.grants_url_absent", "credit.legacy_reversal_unreconciled", "credit.removal_owed", "credit.reversal_pending", "credit.reversal_ceiling", "credit.revision_mismatch", "credit.stale_claim_adjusted",
  "dispute.earlier_period", "dispute.historical_payment", "dispute.hold_escalated", "dispute.hold_unattributed", "dispute.inexact_lost", "dispute.lost", "dispute.movement_inexact", "dispute.poll_failing", "dispute.refunded_payment", "dispute.unattributed_payment", "dispute.unmatched",
  "export.manual_needed",
  "flux.ensure_account_refused", "flux.ensure_account_unauthorized", "flux.grant_held", "flux.not_wired", "flux.pending_capability", "flux.plan_change_pending",
  "home.backup_stale", "home.checkout_unresolved", "home.disk_high",
  "image.changed", "image.dispatch_unresolved", "image.policy_rolled_back", "image.readiness_failed", "image.revoked_server_present", "image.too_big_for_server_type", "image.unverified",
  "notice.dead", "notice.undelivered",
  "plan.changed_while_plan_change_off", "plan.downgrade_without_resize", "plan.resize_failed", "plan.resize_power_on_failed", "plan.resize_provider_unconfigured", "plan.resize_shutdown_outstanding", "plan.resize_stuck", "plan.resize_unhealthy", "plan.resize_waiting_for_backup",
  "pool.anomaly", "pool.below_red", "pool.create_lost_unsettled", "pool.image_unverified", "pool.limit_near", "pool.tick_fast", "pool.tick_grabber",
  "power.unconfirmed",
  "provision.dispatch_unsettled",
  "referral.enroll_failing",
  "refund.attribution_unresolved", "refund.coverage_pending", "refund.dispute_reinstated_after_final", "refund.dispute_returned_lowered", "refund.external", "refund.failed", "refund.historical_payment", "refund.plan_unresolved", "refund.receipt_payment_changed", "refund.reconcile_stuck", "refund.requested", "refund.statutory_deadline", "refund.stuck",
  "refund_identity.objection_due",
  // The site forwarder hit its global hourly cap on announcement signups (announcements.ts): one per hour, digest.
  "sendlane.forwarder_cap",
  // Unsubscribes through the forwarder hit their own global hourly cap (announcements.ts): one per hour, digest.
  "sendlane.unsubscribe_cap",
  "refund_key.checkout_blocked", "refund_key.previous_missing", "refund_key.previous_retired", "refund_key.replaced", "refund_key.retired_in_use",
  "terms.enforcement_dead", "terms.notice_dead",
  "topup.flux_ineligible", "topup.not_applied", "topup.precheck_refused",
  "update.rolled_back",
  // An app signup sent consent words that match no known card (announcements.ts): one per hour, digest, never a page.
  "updates.app_unmatched",
  "withdrawal.mail_key_missing", "withdrawal.mail_stuck", "withdrawal.overdue", "withdrawal.refund_due_today",];

export const ALERT_TIER: Readonly<Record<string, AlertTierEntry>> = Object.freeze({
  ...Object.fromEntries(DIGEST_KINDS.map((kind) => [kind, { tier: "digest" } as AlertTierEntry])),
  ...PAGE_ENTRIES,
});

/** The tier of a kind: digest unless the table says page. */
export function alertTier(kind: string): AlertTierEntry {
  return Object.prototype.hasOwnProperty.call(ALERT_TIER, kind) ? ALERT_TIER[kind] : { tier: "digest" };
}
export const isPageKind = (kind: string): boolean => alertTier(kind).tier === "page";
export const PAGE_KINDS: readonly string[] = Object.keys(PAGE_ENTRIES);
