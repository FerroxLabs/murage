// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-process-only preload for a spawned server child (node --import <this file>). The Vitest worker sets the
// host-power test unwrap in its own memory (server/testing/setup.ts), and a symbol in memory cannot cross spawn(), so a
// child that runs a fake engine needs it set again. server/host-power.ts honours the symbol only when NODE_ENV is
// "test" (and not packaged), so pair this with powerBlockTestEnv() from server/testing/power-block-test.ts.
globalThis[Symbol.for("murage.hostPower.testUnwrapped")] = true;
