// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// murage#16: Windows CI ran the relink tests on plain Node and passed, while
// the app's own runtime (Electron's Node) failed on the same junction. This
// runs link-removal.ts inside the Electron binary the app ships, with
// ELECTRON_RUN_AS_NODE=1 exactly as the packaged server runs, and under plain
// Node beside it. ci.yml runs this file as its own step on windows-latest.
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
const fixture = join(here, "testing", "link-removal.fixture.cjs");
const work = mkdtempSync(join(tmpdir(), "murage-link-removal-"));
const bundle = join(work, "link-removal.cjs");
buildSync({ entryPoints: [join(here, "link-removal.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });

let electron = "";
try { electron = require("electron") as unknown as string; } catch { /* no Electron package */ }
// Installed and able to start here (a bare container lacks Electron's shared libraries).
const haveElectron = typeof electron === "string" && electron !== "" && existsSync(electron)
  && spawnSync(electron, ["-e", "0"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000, windowsHide: true }).status === 0;
// A Windows CI runner must never skip this silently: the step sets it.
const requireElectron = process.env.MURAGE_REQUIRE_ELECTRON_LINK_TEST === "1";

afterAll(async () => { await removeTempDir(work); });

interface Outcome { linkRemoved: boolean; targetIntact: boolean; error?: string | null }
interface Report {
  runtime: string;
  platform: string;
  raw: Record<string, Outcome> & { lstat: { isSymbolicLink: boolean; isDirectory: boolean } };
  helper: {
    removeLink: Outcome & { removed: boolean; again: boolean };
    refusesRealFolder: { error: string | null; kept: boolean };
    relinkDirectory: { pointsAtNext: boolean; oldTargetIntact: boolean };
    installed: boolean;
    rmSync: { plain: Outcome; recursive: Outcome; tree: { treeRemoved: boolean; targetIntact: boolean }; missing: string | null };
  };
}

function run(command: string, env: NodeJS.ProcessEnv, label: string): Report {
  const base = mkdtempSync(join(work, `${label}-`));
  const result = spawnSync(command, [fixture, bundle, base], { env, encoding: "utf8", timeout: 60_000, windowsHide: true });
  const diagnostics = `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  expect(result.status, diagnostics).toBe(0);
  const line = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  const report = JSON.parse(line) as Report;
  // The recorded behaviour of the runtime's own calls, for the CI log.
  console.log(`${report.runtime} on ${report.platform}: ${JSON.stringify(report.raw)}`);
  return report;
}

function expectHelperNeverFollows(report: Report): void {
  const { helper } = report;
  // The link is a link to lstat in both runtimes; the helper relies on it.
  expect(report.raw.lstat.isSymbolicLink).toBe(true);
  expect(helper.removeLink).toMatchObject({ removed: true, linkRemoved: true, targetIntact: true, again: false });
  expect(helper.refusesRealFolder).toEqual({ error: "ENOTLINK", kept: true });
  expect(helper.relinkDirectory).toEqual({ pointsAtNext: true, oldTargetIntact: true });
  // Patched only where the runtime needs it.
  expect(helper.installed).toBe(report.platform === "win32");
  expect(helper.rmSync).toEqual({
    plain: { linkRemoved: true, targetIntact: true },
    recursive: { linkRemoved: true, targetIntact: true },
    tree: { treeRemoved: true, targetIntact: true },
    missing: null,
  });
}

describe("link removal never follows a directory link", () => {
  it("under plain Node", () => {
    expectHelperNeverFollows(run(process.execPath, { ...process.env }, "node"));
  });

  it.runIf(haveElectron || requireElectron)("under the app's Electron runtime (ELECTRON_RUN_AS_NODE)", () => {
    expect(haveElectron, "the Electron binary is not installed or cannot start; run node -e \"require('electron')\" first").toBe(true);
    expectHelperNeverFollows(run(electron, { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, "electron"));
  });
});
