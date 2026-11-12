-- Tester feedback from the "?" panel ("Tell us what was confusing"), POST /v1/owner-feedback (src/owner-feedback.ts).
-- Private: read only through the operator routes (CLOUD_ADMIN_TOKEN). It never holds messages, files, keys or memory:
-- the body is an allowlist (screen name, what the screen shows, the owner's words), the words are scrubbed for secret
-- shapes on the desktop and again here, and the install id is kept only as an HMAC under a Worker-secret pepper.
CREATE TABLE owner_feedback (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  install_hash TEXT NOT NULL CHECK (length(install_hash) = 64),
  app_version TEXT NOT NULL,
  os TEXT NOT NULL CHECK (os IN ('macos', 'windows', 'linux')),
  surface TEXT NOT NULL CHECK (surface IN ('desktop', 'phone', 'cloud')),
  screen TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  words TEXT NOT NULL,
  reply_email TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'fixed', 'answered'))
);

-- The per-install limits (1 a minute, 20 a day) count this table's rows.
CREATE INDEX owner_feedback_install_idx ON owner_feedback(install_hash, received_at);
-- The twice-daily triage reads by status, oldest first.
CREATE INDEX owner_feedback_status_idx ON owner_feedback(status, received_at);
-- The daily ceiling over every install (400 a UTC day) and the 90-day retention sweep count by time alone.
-- No per-caller table: the edge limiter keys callers by /64 (designs/UX-FEEDBACK-LIMITS-1012.md).
CREATE INDEX owner_feedback_received_idx ON owner_feedback(received_at);
