// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RECALL-SKIP-DROP (1.0.16): the whole comms e2e suite again, with every overlapped memory recall skipped as if it had
// run past RECALL_WAIT_MS (testing/recall-skip-preload.mjs). A slow machine takes that branch now and then; this run
// takes it on every turn, so ask_bot's card, the timeout conversion and every hand-off are proven on it.
process.env.MURAGE_TEST_COMMS_RECALL_SKIP = "1";
await import("./comms.test.ts");
