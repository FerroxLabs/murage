// SPDX-License-Identifier: Apache-2.0
// `node --import ./server/testing/safe-wipe-preload.mjs --test ...`
//
// node --test files and ad-hoc scripts get no vitest setup file, so nothing
// fakes HOME for them. This preload installs the process-wide guard from
// safe-wipe.mjs: every recursive rm/rmSync/rmdir in the process refuses a
// home directory, a Murage data directory, the working directory, a
// filesystem root or a directory holding another process's live installation
// lease. Explicit call sites still use safeWipeSync; this is the backstop for
// the ones nobody routed. package.json wires it into test:electron.
import { installSafeWipeGuard } from "./safe-wipe.mjs";

installSafeWipeGuard();
