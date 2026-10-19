-- SPDX-License-Identifier: AGPL-3.0-or-later
-- B3 auto-canary (Astra AUTOCANARY-1 P2): the home generation whose heartbeat wrote this health row. Written only while it equals
-- cloud_homes.generation (ops-monitor.ts recordHealth); the automatic canary accepts health only at the home's current generation.
-- Existing rows (and CP0 rows) stay NULL, which no B3 generation matches.
ALTER TABLE cloud_home_health ADD COLUMN generation INTEGER;
-- app_ok: the latest app report's outcome (1/0) for DISPLAY (self-service appOutcome, the watchdog): ordered by the control plane's receipt
-- time, a same-millisecond pair merged fail-closed (MIN), app_ok_at the latest success seen (Astra AUTOCANARY-3/4 P2). Existing rows stay
-- NULL: readers take their outcome as app_ok_at=app_reported_at. The automatic canary never decides on display order: see evidence_epoch.
ALTER TABLE cloud_home_health ADD COLUMN app_ok INTEGER;
-- B3 auto-canary evidence epochs (Astra AUTOCANARY-10, replacing every home- or clock-based ordering of rounds 6-11). Ordering is defined
-- by the control plane alone. evidence_epoch: the current epoch of this home at this generation (0 when the row is created or reset for a
-- new generation). Every negative event bumps it in the same statement that records it: a failing check in a report, a failing control
-- plane probe, a dropped report (no or a stale echoed epoch, another generation, a refused render), an authenticated heartbeat rejected by
-- validation, a generation change and the home leaving 'checking' (explicit, below). A PASS never bumps it. The heartbeat ack returns it and
-- murage-control echoes it on its next heartbeat (health.evidenceEpoch); a report is accepted only when the echo equals it.
ALTER TABLE cloud_home_health ADD COLUMN evidence_epoch INTEGER NOT NULL DEFAULT 0;
-- report_epoch: the epoch the stored home report (app_ok and the checks below) was ACCEPTED under; NULL after a dropped report. The canary
-- promotes only when report_epoch = probe_epoch = evidence_epoch: every required item passing and recorded at the current epoch.
ALTER TABLE cloud_home_health ADD COLUMN report_epoch INTEGER;
-- report_echo: 1 when the latest report echoed an epoch (accepted or stale), 0 when it carried none (a daemon older than evidence epochs,
-- a legacy field, a daemon's first report after a restart), NULL before any report at this generation. The canary judges only a home
-- whose latest report echoed one (Astra AUTOCANARY-11 P2-2: an old daemon's PASS is "needs update", never probed or render-alerted).
ALTER TABLE cloud_home_health ADD COLUMN report_echo INTEGER;
-- report_at: the control plane's receipt time of that accepted report (freshness, render age and transit are judged from it, on our clock).
ALTER TABLE cloud_home_health ADD COLUMN report_at INTEGER;
-- The home's own readiness checks (Astra AUTOCANARY-2/4 P1), from the latest report: the built web UI is on the image (ui_bundle_ok), the
-- data volume takes a durable write (data_writable_ok), the app rendered its UI in its own sandboxed browser (ui_renders_ok). 1/0, NULL
-- when the report carried none. An accepted report writes them; a dropped one only lowers them (its failures apply, its passes never do).
ALTER TABLE cloud_home_health ADD COLUMN ui_bundle_ok INTEGER;
ALTER TABLE cloud_home_health ADD COLUMN data_writable_ok INTEGER;
ALTER TABLE cloud_home_health ADD COLUMN ui_renders_ok INTEGER;
-- The render's details from the same accepted report (Astra AUTOCANARY-5/7 P1): when it finished (checks.uiAt), the app process that did it
-- (checks.uiInstance), the boot id of the heartbeat that carried it, its age on the home's own clock (checks.uiAgeMs) and that sample's wall
-- time (clock.wallMs). The canary bounds the age (plus time since receipt) and the transit (receipt minus sample).
ALTER TABLE cloud_home_health ADD COLUMN ui_rendered_at INTEGER;
ALTER TABLE cloud_home_health ADD COLUMN ui_instance TEXT;
ALTER TABLE cloud_home_health ADD COLUMN ui_boot_id TEXT;
ALTER TABLE cloud_home_health ADD COLUMN ui_age_ms INTEGER;
ALTER TABLE cloud_home_health ADD COLUMN app_sampled_at INTEGER;
-- The render (ui_rejected_instance, ui_rejected_at) refused at its first observation for being dated more than two minutes ahead of the
-- control plane's clock (Astra AUTOCANARY-6 P1): a heartbeat repeating that pair stays refused however much later it arrives.
ALTER TABLE cloud_home_health ADD COLUMN ui_rejected_at INTEGER;
ALTER TABLE cloud_home_health ADD COLUMN ui_rejected_instance TEXT;
-- The control plane's own public probe (Astra AUTOCANARY-1/3/5 P1), recorded only against the epoch read when the probe STARTED (a
-- compare-and-set on evidence_epoch; else dropped and the epoch bumped): probe_epoch, the app instance the public /api/health named
-- (probe_instance, which must be the stored report's ui_instance), the public render time (probe_ui_at, its age judged again at
-- promotion) and when it was recorded (probe_at). A failed probe clears probe_epoch and bumps the epoch.
ALTER TABLE cloud_home_health ADD COLUMN probe_epoch INTEGER;
ALTER TABLE cloud_home_health ADD COLUMN probe_instance TEXT;
ALTER TABLE cloud_home_health ADD COLUMN probe_ui_at INTEGER;
ALTER TABLE cloud_home_health ADD COLUMN probe_at INTEGER;
-- Diagnostics only (never compared with any time): why the epoch was last bumped (drop_reason) and when (dropped_at, receipt time).
ALTER TABLE cloud_home_health ADD COLUMN drop_reason TEXT;
ALTER TABLE cloud_home_health ADD COLUMN dropped_at INTEGER;
-- A generation change, and the home leaving 'checking' or entering it, is a negative event (Astra AUTOCANARY-10). No trigger does it (Astra
-- AUTOCANARY-11 P2-1: a trigger's row counts in the writing statement's meta.changes, so committed transitions reported failure): every
-- writer that changes a home's generation or desired_state bumps the epoch explicitly, in the same batch (ops-monitor.ts homeChangeBump),
-- except the promotion (checking to ready), whose batch re-checks the evidence at the epoch it read.
-- B3 auto-canary (Astra AUTOCANARY-2 P2): when the control plane last probed this home's public endpoint. Probe candidates are taken
-- oldest probe first (NULL, never probed, first), so a home whose probe keeps failing waits behind every other candidate and ten failing
-- homes cannot starve the eleventh (b3-control.ts autoCanaryPass).
ALTER TABLE provision_attempts ADD COLUMN probed_at INTEGER;
-- B3 auto-canary (Astra AUTOCANARY-5 P2): since when this home's every other piece of evidence (D1 and the public probe) has been green
-- while its render evidence was not; NULL otherwise. Ten minutes of it raise home.ui_render_missing (b3-control.ts autoCanaryPass).
ALTER TABLE provision_attempts ADD COLUMN ui_missing_since INTEGER;
-- B3 auto-canary (Astra AUTOCANARY-6/7 P2): a resolution recorded without network (reconcile and promotion never wait on the webhook);
-- 1 while its ".resolved" notice is owed, cleared only when a send of it succeeded.
ALTER TABLE cloud_alerts ADD COLUMN resolve_notice_due INTEGER;
-- Recoverable delivery claims (Astra AUTOCANARY-7 P2): a sender sets the claim (until when it owns the send, which is also the retry
-- backoff) and counts the attempt before it sends; only a successful send acknowledges (delivered_at, resolve_notice_due=NULL). A send
-- that failed, timed out or whose worker died is retried by a later sweep once the claim expires; two sweeps never send concurrently.
ALTER TABLE cloud_alerts ADD COLUMN delivery_claim_until INTEGER;
ALTER TABLE cloud_alerts ADD COLUMN resolve_claim_until INTEGER;
ALTER TABLE cloud_alerts ADD COLUMN resolve_attempts INTEGER NOT NULL DEFAULT 0;
