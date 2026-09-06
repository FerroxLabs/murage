// Vitest setup — every test file gets a throwaway home directory so
// DATA_DIR (~/.murage) never touches the real one. os.homedir()
// reads HOME (POSIX) / USERPROFILE (Windows) at call time, and this file
// runs before any test module imports server/config.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { removeTempDir } from "./cleanup.ts";

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
