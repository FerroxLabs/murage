// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One shared helper for tests that start the Murage server as a child process with a fake engine. On Linux (no shipped
// bwrap on a test box) the host power block refuses such a child unless it carries the test-only unwrap, which
// server/host-power.ts honours only when NODE_ENV is "test" and the process is not packaged. Production code is not
// touched: this file only sets what the existing test seam reads.
//
//   spawn(process.execPath, [...fakeEngineImportArgs(), join(SERVER_DIR, "index.ts")], { env: { ...base, ...powerBlockTestEnv() } })
//   launchVerificationServer(process.env, undefined, { instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}...` })
import { fileURLToPath, pathToFileURL } from "node:url";

/** The preload file: sets globalThis[Symbol.for("murage.hostPower.testUnwrapped")] = true in the child. */
export const FAKE_ENGINE_PRELOAD_PATH = fileURLToPath(new URL("./fake-engine-unwrapped-preload.mjs", import.meta.url));

/** node arguments that load the preload ahead of the entry file: ["--import", <file URL>]. */
export function fakeEngineImportArgs(): string[] {
  return ["--import", pathToFileURL(FAKE_ENGINE_PRELOAD_PATH).href];
}

/** The child env the unwrap needs: NODE_ENV=test (host-power ignores the symbol in any other mode). */
export function powerBlockTestEnv(): { NODE_ENV: "test" } {
  return { NODE_ENV: "test" };
}

/** Source line for launchVerificationServer instrumentationSource (run inside the server child): prefix the source with it. */
export const POWER_BLOCK_UNWRAP_SOURCE = "globalThis[Symbol.for(\x27murage.hostPower.testUnwrapped\x27)]=true;\n";
