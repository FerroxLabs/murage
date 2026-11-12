-- 0149_updates_consent_v5: updates consent, design UPDATES-CONSENT-1020-CP-v5.md v5.6.1 (text from the prepared design migration, v5.6.1). Number 0149: ONECODE ships first on 1.0.18 and takes the one before.
CREATE TABLE updates_consent_texts (version TEXT PRIMARY KEY CHECK (version GLOB '[0-9a-z]*' AND length(version) <= 40),
  locale TEXT NOT NULL DEFAULT 'en', body TEXT NOT NULL, effective_from INTEGER NOT NULL);
CREATE TABLE updates_consent (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('account','receipt','signup','legacy')),
  subject_id TEXT NOT NULL UNIQUE,
  account_id TEXT, receipt_hash TEXT UNIQUE,
  email TEXT CHECK (email IS NULL OR (length(email) BETWEEN 3 AND 254 AND email = lower(trim(email)))),
  email_key TEXT NOT NULL CHECK (length(email_key) = 64),
  status TEXT NOT NULL CHECK (status IN ('opted_in','withdrawn')),
  generation INTEGER NOT NULL DEFAULT 1, proven_at INTEGER,
  unproven_since INTEGER,
  mut_nonce TEXT UNIQUE,
  -- mint time of the prove token that proved this generation; 0 for a sign-in proof (beats no exclusion event, v5.3)
  proof_minted_at INTEGER,
  -- v5.3: server time this generation's consent was recorded (never the client's answeredAt). P requires every exclusion event to be older.
  consented_at INTEGER,
  off_by TEXT CHECK (off_by IS NULL OR off_by IN ('owner','link','site','operator','move')),
  text_version TEXT NOT NULL REFERENCES updates_consent_texts(version), site_consent_id INTEGER,
  name TEXT CHECK (name IS NULL OR length(name) <= 80),
  install_id TEXT, app_version TEXT NOT NULL, source TEXT NOT NULL,
  answered_at INTEGER NOT NULL, status_changed_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK (kind <> 'receipt' OR receipt_hash IS NOT NULL), CHECK (kind <> 'account' OR account_id IS NOT NULL),
  CHECK (proven_at IS NOT NULL OR status <> 'opted_in' OR unproven_since IS NOT NULL),
  CHECK (proven_at IS NULL OR proof_minted_at IS NOT NULL),
  CHECK (status <> 'opted_in' OR consented_at IS NOT NULL));
CREATE TABLE updates_tokens (token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  token_id TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('prove','unsub')), consent_id TEXT, email_key TEXT NOT NULL, generation INTEGER,
  key_version INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, consume_nonce TEXT UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE updates_mail_outbox (id TEXT PRIMARY KEY, consent_id TEXT NOT NULL, generation INTEGER NOT NULL,
  -- v5.5: guide_only is cut (one mail per (row, generation), the gate G issues guide_prove or nothing); every outbox row holds its token
  template TEXT NOT NULL CHECK (template IN ('prove','prove_waitlist','guide_prove')),
  token_hash TEXT NOT NULL, key_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','sending','sent','uncertain','dropped')),
  claim_nonce TEXT, claimed_until INTEGER, created_at INTEGER NOT NULL, done_at INTEGER);
CREATE TABLE updates_consent_events (id INTEGER PRIMARY KEY, consent_id TEXT NOT NULL, at INTEGER NOT NULL,
  from_status TEXT, to_status TEXT, generation INTEGER NOT NULL, text_version TEXT, actor TEXT NOT NULL);
-- v5.3: points at the exclusion event the fresh proof beat
CREATE TABLE updates_reconsent_audit (id INTEGER PRIMARY KEY, email_key TEXT NOT NULL, old_event_id INTEGER NOT NULL, old_kind TEXT NOT NULL,
  old_observed_at INTEGER NOT NULL, consent_id TEXT NOT NULL, at INTEGER NOT NULL);
-- v5.3: updates_resend_flags is dropped; every observation is an exclusion event below.
CREATE TABLE updates_webhook_seen (svix_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE updates_send_runs (id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('snapshot','resend_read','sending','done','aborted')),
  active INTEGER CHECK (active IS NULL OR active = 1),
  subject TEXT NOT NULL, body_version TEXT NOT NULL,
  snapshot_at INTEGER, resend_cycle INTEGER NOT NULL DEFAULT 0, resend_read_at INTEGER, resend_cycle_started_at INTEGER,
  resend_phase TEXT CHECK (resend_phase IS NULL OR resend_phase IN ('contacts','suppressions')), resend_cursor TEXT, resend_pages INTEGER NOT NULL DEFAULT 0, next_batch INTEGER NOT NULL DEFAULT 1,
  lease_nonce TEXT, lease_until INTEGER, abort_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX updates_one_active_run ON updates_send_runs(active);
CREATE TABLE updates_send_recipients (run_id TEXT NOT NULL, email_key TEXT NOT NULL, email TEXT, consent_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('candidate','reading','read_ok','claimed','sent','refused','uncertain','excluded')),
  batch_no INTEGER, sendlane_at INTEGER, claim_nonce TEXT, provider_id TEXT,
  reason TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (run_id, email_key));
CREATE TABLE updates_send_batches (run_id TEXT NOT NULL, batch_no INTEGER NOT NULL, idem_key TEXT NOT NULL UNIQUE CHECK (length(idem_key) <= 256),
  state TEXT NOT NULL CHECK (state IN ('claimed','sent','retry','refused','uncertain','void')), dispatch_nonce TEXT, reason TEXT,
  claim_nonce TEXT NOT NULL, payload_hash TEXT, attempts INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (run_id, batch_no));
CREATE INDEX updates_consent_key ON updates_consent(email_key);
CREATE INDEX updates_consent_status ON updates_consent(status, proven_at);
CREATE INDEX updates_tokens_consent ON updates_tokens(consent_id);
CREATE INDEX updates_outbox_state ON updates_mail_outbox(state, created_at);
CREATE INDEX updates_outbox_consent ON updates_mail_outbox(consent_id, generation);
CREATE INDEX updates_events_consent ON updates_consent_events(consent_id, at);
CREATE INDEX updates_recipients_batch ON updates_send_recipients(run_id, batch_no, state);
-- v5.5 (replaces updates_forward_requests): ONE request-identity table for every path. The gate RQ inserts the row FIRST, with the outcome
-- 'refused' when the key is excluded (erase, complaint, bounce, an uncleared resend_unsub or sendlane_global) and 'pending' otherwise; the
-- limits FL1 and FL2 charge every first delivery, 'pending' or 'refused' alike (v5.6.1), FL3 fixes 'rate_limited' for either; row writes and the
-- obligation G require this request's nonce to be 'pending'; RO fixes the final outcome once. A replay of the id
-- (ON CONFLICT DO NOTHING) owns no nonce, so it charges, writes, mints and mails nothing and reads back the first delivery's outcome.
-- request_id: 'desk:'||receipt_hash||':'||answeredAt (desktop), the site's requestId (forwarder), 'legacy:'||email_key||':'||10-minute bucket
-- (1.0.19), 'acct:'||account_id||':'||answeredAt (members). Never pruned by time (no K6, v5.6): a row leaves only with the erase batch;
-- key only; 'invalid' rows (RJ) hold no key.
CREATE TABLE updates_requests (request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 16 AND 120),
  path TEXT NOT NULL CHECK (path IN ('desktop','forwarder','legacy','members')),
  subject_id TEXT, email_key TEXT CHECK (email_key IS NULL OR length(email_key) = 64),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  nonce TEXT NOT NULL UNIQUE, at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','refused','rate_limited','invalid','admitted','capped','noop')));
CREATE INDEX updates_requests_at ON updates_requests(at);
CREATE INDEX updates_requests_key ON updates_requests(email_key);
-- v5.5: the durable obligation marker, ONE per (consent row, generation), written only by the gate G. It outlives the outbox row (K8) and the
-- token (30 days after expiry); it is deleted only with its consent row (K1b, erase). No second prove or guide mail for a generation can ever
-- be issued, whatever happened to the first mail's rows.
CREATE TABLE updates_obligations (consent_id TEXT NOT NULL, generation INTEGER NOT NULL,
  email_key TEXT NOT NULL CHECK (length(email_key) = 64), request_id TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE,
  template TEXT NOT NULL CHECK (template IN ('prove','prove_waitlist','guide_prove')),
  outbox_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64), at INTEGER NOT NULL,
  PRIMARY KEY (consent_id, generation));
CREATE INDEX updates_obligations_key ON updates_obligations(email_key);
-- v5.5: a receipt that RS3 rotated away from is retired for good: RS1 never recreates its subject_id and RS3 never rotates onto it (hash only)
CREATE TABLE updates_retired_receipts (receipt_hash TEXT PRIMARY KEY CHECK (length(receipt_hash) = 64), consent_id TEXT NOT NULL, at INTEGER NOT NULL);
-- v5.3: the support clear audit (who, when, which written request, both fresh provider reads); key only
CREATE TABLE updates_exclusion_clear_audit (id INTEGER PRIMARY KEY, email_key TEXT NOT NULL CHECK (length(email_key) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('support_clear')), request_ref TEXT NOT NULL CHECK (length(request_ref) BETWEEN 3 AND 120),
  cleared_by TEXT NOT NULL CHECK (length(cleared_by) BETWEEN 1 AND 80),
  resend_checked_at INTEGER NOT NULL, sendlane_checked_at INTEGER NOT NULL,
  -- v5.5: only AFFIRMATIVE provider answers are ever recorded: Resend 2xx with unsubscribed=false, Sendlane 'ok'. A 404 of any kind,
  -- a non-2xx, an unreadable body or a Sendlane global/unread refuses the clear in CX1 and writes nothing.
  resend_result TEXT NOT NULL CHECK (resend_result IN ('unsubscribed_false')),
  sendlane_result TEXT NOT NULL CHECK (sendlane_result IN ('ok')),
  clear_nonce TEXT NOT NULL UNIQUE, at INTEGER NOT NULL);
-- v5.3: APPEND-ONLY exclusion events, key only. Never updated, never deleted (erase included: the rows hold no address and keep erase terminal).
-- kind: our_unsub (our link, one-click, site page, operator off), list37 (imported 0146 rows), resend_unsub (every observation of unsubscribed=true),
-- complaint, bounce (Resend suppression, bounce, manual), sendlane_global (a send-time read), erase (terminal), cleared (support clear, 9.5).
CREATE TABLE updates_exclusion_events (id INTEGER PRIMARY KEY, email_key TEXT NOT NULL CHECK (length(email_key) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('our_unsub','list37','resend_unsub','complaint','bounce','sendlane_global','erase','cleared')),
  observed_at INTEGER NOT NULL, source TEXT NOT NULL CHECK (source IN ('link','one_click','site','operator','import','resend_read','webhook','sendlane_read','support')),
  ref INTEGER, at INTEGER NOT NULL);
CREATE INDEX updates_exclusion_events_key ON updates_exclusion_events(email_key, kind, observed_at);
CREATE TRIGGER updates_exclusion_events_no_update BEFORE UPDATE ON updates_exclusion_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER updates_exclusion_events_no_delete BEFORE DELETE ON updates_exclusion_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
-- v5.4 (GB-M2): list 37 opt-outs count as exclusions from the moment of migration. The migration copies every 0146 list 37 row as a
-- list37 event (list 37's list_id is the literal '37' in 0146; confirm against SENDLANE_LIST_ID at build), and two triggers mirror every
-- later 0146 list 37 write (SU1, or old code still running between migration and deploy) into an event. No operator step is involved.
INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at)
 SELECT o.email_key,'list37',o.unsubscribed_at,'import',NULL,CAST(strftime('%s','now') AS INTEGER)*1000 FROM announcement_optouts o WHERE o.list_id='37'
  AND NOT EXISTS (SELECT 1 FROM updates_exclusion_events x WHERE x.email_key=o.email_key AND x.kind='list37' AND x.observed_at=o.unsubscribed_at);
CREATE TRIGGER updates_list37_mirror_insert AFTER INSERT ON announcement_optouts WHEN NEW.list_id='37'
 BEGIN INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at) VALUES (NEW.email_key,'list37',NEW.unsubscribed_at,'import',NULL,CAST(strftime('%s','now') AS INTEGER)*1000); END;
CREATE TRIGGER updates_list37_mirror_update AFTER UPDATE OF unsubscribed_at ON announcement_optouts WHEN NEW.list_id='37' AND NEW.unsubscribed_at<>OLD.unsubscribed_at
 BEGIN INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at) VALUES (NEW.email_key,'list37',NEW.unsubscribed_at,'import',NULL,CAST(strftime('%s','now') AS INTEGER)*1000); END;
-- v5.6.2 seed (MurageMain 11-07): append-only consent text rows, never edited; a copy change adds a new row. Each body is byte-exact
-- from its source; test/updates-consent-texts.test.ts compares every row to the excerpt in test/fixtures/updates-consent-texts/.
-- Selection: the forwarder binds ?5 by validated source (guide, waitlist, else site-news); source app by an exact byte match of
-- consentText among the three app rows, else app-unmatched (the words kept at ?22 as data only); the anonymous pre-1.0.7 path binds
-- legacy-pre-1.0.7 (those apps sent no words: the row holds the hello card every release from 0.1.59 to 1.0.6 showed).
INSERT INTO updates_consent_texts (version, locale, body, effective_from) VALUES ('2026-11-06', 'en', 'Get Murage updates? We''ll email you about new features and tips, about twice a month. You can unsubscribe any time. Your email: [field]. Buttons: No thanks / Yes, send me updates. After yes: Sent to {email}. Check your inbox to confirm. You can turn this off any time in Settings, then About and help.', 1793923200000);
INSERT INTO updates_consent_texts (version, locale, body, effective_from) VALUES ('app-1.0.7-hello', 'en', 'Where should I send your setup guide?'||char(10)||'We''ve put together a short guide to getting the most out of Murage from day one, and I''d like to send it to you. Tell me your name so I know who I''m working for, and your email so the guide is yours, along with every new release, insight, how-to and tutorial we put out. Or just press Skip.', 1793059200000);
INSERT INTO updates_consent_texts (version, locale, body, effective_from) VALUES ('app-1.0.12-hello', 'en', 'Hello'||char(10)||'For your setup guide and news. Nothing else.', 1793491200000);
INSERT INTO updates_consent_texts (version, locale, body, effective_from) VALUES ('app-settings', 'en', 'Get the setup guide and every new release'||char(10)||'Insights, how-tos and tutorials so you always know the newest things Murage can do for you.', 1793059200000);
INSERT INTO updates_consent_texts (version, locale, body, effective_from) VALUES ('site-guide', 'en', 'Also email me occasional Murage news', 1793923200000);
INSERT INTO updates_consent_texts (version, locale, body, effective_from) VALUES ('site-waitlist', 'en', 'Email me when Murage for Team and Business opens', 1793923200000);
INSERT INTO updates_consent_texts (version, locale, body, effective_from) VALUES ('site-news', 'en', 'Keep me up to date on new releases, insights, how-tos and tutorials. Unsubscribe at any time.', 1793923200000);
INSERT INTO updates_consent_texts (version, locale, body, effective_from) VALUES ('legacy-pre-1.0.7', 'en', 'First, who am I working for?'||char(10)||'I am your chief of staff. Your name is what I call you. Your email is how Murage tells you when there is something new it can do.', 0);
INSERT INTO updates_consent_texts (version, locale, body, effective_from) VALUES ('app-unmatched', 'en', 'The app sent words that match no known Murage card. The exact words it sent are kept with this record as data, never shown as a page or sent in an email.', 0);
CREATE TRIGGER updates_consent_texts_no_update BEFORE UPDATE ON updates_consent_texts BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER updates_consent_texts_no_delete BEFORE DELETE ON updates_consent_texts BEGIN SELECT RAISE(ABORT, 'append-only'); END;
-- Held rows (MurageMain 11-07): no consent may point at 2026-11-06 (the unbuilt 1.0.20 card, its body still holds "[field]") until the
-- 1.0.20 build has a byte test on the rendered card. The routes refuse it as bad_text_version; these refuse it in SQL. Lift = a new migration.
CREATE TRIGGER updates_consent_text_held_insert BEFORE INSERT ON updates_consent WHEN NEW.text_version = '2026-11-06' BEGIN SELECT RAISE(ABORT, 'text_version_held'); END;
CREATE TRIGGER updates_consent_text_held_update BEFORE UPDATE OF text_version ON updates_consent WHEN NEW.text_version = '2026-11-06' BEGIN SELECT RAISE(ABORT, 'text_version_held'); END;
