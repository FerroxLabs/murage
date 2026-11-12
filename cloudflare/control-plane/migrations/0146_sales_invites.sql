-- Invite-only sales (CLOUD_SALES_OPEN "invite"): the emails allowed to reserve, check out and resume. One point lookup per request.
-- email is stored lowercase and trimmed (the CHECK refuses anything else); the CP lower-cases and trims the session's address the same way.
CREATE TABLE IF NOT EXISTS sales_invites (
  email TEXT PRIMARY KEY CHECK (email = lower(trim(email)) AND email <> ''),
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  note TEXT
);
