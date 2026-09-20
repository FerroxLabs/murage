// The first-run rig: one data dir, one engine, and a choice about whether
// that engine can answer.
//
// The checklist's whole promise is that it works on a machine where the
// brain does NOT work, so these specs need a real harness whose engine is
// real, selectable and present — and never produces a settled reply. That is
// what MURAGE_SETUP_FIXTURE_MODE buys: it is handed straight to the shipped
// ACP fixture CLI as FAKE_ACP_MODE, so the refusal comes out of the real
// driver, through the real store, into the real GET /api/setup derivation.
// Nothing here stubs a route; it decides what the engine does.
//
// Declarations only. The wipe-and-write lives in setup-prepare.mjs, which is
// run as the first half of the harness webServer command — a spec imports
// this file for the instance name, and importing a module must never delete
// a directory.
import { join, resolve } from "node:path";

const repoRoot = resolve(join(import.meta.dirname, "..", ".."));

/** The ACP fixture CLI, driven by FAKE_ACP_MODE. It answers the availability
 *  probes, so the app draws the product rather than <NoEngines />, and then
 *  does whatever the mode says when a turn is dispatched. */
export const FIXTURE_CLI = join(repoRoot, "server", "testing", "fake-acp-cli.ts");

/** The engine the Chief starts on. `fuigoAgent` is the engine Murage ships,
 *  which is the one the brain card names on a fresh install. */
export const FIXTURE_INSTANCE = "setup-fixture";

/** The config.json a first-run harness boots from. */
export function setupFixtureConfig() {
  return {
    instances: {
      [FIXTURE_INSTANCE]: {
        driver: "fuigoAgent",
        displayName: "Fuigo (fixture)",
        config: { cli: FIXTURE_CLI, fullAuto: false },
      },
    },
  };
}
