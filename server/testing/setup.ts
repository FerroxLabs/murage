import "./perf-budget-setup.ts";
import { takeReplayShadowDivergencesForTest } from "../memory/replay-shadow.ts";
// Vitest setup — every test file gets a throwaway home directory so
// DATA_DIR (~/.murage) never touches the real one. os.homedir()
// reads HOME (POSIX) / USERPROFILE (Windows) at call time, and this file
// runs before any test module imports server/config.ts.
import './signal-park-spawn-trace.ts';
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { setTimeout as fixtureTimeout } from "node:timers";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";

// Security interpreter startup and ACL projections are expensive on Windows.
// Cover every Signal test, including nested files; explicit test limits are
// audited separately because Vitest gives them precedence over this default.
if (process.platform === "win32" && /[\\/]channels[\\/]signal[\\/].*[.]test[.]ts$/.test(expect.getState().testPath ?? "")) {
  const multiOperation=/[\\/](?:service|park-authority|park-replacement|park-downgrade)[.]test[.]ts$/.test(expect.getState().testPath ?? "");
  vi.setConfig({ testTimeout: multiOperation ? 300_000 : 150_000, hookTimeout: 150_000 });
}

import { prepareWorkspaceTestDependencies } from "./workspace-dependencies.ts";
import { settleTestHandles } from "../test-handle-registry.ts";
import { removeTempDir } from "./cleanup.ts";
import { scrubAmbientMurageEnv } from "./murage-env.mjs";
import { installSafeWipeGuard } from "./safe-wipe.mjs";
import { installNoFollowRmSync } from "../link-removal.ts";

prepareWorkspaceTestDependencies();

// Ambient Murage runtime keys (a bot's own terminal, a server in another
// window) never reach a test or a child it spawns: each test sets the keys it
// means to set (upstream #1857). A data directory the shell exported stays
// guarded by value below.
const ambient = scrubAmbientMurageEnv();
// Children a test spawns with the node --test preload keep what the test set.
process.env.MURAGE_TEST_ENV_SCRUBBED = "1";
// Belt and braces for the faked home below: every recursive rm/rmSync/rmdir
// in this worker refuses the account's real ~/.murage (found through the
// account database, not $HOME), any home directory, the checkout, and any
// directory another process holds a Murage installation lease on. A test
// that computes the wrong path gets SafeWipeRefused, not a wiped profile.
// Explicit fixture teardown goes through safeWipeSync / removeTempDir.
// On Windows the server replaces fs.rmSync with its no-follow remove (link-removal.ts, installed when config.ts loads), and a
// recursive remove there goes to the addon's removeTree without calling the rmSync it wrapped. Installed first here, as the
// product installs it before its own data-dir guard, so this guard wraps it and still checks every recursive remove first.
installNoFollowRmSync();
installSafeWipeGuard({ protect: [ambient.MURAGE_DATA_DIR, ambient.MURAGE_COMPANION_DIR].filter((dir): dir is string => Boolean(dir)) });

// The harness answers its conversation routes only to a caller that proved who
// it is (route-policy.ts, audit C5), and the proof most callers carry is the
// companion door's: the launch secret in `x-murage-door-token`. The suite's
// many bare fetches to a fixture server stand in for that door (as they always
// stood in for a remote caller), so they carry it: the fixture launchers hand
// the server this secret as its launch secret, and this wrapper stamps it on
// every request to a loopback /api/ route. A test that means "a bare loopback
// request, nobody" sends `x-test-bare-loopback: 1`, which is removed before
// the request leaves and stops the stamp. A header a test sets itself wins.
export const TEST_DOOR_TOKEN = "c".repeat(64);
process.env.MURAGE_TEST_DOOR_TOKEN = TEST_DOOR_TOKEN;
// Children a test spawns inherit it as their launch secret (childEnv adds it
// too, because it strips every ambient MURAGE_ key).
process.env.MURAGE_COMPANION_TOKEN = TEST_DOOR_TOKEN;
// Tests that spawn the harness with their own explicit environment never pass a
// launch secret, so a child started from server/index.ts gets the suite's.
const childProcess = (await import("node:child_process")).default as typeof import("node:child_process");
const realSpawn = childProcess.spawn;
(childProcess as { spawn: unknown }).spawn = function (this: unknown, command: string, ...rest: unknown[]) {
  const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
  const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as { env?: NodeJS.ProcessEnv } | undefined;
  if (options?.env && !options.env.MURAGE_COMPANION_TOKEN && args.some((arg) => /server[\\/]index\.ts$/.test(String(arg)))) {
    options.env = { ...options.env, MURAGE_COMPANION_TOKEN: TEST_DOOR_TOKEN };
  }
  return (realSpawn as (...all: unknown[]) => unknown).call(this, command, ...rest);
};
(await import("node:module")).syncBuiltinESMExports();
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  let host = "";
  try { host = new URL(input instanceof Request ? input.url : String(input)).hostname.replace(/^\[|\]$/g, ""); } catch { /* not a URL: leave it */ }
  let pathname = "";
  try { pathname = new URL(input instanceof Request ? input.url : String(input)).pathname; } catch { /* leave it */ }
  if ((host !== "127.0.0.1" && host !== "localhost" && host !== "::1") || !pathname.startsWith("/api/")) return realFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (headers.has("x-test-bare-loopback")) headers.delete("x-test-bare-loopback");
  else if (!headers.has("x-murage-door-token")) headers.set("x-murage-door-token", TEST_DOOR_TOKEN);
  return realFetch(input, { ...init, headers });
}) as typeof fetch;

// The engines' files are changed only under real exclusion (server/engine-exec.ts), which needs the native addon. Tests run in a
// world where no engine holds a lock or has a file open (a stand-in the worker threads load too); the tests of the real addon
// point MURAGE_ENGINE_EXCLUSION_PATH at the build (server/engine-exclusion.test.ts).
process.env.MURAGE_ENGINE_EXCLUSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "engine-exclusion-stub.cjs");

// S4 power (server/host-power.ts): the suite's fake engines run as they did before the Mac and Linux power block, because a test
// box has no shipped bwrap and cannot always build a user namespace. This is a value in this worker's memory (not an environment
// variable), honoured only in a test process; server/host-power.test.ts clears it and runs the real planning and wrap.
(globalThis as Record<symbol, unknown>)[Symbol.for("murage.hostPower.testUnwrapped")] = true;

// The crash journal of an engine-history rewrite (server/engine-redo.ts) lives in a throwaway folder of its own in tests.
process.env.MURAGE_ENGINE_REDO_DIR = join(mkdtempSync(join(tmpdir(), "murage-test-redo-")), "engine-redo");

const originalTmpEnv = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
// The real OS temp folder, before TMPDIR moves into this worker's root: tests that need short socket
// paths still make their folders directly under /tmp, and the cleanup helper must keep admitting them.
(globalThis as Record<symbol, unknown>)[Symbol.for("murage.test.osTmpdir")] = tmpdir();
const workerRoot = mkdtempSync(join(tmpdir(), "murage-worker-"));
const home = join(workerRoot, "home");
mkdirSync(home);
process.env.HOME = home;
process.env.USERPROFILE = home;
// Import containment and delayed effects share this worker's disposable roots.
const workerTmp = workerRoot;
process.env.MURAGE_FIXTURE_IMPORT_ROOT = workerRoot;
process.env.TMPDIR = workerTmp;
process.env.TEMP = workerTmp;
process.env.TMP = workerTmp;
process.env.DATA_DIR = join(home, ".murage");
// Use the isolated OS state roots; no runtime Murage override leaks to tests.
process.env.LOCALAPPDATA = join(home, "AppData", "Local");
for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) process.env[name] = join(home, name.toLowerCase());
// A real, isolated data root lets absence proofs use the owner-read resolution.
mkdirSync(join(home, ".murage"));
// Owners: c3-memory admission-window fixture; salv-tri-b real VFS for server fixtures.
// MAIN INT-CONFLICT-DEFAULT: preserve the real native meter and memory phase gate.
const fixtureTestPath = expect.getState().testPath ?? "";
const memoryFixture = /[\\/]server[\\/]memory[\\/]/.test(fixtureTestPath);
const launchesServerFixture = fixtureTestPath !== "" &&
  /launchVerificationServer|(?:index-harness|control-murage|murage-env)[.]/.test(readFileSync(fixtureTestPath, "utf8"));
if (memoryFixture || launchesServerFixture) {
  const { prepareMemoryMeterFixture } = await import("../memory/testing/native-meter-fixture.ts");
  prepareMemoryMeterFixture(home);
  if (memoryFixture) beforeEach(async () => {
    // Immediate-work fixtures must begin outside the real admission window's
    // closing guard. Keep the real clock, byte caps and native enforcement;
    // tests that deliberately drive a fake clock retain their chosen phase.
    if (vi.isFakeTimers()) return;
    const remaining = 60_000 - Date.now() % 60_000;
    if (remaining <= 10_000) await new Promise<void>(resolve => fixtureTimeout(resolve, remaining + 1));
  });
}
// MURAGE_DATA_DIR is an intentional production override, but tests must never
// let it escape the throwaway home they are about to delete.
delete process.env.MURAGE_DATA_DIR;
// A developer who exported a pinned dev secret must not have it leak into
// the suite: a test that accidentally holds the real value proves nothing
// about a request that does not.
delete process.env.MURAGE_DEV_DESKTOP_SECRET;
// A disposable test launcher explicitly opts in; production Node processes
// must never offer the desktop credential simply because Electron is absent.
process.env.MURAGE_ALLOW_DEV_DESKTOP_SECRET = "1";
// Do not let a developer's Hermes global config path leak into per-test homes.
delete process.env.HERMES_HOME;
// A developer with FLUX_API_KEY exported would otherwise get the Flux Router
// picker rows in every gated engine's catalog — the gate is doing its job, but
// it makes the model-catalog assertions depend on that developer's shell.
// server/flux-surface.test.ts sets it deliberately, per test.
delete process.env.FLUX_API_KEY;
// The renderer catalog follows navigator.language (src/lib/i18n.ts), which Node
// derives from the host's LANG/LC_ALL, so a German shell turned English UI
// assertions red. Tests pin English; locale tests call setLocale explicitly.
if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "language", { value: "en-US", configurable: true });
// The companion keeps its paired devices in its own directory, and resolves
// it from homedir() the same way — so the redirect above already covers it.
// Named explicitly all the same: the device tests delete this directory
// wholesale, and "it is safe because of a line in another file" is not the
// footing that delete should stand on.
process.env.MURAGE_COMPANION_DIR = join(home, ".murage-companion");

// The Electron companion suites boot a stand-in control server on the port
// companion.mjs dials, and that port defaults to 8811 — which the developer's
// own running Murage owns, on this machine, always. Both suites then died in
// `beforeAll` with EADDRINUSE and reported every test as skipped, which is how
// a genuinely red assertion in companion-tailscale.test.mjs hid for two
// sessions. MURAGE_CONTROL_PORT_OVERRIDE existed to solve this and nothing
// ever set it; an override only a human remembers to export is not a fix.
// Both sides read this variable at module load, and setupFiles run before any
// test module imports, so this is the last point where setting it still works.
// Left alone when already set, so a developer can still pin one deliberately.
if (!process.env.MURAGE_CONTROL_PORT_OVERRIDE) {
  const { freePortBlock } = await import("./ports.ts");
  process.env.MURAGE_CONTROL_PORT_OVERRIDE = String(await freePortBlock([0]));
}

// SQLite keeps the database file open for the lifetime of its handle.
// Windows will not remove a directory containing an open database, so close
// the per-test handle before the next test resets its throwaway data dir.
// The log checkpointer (wal-maintenance.ts) closes its own connection a moment after the server's, and that last close
// copies and removes the log: wait for it, so the next test's reset of the data dir never meets a file still being deleted.
// A deferred write (bots.json after a turn's cursor or usage) lands in the test that made it, while its data dir and database still exist, so it can
// never fire into the next test's wiped directory: the same flush the server does on exit.
// settleTestHandles reaches EVERY copy of those modules, including the ones a test's vi.resetModules() made: importing
// closeMessageDb here would only close the first copy and leave the test's own connection (and its checkpointer) open.
await import("../message-db.ts");
await import("../wal-maintenance.ts");
await import("../atomic.ts");
afterEach(async () => {
  await settleTestHandles();
  if (memoryFixture) {
    // Every old handle and checkpointer has left. The next isolated app must
    // not inherit reservations or copy debt for a database just discarded by
    // this fixture. Restarts within one test retain their real ledger.
    const { ioBudget } = await import("../io-budget.ts");
    ioBudget.resetAdmissionForFixture();
  }
});

// Windows holds a directory that is a live process's cwd, and a just-killed
// CLI lets go a beat after the kill call returns — see removeTempDir.
afterAll(async () => {
  await settleTestHandles();
  await removeTempDir(home);
  for (const [name, value] of Object.entries(originalTmpEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await removeTempDir(workerRoot);
});

// A production caller may fail closed by catching an error. Such a catch must
// never hide disagreement between the incremental and full replay algorithms.
afterEach(() => {
  expect(takeReplayShadowDivergencesForTest(), "REPLAY_SHADOW_DIVERGED invariant").toBe(0);
});
