// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where a test goes when only the hosted Windows runner cannot hold it in the per-push shards. The rule is nightly.yml's:
// `nightly` is a test over 60 s on a hosted runner, `perf-budget` one that asserts a wall-clock budget. Windows hosted runners
// commit a synchronous SQLite transaction 15-70x slower than Linux (1.0.3 CI 39342836766: revoke-budget 20 s on Ubuntu,
// 659 s on Windows), so a scale test that counts rows can pass its counts there and still run for minutes. Elsewhere these
// give nothing: the test stays in the per-push shards on Linux and macOS.

const windows = process.platform === "win32";

/** Over 60 s on the hosted Windows runner: nightly.yml runs it there (with room for it), per-push CI runs it everywhere else. */
export const windowsNightly = (timeout = 600_000): { tags?: string[]; timeout?: number } => (windows ? { tags: ["nightly"], timeout } : {});

/** A wall-clock budget the hosted Windows runner cannot meet: measured on the perf hardware, and per-push on Linux and macOS. */
export const windowsPerfBudget = (): { tags?: string[] } => (windows ? { tags: ["perf-budget"] } : {});
