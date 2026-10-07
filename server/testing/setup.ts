// Vitest setup — every test file gets a throwaway home directory so
// DATA_DIR (~/.murage) never touches the real one. os.homedir()
// reads HOME (POSIX) / USERPROFILE (Windows) at call time, and this file
// runs before any test module imports server/config.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { removeTempDir } from "./cleanup.ts";
import { scrubAmbientMurageEnv } from "./murage-env.mjs";
import { installSafeWipeGuard } from "./safe-wipe.mjs";

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

const home = mkdtempSync(join(tmpdir(), "murage-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
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
const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

// Windows holds a directory that is a live process's cwd, and a just-killed
// CLI lets go a beat after the kill call returns — see removeTempDir.
afterAll(async () => {
  closeMessageDb();
  await removeTempDir(home);
});
