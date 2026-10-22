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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

// ---- The whole static import graph of the main process (Astra nops #1: shared/windows-sddl.mjs was imported by
// electron/backup-windows-acl.mjs and left out of the package). Every relative module reachable from electron/main.mjs (and from
// every other shipped electron/ file: preloads, workers and helpers load on their own) through `import ... from`, `export ... from`,
// `import "..."`, a literal `import("...")` or a literal `require("...")` must be matched by electron-builder.yml's `files:`
// list. The server is not in this graph: it ships as the esbuild bundle (scripts/bundle-server.mjs, bundle: true), which inlines
// every relative import, shared/ included; serverBundleInlinesRelativeImports() checks that no relative path is made external.

const SPECIFIERS = [
  /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
];
/** The relative specifiers one source file names (comments are not read). */
export function relativeSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  const out = new Set();
  for (const pattern of SPECIFIERS) for (const [, specifier] of code.matchAll(pattern)) if (/^\.\.?\//.test(specifier)) out.add(specifier);
  return [...out];
}
const posix = (file) => file.split("\\").join("/");
/** Every file (relative to the repository) reachable from `entries` through relative imports. Unresolvable specifiers are listed in `missing`. */
export function packagedImportGraph(entries, base = root) {
  const reached = new Set(), missing = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    const name = posix(relative(base, file));
    if (reached.has(name)) continue;
    reached.add(name);
    if (!/\.(?:mjs|cjs|js)$/.test(file)) continue;
    for (const specifier of relativeSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolve(dirname(file), specifier);
      const found = [target, `${target}.mjs`, `${target}.cjs`, `${target}.js`, join(target, "index.mjs"), join(target, "index.js")].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (found) queue.push(found); else missing.push(`${name} -> ${specifier}`);
    }
  }
  return { files: [...reached].sort(), missing };
}
/** The shipped electron/ code files: the graph's roots (electron/main.mjs first). */
export function electronEntries(directory = join(root, "electron")) {
  const out = [join(directory, "main.mjs")];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { if (!["node_modules", "fixtures", "resources"].includes(entry.name)) walk(file); continue; }
      // test tooling that ships under electron/** but the app never loads (the IPC inventory harness, the smoke driver)
      if (/\.(?:mjs|cjs|js)$/.test(entry.name) && !/\.(?:test|node-test)\./.test(entry.name) && !/electron-smoke|-harness\./.test(entry.name)) out.push(file);
    }
  };
  walk(directory);
  return out;
}
const globPart = (part) => part.split("**").map((piece) => piece.split("*").map((text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
// "**/" is zero or more folders (electron/**/*.test.* covers electron/x.test.mjs), a lone "**" anything, "*" anything but "/"
const globToRegExp = (glob) => new RegExp(`^${glob.split("**/").map(globPart).join("(?:.*/)?")}$`);
/** electron-builder.yml's top-level `files:` patterns, as { include, exclude } regular expressions. */
export function builderFilePatterns(configPath = join(root, "electron-builder.yml")) {
  const lines = readFileSync(configPath, "utf8").split("\n");
  const start = lines.findIndex((line) => /^files:\s*$/.test(line));
  if (start < 0) throw new Error("electron-builder.yml has no top-level files: list");
  const include = [], exclude = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^\s+-\s+"?([^"#]+?)"?\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const pattern = match[1].trim();
    if (pattern.startsWith("!")) exclude.push(globToRegExp(pattern.slice(1)));
    else include.push(globToRegExp(pattern));
  }
  return { include, exclude };
}
/** Whether electron-builder packages `file` (repository-relative, POSIX). */
export function isPackaged(file, patterns = builderFilePatterns()) {
  return patterns.include.some((pattern) => pattern.test(file)) && !patterns.exclude.some((pattern) => pattern.test(file));
}
/** Reachable from the main process but not packaged (each one a launch crash), and imports that resolve to nothing. */
export function unpackagedMainProcessModules() {
  const graph = packagedImportGraph(electronEntries());
  const patterns = builderFilePatterns();
  return { unpackaged: graph.files.filter((file) => !isPackaged(file, patterns)), missing: graph.missing, reached: graph.files };
}
/** The server bundle makes no relative module external, so every shared/ (or other relative) import of server code is inside it. */
export function serverBundleInlinesRelativeImports(bundleScript = join(root, "scripts", "bundle-server.mjs")) {
  const source = readFileSync(bundleScript, "utf8");
  const externals = [...source.matchAll(/\bexternal:\s*\[([^\]]*)\]/g)].flatMap((match) => [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]));
  const bundled = [...source.matchAll(/\bbundle:\s*(true|false)/g)].map((match) => match[1]);
  return { externals, relativeExternals: externals.filter((name) => /^[./]|shared\//.test(name)), bundled };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const missing = [...new Set([...missingFromPackage(), ...unpackagedMainProcessModules().unpackaged])];
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
