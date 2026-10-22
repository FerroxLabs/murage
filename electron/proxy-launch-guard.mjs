// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The server starts its proxies and workers with the Murage binary itself and ELECTRON_RUN_AS_NODE=1 (REAL-ENGINE-GATE
// G5). If that variable is lost on the way (1.0.3: Claude's shell prefix dropped an MCP server's env), the binary would
// start as the app: a second instance against the owner's real data. The main process refuses that before anything
// else, and before the single-instance lock: the script argument (the first argument after the binary that is not an
// option, as node reads it: the memory worker is forked with `--experimental-strip-types` before it) naming one of the
// server's spawned files (shared/spawned-proxies.mjs, the list server/proxy-paths.ts resolves) means this process was
// meant to be one of them. A URL (murage://install?url=...#/permission-proxy.js) is never a script.
import { SPAWNED_PROXY_FILES } from "../shared/spawned-proxies.mjs";

export const PROXY_LAUNCH_EXIT_CODE = 86;
const EXTENSIONS = [".js", ".ts", ".mjs", ".cjs"];
// The node options the server's launches (and node itself) spell with their value as the NEXT argument; any other
// option is one argument (`--flag` or `--flag=value`).
const OPTIONS_WITH_VALUE = new Set([
  "--import", "--require", "-r", "--loader", "--experimental-loader", "--eval", "-e", "--print", "-p", "--input-type", "--env-file", "--env-file-if-exists",
  "--conditions", "-C", "--inspect-port", "--debug-port", "--title",
  // V8 and runtime sizing
  "--max-old-space-size", "--max-semi-space-size", "--stack-size", "--stack-trace-limit", "--v8-pool-size", "--secure-heap", "--secure-heap-min", "--max-http-header-size",
  // diagnostics and profiling
  "--diagnostic-dir", "--report-dir", "--report-directory", "--report-filename", "--report-signal", "--heapsnapshot-signal", "--heap-prof-dir", "--heap-prof-name", "--heap-prof-interval",
  "--cpu-prof-dir", "--cpu-prof-name", "--cpu-prof-interval", "--trace-event-categories", "--trace-event-file-pattern", "--redirect-warnings", "--disable-warning", "--inspect-publish-uid",
  // modules, loaders, networking, security
  "--experimental-default-type", "--unhandled-rejections", "--dns-result-order", "--icu-data-dir", "--openssl-config", "--tls-cipher-list", "--tls-keylog", "--security-revert",
  "--network-family-autoselection-attempt-timeout", "--watch-path", "--localstorage-file", "--experimental-sea-config", "--snapshot-blob", "--build-snapshot-config",
  // test runner
  "--test-name-pattern", "--test-skip-pattern", "--test-reporter", "--test-reporter-destination", "--test-concurrency", "--test-timeout", "--test-shard",
]);
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The argument node would run as the script (null when there is none, or it is a URL). */
function scriptArgument(argv) {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== "string" || !arg) return null;
    if (arg === "--") return typeof argv[index + 1] === "string" && !URL_LIKE.test(argv[index + 1]) ? argv[index + 1] || null : null;
    if (arg.startsWith("-")) {
      if (OPTIONS_WITH_VALUE.has(arg)) index += 1;
      continue;
    }
    return URL_LIKE.test(arg) ? null : arg;
  }
  return null;
}

/** The one-line reason this launch must not start the app, or null. */
export function proxyLaunchRefusal(argv = process.argv, env = process.env) {
  if (env.ELECTRON_RUN_AS_NODE) return null;
  const script = scriptArgument(argv);
  if (!script) return null;
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

// An engine's pre-execution hook (Codex: <scope>/murage-hook.mjs; Antigravity: native/antigravity-ask/ask-hook-<hash>.cjs) is run
// as `<Murage binary> <script>`. Started without ELECTRON_RUN_AS_NODE it must never become the app: it exits 2, which the engine
// reads as a blocked call, with the hook's own stderr line (1.0.3 packaged Windows gate: Codex turns refused, stray app launches).
export const HOOK_LAUNCH_EXIT_CODE = 2;
const HOOK_SCRIPT = /(?:^|\/)(?:murage-hook\.mjs|antigravity-ask\/ask-hook-[0-9a-f]{16}\.cjs)$/;

/** The hook's block line when this launch is an engine hook script without ELECTRON_RUN_AS_NODE, or null. */
export function hookLaunchRefusal(argv = process.argv, env = process.env) {
  if (env.ELECTRON_RUN_AS_NODE) return null;
  const script = scriptArgument(argv);
  if (!script || !HOOK_SCRIPT.test(script.replace(/\\/g, "/").toLowerCase())) return null;
  return "Murage blocked this call: hook started without node mode";
}

/** Exit with the reason on stderr when this launch is a spawned server file (86) or an engine hook script (2) that lost
 *  ELECTRON_RUN_AS_NODE. */
export function enforceProxyLaunchGuard(argv = process.argv, env = process.env, exit = (code) => process.exit(code), write = (line) => process.stderr.write(line)) {
  const hook = hookLaunchRefusal(argv, env);
  if (hook) {
    write(`${hook}\n`);
    exit(HOOK_LAUNCH_EXIT_CODE);
    return true;
  }
  const reason = proxyLaunchRefusal(argv, env);
  if (!reason) return false;
  write(`${reason}\n`);
  exit(PROXY_LAUNCH_EXIT_CODE);
  return true;
}
