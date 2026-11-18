-- SPDX-License-Identifier: AGPL-3.0-or-later
-- CH1 P2: the Flux Stop a refund queued (b4-flux answered "stopping"), by its flux_home_ops.op_id, so the sweep can read that Stop's terminal outcome
-- (done or superseded) even after the refund completed, stamp credits_revoked_at and resolve the flux.stop_pending alert. Additive; NULL = none queued.
ALTER TABLE refund_ops ADD COLUMN flux_stop_op_id TEXT;
