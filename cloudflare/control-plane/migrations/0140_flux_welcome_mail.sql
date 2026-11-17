-- The one Flux welcome email per Murage account, ever (src/flux-link.ts ensureOwnerLinked, src/flux-welcome-mail.ts). The row is written in
-- the same batch as the owner's FIRST flux_links row, and only then. It is never deleted (not by an unlink, not by a later link), so a
-- retry, a second home or a link after an unlink never sends the email again. `created`: Flux made the account at that link (no password
-- set on it), else the account already existed. The words are rendered at send time (the link from FLUX_APP_BASE); no address is stored.
-- `attempt_token`: the claim that owns the current try; only that claim may record sent_at. `terminal`: the row is finished without a
-- send ('pre_existing': linked before this migration; 'gave_up': 8 tries failed). A terminal row is never due and never requeued.
CREATE TABLE flux_welcome_mail (
  owner_user_id TEXT PRIMARY KEY,
  created INTEGER NOT NULL CHECK (created IN (0, 1)),
  queued_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempt_token TEXT,
  terminal TEXT CHECK (terminal IS NULL OR terminal IN ('pre_existing', 'gave_up'))
);
-- The cron sweep reads the due, unsent, live rows.
CREATE INDEX flux_welcome_mail_due ON flux_welcome_mail(next_attempt_at) WHERE sent_at IS NULL AND terminal IS NULL;
-- Every owner linked (or unlinked, flux_link_floor) before this migration already had their first link: suppressed, never mailed.
INSERT OR IGNORE INTO flux_welcome_mail (owner_user_id, created, queued_at, attempts, next_attempt_at, sent_at, terminal)
  SELECT owner_user_id, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'pre_existing'
  FROM (SELECT owner_user_id FROM flux_links UNION SELECT owner_user_id FROM flux_link_floor);
