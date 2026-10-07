// SPDX-License-Identifier: AGPL-3.0-or-later
// `node --import ./server/testing/safe-wipe-preload.mjs --test ...`
//
// node --test files and ad-hoc scripts get no vitest setup file, so nothing
// fakes HOME for them. This preload installs the process-wide guard from
// safe-wipe.mjs: every recursive rm/rmSync/rmdir in the process refuses a
// home directory, a Murage data directory, the working directory, a
// filesystem root or a directory holding another process's live installation
// lease. Explicit call sites still use safeWipeSync; this is the backstop for
// the ones nobody routed. package.json wires it into test:electron.
//
// It first strips the ambient Murage runtime keys a shell exported
// (murage-env.mjs, upstream #1857), before any test module can read them; a
// data directory among them stays guarded by value.
import { installSafeWipeGuard } from "./safe-wipe.mjs";
import { isMainThread } from "node:worker_threads";
import { scrubAmbientMurageEnv } from "./murage-env.mjs";

// Once, in the process that starts the run. A child a test spawns inherits
// this preload through execArgv, and its MURAGE_* keys are the ones the test
// set for it on purpose: the marker (a test-control key, never scrubbed)
// says the scrub already happened upstream.
// A Worker thread inherits execArgv too, with the env its test built for it.
const removed = !isMainThread || process.env.MURAGE_TEST_ENV_SCRUBBED === "1" ? {} : scrubAmbientMurageEnv();
if (isMainThread) process.env.MURAGE_TEST_ENV_SCRUBBED = "1";
installSafeWipeGuard({ protect: [removed.MURAGE_DATA_DIR, removed.MURAGE_COMPANION_DIR].filter(Boolean) });
