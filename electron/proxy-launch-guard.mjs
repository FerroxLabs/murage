// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The server starts its proxies and workers with the Murage binary itself and ELECTRON_RUN_AS_NODE=1 (REAL-ENGINE-GATE
// G5). If that variable is lost on the way (1.0.3: Claude's shell prefix dropped an MCP server's env), the binary would
// start as the app: a second instance against the owner's real data. The main process refuses that before anything
// else, and before the single-instance lock: argv[1] naming one of the server's spawned files (shared/spawned-proxies.mjs,
// the list server/proxy-paths.ts resolves) means this process was meant to be one of them.
import { SPAWNED_PROXY_FILES } from "../shared/spawned-proxies.mjs";

export const PROXY_LAUNCH_EXIT_CODE = 86;
const EXTENSIONS = [".js", ".ts", ".mjs", ".cjs"];

/** The one-line reason this launch must not start the app, or null. */
export function proxyLaunchRefusal(argv = process.argv, env = process.env) {
  if (env.ELECTRON_RUN_AS_NODE) return null;
  const script = argv[1];
  if (typeof script !== "string" || !script) return null;
  const spelled = script.replace(/\\/g, "/").toLowerCase();
  for (const relative of Object.values(SPAWNED_PROXY_FILES)) {
    for (const extension of EXTENSIONS) {
      const tail = `${relative}${extension}`.toLowerCase();
      if (spelled === tail || spelled.endsWith(`/${tail}`)) {
        return `[desktop] ${script} was started without ELECTRON_RUN_AS_NODE; exiting so it does not open Murage a second time`;
      }
    }
  }
  return null;
}

/** Exit (86) with the reason on stderr when this launch is a spawned server file that lost ELECTRON_RUN_AS_NODE. */
export function enforceProxyLaunchGuard(argv = process.argv, env = process.env, exit = (code) => process.exit(code), write = (line) => process.stderr.write(line)) {
  const reason = proxyLaunchRefusal(argv, env);
  if (!reason) return false;
  write(`${reason}\n`);
  exit(PROXY_LAUNCH_EXIT_CODE);
  return true;
}
