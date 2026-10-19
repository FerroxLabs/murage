-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra round 8. A refund operation is keyed to the exact payment it refunds: the payment intent is stored when the operation is opened
-- (refund_ops.payment_intent), and the charge when it is known.
ALTER TABLE refund_ops ADD COLUMN charge_id TEXT;
