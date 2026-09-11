// Runs as the first half of the harness webServer command, before
// `pnpm dev:server` binds its port — so the server boots against a known-empty
// data dir every time.
//
// It only ever runs when Playwright is actually starting the harness. If
// `reuseExistingServer` reused a harness from an earlier run, this file is
// never reached and the surviving dir is left alone; global-setup.ts resets
// the workspace over HTTP in that case instead of yanking files out from
// under a live process.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const dataDir = process.env.MURAGE_DATA_DIR;
if (!dataDir) {
  throw new Error("MURAGE_DATA_DIR is required — refusing to prepare the default ~/.murage");
}
const resolved = resolve(dataDir);
if (resolved === resolve(join(homedir(), ".murage"))) {
  throw new Error(`refusing to wipe the real data dir: ${resolved}`);
}

safeWipeSync(resolved);
mkdirSync(resolved, { recursive: true });

// One engine, and it is a fixture. Without an available instance the app
// renders <NoEngines /> in place of the chat column (App.tsx:265) and every
// human spec would be reading a setup screen instead of the product. The CLI
// is the suite's own fake, so nothing here can reach a real provider or the
// network.
const fakeClaudeCli = join(resolve(join(import.meta.dirname, "..", "..")), "server", "testing", "fake-claude-cli.ts");
writeFileSync(
  join(resolved, "config.json"),
  `${JSON.stringify(
    {
      instances: {
        verification: {
          driver: "claudeAgent",
          displayName: "Fixture Claude",
          config: { cli: fakeClaudeCli },
        },
      },
    },
    null,
    2,
  )}\n`,
);
