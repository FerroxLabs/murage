// `pnpm dev:server` — the harness server, started the way development needs it.
//
// This exists for one reason: MURAGE_STATIC_DIR. In a packaged build Electron
// sets it to Resources/ui and the harness serves the app itself; in
// development nothing set it, `STATIC_DIR` was null (`server/index.ts:279`),
// and the harness served no static files at all.
//
// That was invisible for the desktop app, which loads the Vite dev server
// directly. It is not invisible for the browser door. A phone that reaches
// 8813 is proxied to the harness, and the harness is the only thing that can
// hand it the shell — so with no static tree the door opens onto nothing.
//
// `devHarnessEnvironment` is the single declaration of that answer, and it
// lives in electron/harness-resources.mjs because main.mjs is not the only
// caller. This script is the second caller. Nothing here re-derives the
// decision; it imports it, merges it into the child's environment, and execs
// the same `node --experimental-strip-types server/index.ts` the script used
// to run directly.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { devHarnessEnvironment } from "../electron/harness-resources.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The repository root, from this file's own location rather than cwd — the
 *  script must find `dist/` whichever directory it is invoked from. */
export const REPO_ROOT = path.resolve(HERE, "..");

/** The server entry, relative to the repo root. */
export const SERVER_ENTRY = path.join("server", "index.ts");

/**
 * The environment the dev harness child receives.
 *
 * An explicit `MURAGE_STATIC_DIR` already in the environment always wins: a
 * person pointing the harness at a tree by hand is making a deliberate
 * choice, and silently replacing it with `dist/` would be the same class of
 * bug as never setting it at all — a path that is not the one anybody asked
 * for, with nothing on screen saying so.
 *
 * Otherwise `devHarnessEnvironment` decides, and it declines to answer when
 * `dist/index.html` is missing. An unbuilt checkout therefore gets no
 * variable rather than a path to a directory that is not there, which is
 * exactly the state the harness already handles as "no static tree".
 */
export function devServerEnvironment(
  repoRoot = REPO_ROOT,
  baseEnvironment = process.env,
  exists = undefined,
) {
  const derived = exists
    ? devHarnessEnvironment(repoRoot, exists)
    : devHarnessEnvironment(repoRoot);
  // Base last for MURAGE_STATIC_DIR specifically, so an explicit override is
  // never clobbered; base first for everything else it carries.
  return baseEnvironment.MURAGE_STATIC_DIR
    ? { ...baseEnvironment, ...derived, MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_STATIC_DIR: baseEnvironment.MURAGE_STATIC_DIR }
    : { ...baseEnvironment, ...derived, MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" };
}

/** Start the harness with that environment and mirror its exit. */
export function startDevServer(argv = []) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", path.join(REPO_ROOT, SERVER_ENTRY), ...argv],
    { cwd: REPO_ROOT, env: devServerEnvironment(), stdio: "inherit" },
  );
  // Ctrl-C in the terminal reaches the whole process group already; this is
  // for a parent that signals this process alone.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0);
  });
  return child;
}

// Importable by the tests without starting anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDevServer(process.argv.slice(2));
}
