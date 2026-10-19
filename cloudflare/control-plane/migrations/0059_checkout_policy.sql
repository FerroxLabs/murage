-- Cloud checkout WP1: per-country kill switch for NEW purchases (STRIPE-HOSTED-PLAN r13c §1.4), its audit trail, and the policy fields
-- stored with each consent. An absent switch row means "open". Running subscriptions are never read from these tables.
CREATE TABLE checkout_country_switch (
  country TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('open','paused')),
  updated_at INTEGER NOT NULL
);
-- One row, a counter. Every switch change bumps it in the same batch as the audit row; the effective policy version is
-- POLICY_VERSION when revision=0 and POLICY_VERSION+"+s<revision>" after that.
CREATE TABLE checkout_policy_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
);
CREATE TABLE checkout_policy_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL,
  old TEXT NOT NULL CHECK (old IN ('open','paused')),
  new TEXT NOT NULL CHECK (new IN ('open','paused')),
  reason TEXT NOT NULL,
  advice TEXT,
  ends_at INTEGER,
  actor TEXT NOT NULL,
  at INTEGER NOT NULL,
  policy_version TEXT NOT NULL
);
CREATE INDEX checkout_policy_audit_country ON checkout_policy_audit(country, at);

ALTER TABLE checkout_consents ADD COLUMN declared_country TEXT;     -- the country the customer confirmed on our page (picks the seller)
ALTER TABLE checkout_consents ADD COLUMN checkout_language TEXT;    -- the Stripe locale actually sent (de for DE/AT whatever the client said)
ALTER TABLE checkout_consents ADD COLUMN policy_version TEXT;       -- effective policy version at the time of the order
ALTER TABLE checkout_consents ADD COLUMN ip_country_hint TEXT;      -- pre-fill only, never used to decide
ALTER TABLE checkout_consents ADD COLUMN button_text TEXT;          -- the order-button words in the sent locale (BUTTON_WORDS)
ALTER TABLE checkout_consents ADD COLUMN site_language TEXT;        -- the site locale our disclosure was shown in (en or de)
