// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra's W1 High: a path walk checks an entry, then acts on its path, so a
// folder swapped for a junction in between sends the remove into the
// junction's target. On Windows link-removal.ts removes trees through the
// engine-exclusion addon's removeTree, by handle. This runs the REAL addon
// (dist-native/engine-exclusion/win32-<arch>, built by the vitest job as
// package:win does) inside the app's Electron runtime and under plain Node,
// with a folder swapped mid-walk on purpose and by a racing thread.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL(".", import.meta.url));
const addon = process.env.MURAGE_LINK_REMOVAL_ADDON || join(here, "..", "dist-native", "engine-exclusion", `${process.platform}-${process.arch}`, "engine-exclusion.node");
const runs = process.platform === "win32" && existsSync(addon);
const work = runs ? mkdtempSync(join(tmpdir(), "murage-link-removal-native-")) : "";
const bundle = runs ? join(work, "link-removal.cjs") : "";
if (runs) buildSync({ entryPoints: [join(here, "link-removal.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });

let electron = "";
try { electron = require("electron") as unknown as string; } catch { /* no Electron package */ }
const haveElectron = runs && typeof electron === "string" && electron !== "" && existsSync(electron)
  && spawnSync(electron, ["-e", "0"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000, windowsHide: true }).status === 0;

afterAll(async () => { if (work) await removeTempDir(work); });

function run(command: string, env: NodeJS.ProcessEnv, label: string) {
  const base = mkdtempSync(join(work, `${label}-`));
  const fixture = join(here, "testing", "link-removal-native.fixture.cjs");
  const result = spawnSync(command, [fixture, bundle, addon, base], { env, encoding: "utf8", timeout: 180_000, windowsHide: true });
  expect(result.status, `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? "{}");
  console.log(`${report.runtime}: ${JSON.stringify(report.cases)}`);
  return report;
}

function expectNeverFollows(report: { installed: boolean; cases: Record<string, any> }) {
  const { cases } = report;
  expect(cases.junctionInTree).toEqual({ returned: true, removed: true, victimIntact: true });
  expect(cases.topJunction).toEqual({ returned: true, linkRemoved: true, victimIntact: true });
  expect(cases.readOnly).toEqual({ returned: true, removed: true });
  expect(cases.missing).toBe(false);
  expect(cases.nulInPath).toEqual({ error: "ERR_INVALID_ARG_VALUE", kept: true });
  // a path Windows would rewrite to another (trailing dot or space, `..` tail, its \\?\ form) is refused, never shortened
  expect(cases.rewrittenPath).toEqual(["EINVAL", "EINVAL", "EINVAL", "EINVAL", "EINVAL", "EINVAL"]);
  expect(cases.rewrittenPathKept).toBe(true);
  // swapped after removeTree opened d and before it listed d: it removes the folder it holds, never the junction's target
  expect(cases.swapByHandle).toMatchObject({ returned: true, removed: true, movedRemoved: true, victimIntact: true });
  expect(cases.swapByHandle.seen).toEqual(["", "d", "d\\inner"]);
  expect(cases.swapTop).toEqual({ returned: true, movedRemoved: true, victimIntact: true });
  // the path walk, given the same swap after its last check, does follow it: the race this replaces was real
  expect(cases.swapByPath).toMatchObject({ swapped: true, victimIntact: false });
  // a racing thread: every swap it made was met by handle, nothing reached the victim. A remove that gives up while the folder
  // is renamed under it is allowed (it refuses rather than follows; how often depends on the race); once the race ends, every
  // tree goes.
  expect(cases.race.victimIntact).toBe(true);
  expect(cases.race.failures).toBe(0);
  expect(cases.race.swaps).toBeGreaterThan(0);
  expect(report.installed).toBe(true);
  expect(cases.rmSync).toEqual({ removed: true, victimIntact: true, missing: "ENOENT", dotted: "EINVAL", dottedKept: true });
}

describe.runIf(runs)("removeTree removes by handle and never follows a junction, even one swapped in mid-walk", () => {
  it("under plain Node", () => {
    expectNeverFollows(run(process.execPath, { ...process.env }, "node"));
  });
  it.runIf(haveElectron)("under the app's Electron runtime (ELECTRON_RUN_AS_NODE)", () => {
    expectNeverFollows(run(electron, { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, "electron"));
  });
});
