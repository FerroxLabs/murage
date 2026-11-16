// SPDX-License-Identifier: AGPL-3.0-or-later
// BG enforcement producer owner: scperf-p1. B34 readiness consumer owner: new3-g2d.
import { IO_BUDGET_INTERVAL_MS } from "../../io-budget.ts";
// MAIN RULING INT-CONFLICT-DEFAULT 8f8f4e945fb b36bf61264c: observe real BG admission across two intervals; budgets are unchanged.
export const NATIVE_BACKGROUND_READY_MS = 2 * IO_BUDGET_INTERVAL_MS + 30_000;
