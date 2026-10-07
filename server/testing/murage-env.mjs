// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keeping a test's children honest about Murage configuration (upstream
// #1857, adapted).
//
// A shell that already exports MURAGE_* (a bot's own terminal inside Murage,
// a server running in another window, a lane's test instance) leaks those
// values into every child a suite spawns and into modules that read
// process.env when they load. The suite then runs against a "configured"
// Murage the test never set up, and in the worst case against the live data
// directory, the same class as the 2026-09-11 ~/.murage deletion. So every
// ambient runtime key is stripped before tests load; each test sets exactly
// the keys it means to set.
//
// Keys that steer the test run itself (MURAGE_BACKUP_TEST_AGE_DIR,
// MURAGE_E2E_*, MURAGE_SMOKE_*, MURAGE_KEEP_SMOKE_DIR and the like) are
// what the person running the tests asked for, and stay.

const PREFIX = "MURAGE_";
// A word in the key that marks it as a test-run control, never a runtime key.
// (Not SKIP or KEEP alone: MURAGE_SKIP_PROVIDER_KEY is an installer runtime key.)
const TEST_CONTROL_WORD = /^(?:TEST|E2E|SMOKE|QUAL|B\d+|EVIDENCE|DIAGNOSTIC|FIXTURE|REAL)$/;

/** True for a key owned by the Murage runtime, which no test inherits. */
export function isAmbientMurageKey(key) {
  if (!key.startsWith(PREFIX)) return false;
  return !key.slice(PREFIX.length).split("_").some(word => TEST_CONTROL_WORD.test(word));
}

/** Copy `env` without any ambient Murage runtime key. */
export function stripMurageEnv(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) if (!isAmbientMurageKey(key)) clean[key] = value;
  return clean;
}

/** Environment for a child a test spawns: this process's environment with
 * the ambient runtime keys stripped, then `overrides` on top. */
export function childEnv(overrides = {}) {
  // The suite's stand-in for the companion door's launch secret (audit C5).
  const door = process.env.MURAGE_TEST_DOOR_TOKEN ? { MURAGE_COMPANION_TOKEN: process.env.MURAGE_TEST_DOOR_TOKEN } : {};
  return { ...stripMurageEnv(process.env), ...door, ...overrides };
}

/** Delete every ambient runtime key from `env` (default process.env) and
 * return what was removed, so data directories among them stay guarded. */
export function scrubAmbientMurageEnv(env = process.env) {
  const removed = {};
  for (const key of Object.keys(env)) {
    if (!isAmbientMurageKey(key)) continue;
    removed[key] = env[key];
    delete env[key];
  }
  return removed;
}
