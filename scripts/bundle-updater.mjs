// Bundle electron-updater into one self-contained file the packaged app can
// require. This app ships ZERO node_modules at runtime (the harness + UI are
// pre-compiled into Resources), so a main-process dependency has to be
// vendored. esbuild inlines electron-updater + its whole dep tree; `electron`
// stays external (resolved from the runtime). Output ships via files:electron/**.
//
// The bundle is then patched so an AppImage update keeps the path the user
// launches — see scripts/patch-appimage-updater.mjs for why.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { patchAppImageUpdater } from "./patch-appimage-updater.mjs";
import { assertWindowsVerifierSource, patchWindowsSignatureVerifier } from "./patch-windows-signature-verifier.mjs";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "electron/vendor/electron-updater.cjs");

const updaterPackage = require.resolve("electron-updater/package.json");
assertWindowsVerifierSource(
  JSON.parse(await readFile(updaterPackage, "utf8")).version,
  await readFile(join(dirname(updaterPackage), "out/windowsExecutableCodeSignatureVerifier.js")),
);

const result = await build({
  entryPoints: [require.resolve("electron-updater")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  outfile,
  write: false,
  logLevel: "info",
});

// Throws when upstream's shape moved, so a bundle that would silently break
// AppImage launchers never reaches a release.
const patched = patchWindowsSignatureVerifier(patchAppImageUpdater(result.outputFiles[0].text));
await writeFile(outfile, patched);
console.log("patched AppImage install and fail-closed Windows signature verification");
