// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Node halves of two Windows release gates, run against a packaged tree (release/win-unpacked by default):
//   backup     the raw upstream backup tools match their pins, and our backup helper carries a valid Ferrox signature
//              (checked through the packaged engine-exclusion addon, as the installed app does)
//   admission  the signed browser runtime passes the same admission check the packaged app runs before starting it
// release.yml and package-win.yml both run this file, so a path or import mistake in a gate shows up on a package build
// instead of first appearing on the release runner (1.0.3: the native helper and resources paths).
//
//   node scripts/windows-release-gates.mjs backup|admission [resources dir]
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_RESOURCES = "release/win-unpacked/resources";

/** Backup tools gate. `deps` are the real checks unless a test passes its own. */
export async function verifyPackagedBackupTools({ resources = DEFAULT_RESOURCES, systemRoot = process.env.SystemRoot, deps } = {}) {
  const { verifyWindowsBackupTools, verifyWindowsBrowserSignatures, nativeAuthenticodeIn, log = console.log } = deps ?? await backupDeps();
  // require() reads a bare relative path as a package name, so the addon folder is always absolute.
  const resourcesDir = resolve(resources);
  const helper = join(resourcesDir, "engine-exclusion.node");
  log(`native helper: ${helper} ${existsSync(helper)}`);
  const backup = `${resources.replace(/\\/g, "/").replace(/\/+$/, "")}/backup-tools/x64`;
  verifyWindowsBackupTools(backup);
  await verifyWindowsBrowserSignatures([`${backup}/murage-backup-age.exe`], systemRoot, nativeAuthenticodeIn(resourcesDir));
}

/** Signed browser runtime admission gate. */
export async function verifyPackagedBrowserAdmission({ resources = DEFAULT_RESOURCES, env = process.env, deps } = {}) {
  const { browserBundlePaths, ensureBrowserSandboxAccess, log = console.log } = deps ?? await admissionDeps();
  const resourcesDir = resolve(resources);
  const root = join(resourcesDir, "browser-engine");
  // The packaged app sets this; the admission check loads the native signature helper from it.
  env.MURAGE_RESOURCES_PATH = resourcesDir;
  const paths = browserBundlePaths(root, "win32-x64");
  await ensureBrowserSandboxAccess({ command: paths.engine, env: {
    MURAGE_BROWSER_BUNDLE_DIR: root,
    AGENT_BROWSER_EXECUTABLE_PATH: paths.chrome,
    SystemRoot: env.SystemRoot,
  } });
  log("Signed browser original pins, publisher and sandbox access verified.");
}

async function backupDeps() {
  const [{ verifyWindowsBackupTools }, identity] = await Promise.all([
    import("./prepare-windows-backup-tools.mjs"),
    import("../server/browser-windows-identity.ts"),
  ]);
  return { verifyWindowsBackupTools, verifyWindowsBrowserSignatures: identity.verifyWindowsBrowserSignatures, nativeAuthenticodeIn: identity.nativeAuthenticodeIn };
}

async function admissionDeps() {
  const [{ browserBundlePaths }, { ensureBrowserSandboxAccess }] = await Promise.all([
    import("../server/browser-bundle-release.ts"),
    import("../server/browser-sandbox.ts"),
  ]);
  return { browserBundlePaths, ensureBrowserSandboxAccess };
}

export const GATES = Object.freeze({ backup: verifyPackagedBackupTools, admission: verifyPackagedBrowserAdmission });

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [gate, resources = DEFAULT_RESOURCES] = process.argv.slice(2);
  if (!Object.hasOwn(GATES, gate ?? "")) {
    console.error("usage: node scripts/windows-release-gates.mjs backup|admission [resources dir]");
    process.exit(2);
  }
  try { await GATES[gate]({ resources }); }
  catch (error) {
    console.error(`::error::Windows ${gate} gate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
