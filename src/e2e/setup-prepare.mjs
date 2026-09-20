// Wipes and re-seeds the first-run data dir before the harness binds, the
// way prepare-scratch.mjs does for the shared rig. Runs only when Playwright
// is actually starting the server, never on import.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { setupFixtureConfig } from "./setup-fixture.mjs";

const dataDir = process.env.MURAGE_DATA_DIR;
if (!dataDir) throw new Error("MURAGE_DATA_DIR is required — refusing to prepare the default ~/.murage");
const resolved = resolve(dataDir);
if (resolved === resolve(join(homedir(), ".murage"))) {
  throw new Error(`refusing to wipe the real data dir: ${resolved}`);
}

safeWipeSync(resolved);
mkdirSync(resolved, { recursive: true });
writeFileSync(join(resolved, "config.json"), `${JSON.stringify(setupFixtureConfig(), null, 2)}\n`);
