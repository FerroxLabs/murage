// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-process-only preload for the index harness (server/testing/index-harness.ts). A test file that sets
// MURAGE_TEST_UNBOUNDED_REVOKE_BUDGET=1 before the harness starts gets a server child whose revoke marker write budget
// (server/memory/revoke-budget.ts, the per-minute bytes every marker slice draws on) is lifted, as
// server/memory/revoke-bounded.test.ts lifts it in-process. The budget has its own tests (revoke-budget.test.ts); a suite
// that fires many revokes in one minute is not testing it, and behind it the marker's holds outlast the suite's own waits.
// Production never loads this file: only the harness passes it, and only when the variable is set.
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.env.MURAGE_TEST_UNBOUNDED_REVOKE_BUDGET === "1") {
  const { REVOKE_WRITE_BUDGET } = await import("../memory/revoke-budget.ts");
  REVOKE_WRITE_BUDGET.bytesPerMinute = Number.POSITIVE_INFINITY;
}
