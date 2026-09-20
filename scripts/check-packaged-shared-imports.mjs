// electron-builder packages `electron/**`, but each `shared/*.mjs` the main
// process needs is named individually — there is no `shared/**` glob, because
// most of shared/ is renderer TypeScript that has no business in the asar.
//
// The failure mode that costs a release: add an import in electron/, forget the
// line here, and everything passes. Typecheck passes, the unit suites pass, the
// macOS and Windows build jobs pass, and the app dies on launch with
// ERR_MODULE_NOT_FOUND from inside app.asar. In 0.1.57 that was
// shared/backup-capture-failure.mjs, imported by electron/backup-schedule-host.mjs
// and caught only by the Linux packaged smoke test, after signing and
// notarisation had already run.
//
// This compares the two lists directly so the mismatch fails in a unit suite
// instead of a release build.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Every `shared/<name>.mjs` imported (statically or dynamically) by a file
 *  electron-builder packages, i.e. anything under electron/. */
export function sharedModulesImportedByElectron(directory = join(root, "electron")) {
  const wanted = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Not packaged, so its imports do not constrain the asar.
        if (entry.name === "node_modules" || entry.name === "fixtures" || entry.name === "vendor") continue;
        walk(path);
        continue;
      }
      if (!/\.(mjs|cjs|js)$/.test(entry.name)) continue;
      // Tests are excluded from the package by `!electron/**/*.test.*`.
      if (/\.(test|node-test)\./.test(entry.name)) continue;
      const source = readFileSync(path, "utf8");
      for (const [, name] of source.matchAll(/["'`]\.\.\/shared\/([A-Za-z0-9._-]+\.mjs)["'`]/g)) {
        wanted.add(`shared/${name}`);
      }
    }
  };
  walk(directory);
  return [...wanted].sort();
}

/** Every `shared/*.mjs` named in the builder's `files:` list. A line that is
 *  an exclusion (`!shared/...`) does not count as packaged. */
export function sharedModulesPackaged(configPath = join(root, "electron-builder.yml")) {
  const listed = new Set();
  for (const line of readFileSync(configPath, "utf8").split("\n")) {
    const text = line.trim();
    if (!text.startsWith("-")) continue;
    const match = /^-\s*"?!?(shared\/[A-Za-z0-9._-]+\.mjs)"?\s*$/.exec(text);
    if (match && !text.includes("!")) listed.add(match[1]);
  }
  return [...listed].sort();
}

/** Imported by the main process but not packaged: each one is a launch crash. */
export function missingFromPackage() {
  const packaged = new Set(sharedModulesPackaged());
  return sharedModulesImportedByElectron().filter((name) => !packaged.has(name));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const missing = missingFromPackage();
  if (missing.length) {
    process.stderr.write(
      `These shared modules are imported by the packaged main process but are not in ` +
      `electron-builder.yml's files list, so the packaged app will fail to launch:\n` +
      missing.map((name) => `  ${name}`).join("\n") + "\n",
    );
    process.exitCode = 1;
  } else {
    process.stdout.write("Packaged shared imports: every shared/*.mjs the main process imports is packaged.\n");
  }
}
