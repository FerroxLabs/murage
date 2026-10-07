-- last_seen_at now measures successful device use, publish or delivery.
-- Give existing devices and bindings a full retention interval from migration.
ALTER TABLE relay_bindings ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0;
UPDATE relay_bindings SET last_active_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
UPDATE relay_devices SET last_seen_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
CREATE INDEX IF NOT EXISTS relay_bindings_activity ON relay_bindings(last_active_at);
CREATE INDEX IF NOT EXISTS relay_devices_activity ON relay_devices(last_seen_at);
