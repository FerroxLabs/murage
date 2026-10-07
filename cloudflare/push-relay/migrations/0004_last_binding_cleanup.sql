-- Runs within the deleting statement's transaction, including cron and revocation.
-- A newly registered device with no binding yet still gets its pairing interval.
CREATE TRIGGER IF NOT EXISTS relay_forget_unbound_device
AFTER DELETE ON relay_bindings
BEGIN
  DELETE FROM relay_devices
  WHERE id = OLD.device_id
    AND NOT EXISTS (SELECT 1 FROM relay_bindings WHERE device_id = OLD.device_id);
END;
