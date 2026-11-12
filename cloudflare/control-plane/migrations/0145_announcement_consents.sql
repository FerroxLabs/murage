-- The site forwarder (POST /v1/announcements/subscribe with X-Murage-Site-Token): one row per forwarded signup, recording where it came
-- from and the words the person agreed to. The address is never stored: email_key is the same HMAC the per-address rate limit uses.
-- list_id is the Sendlane list it was sent to, NULL when it was recorded only (a waitlist signup with no waitlist list configured).
-- Retention: 3 years, pruned by the route on every forwarded signup.
CREATE TABLE announcement_consents (
  id INTEGER PRIMARY KEY,
  email_key TEXT NOT NULL CHECK (length(email_key) = 64),
  source TEXT NOT NULL CHECK (source IN ('site', 'footer', 'download', 'app', 'waitlist', 'guide')),
  consent_text TEXT CHECK (consent_text IS NULL OR length(consent_text) BETWEEN 1 AND 500),
  list_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX announcement_consents_created_idx ON announcement_consents(created_at);
CREATE INDEX announcement_consents_email_idx ON announcement_consents(email_key);
