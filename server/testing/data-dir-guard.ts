// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two nets of the data-folder inventory guard (hard rule 8: every name
// Murage writes in its data folder is classified in data-dir-inventory.ts).
//  1. Static: every path joined directly under the data folder in source.
//  2. Runtime: a preload that records every top-level name a process creates
//     under MURAGE_DATA_DIR as it happens (a temp file renamed away a moment
//     later still counts).
// data-dir-inventory.test.ts runs the first over the repository and
// data-dir-inventory-api.test.ts the second under a real server;
// data-dir-inventory-guard.test.ts proves each one fails an unclassified
// write.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { classifyDataDirEntry } from "../data-dir-inventory.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** Identifiers that name Murage's data folder itself. */
const DATA_ROOTS = new Set(["DATA_DIR", "dataDir", "this.dataDir", "deps.dataDir", "options.dataDir", "opts.dataDir", "config.dataDir", "this.options.dataDir", "input.dataDir", "args.dataDir", "desktopDataDir"]);

export type Hit = { file: string; name: string };
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === "node_modules" || name === "vendor" || name === "testing" || name.startsWith("dist")) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:ts|tsx|mts|mjs|cjs|js)$/.test(name) && !/\.(?:test|node-test|spec|fixture)\.|\.d\.m?ts$/.test(name)) files.push(path);
    }
  };
  // companion/ keeps its own folder (~/.murage-companion, companion/src/state.ts).
  for (const dir of ["server", "electron", "shared"]) walk(join(ROOT, dir));
  return files;
}

/** Top-level names joined under the data folder, as written in the source. */
export function scanDataDirWrites(files = sourceFiles()): Hit[] {
  const hits: Hit[] = [];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    const file = relative(ROOT, path).split("\\").join("/");
    const constants = new Map<string, string>();
    for (const match of source.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string)?\s*=\s*(["'`])([^"'`\n]*)\2/g)) constants.set(match[1], match[3]);
    const roots = new Set(DATA_ROOTS);
    // A parameter or field that defaults to the data folder is the data folder.
    for (const match of source.matchAll(/([A-Za-z_$][\w$.]*)\s*(?::\s*string)?\s*(?:=|\?\?=?)\s*DATA_DIR\b/g)) roots.add(match[1]);
    for (const match of source.matchAll(/([A-Za-z_$][\w$.]*)\s*\?\?\s*DATA_DIR\b/g)) roots.add(match[1]);
    if (/\bDATA_DIR\b/.test(source)) { roots.add("this.dir"); roots.add("this.root"); }
    for (const match of source.matchAll(/\b(?:join|resolve)\(\s*([\w$.]+)\s*,\s*(?:(["'`])([^"'`\n]*)\2|([A-Za-z_$][\w$]*)\s*[,)])/g)) {
      if (!roots.has(match[1])) continue;
      const literal = match[3] ?? constants.get(match[4]) ?? `<<${match[4]}>>`;
      hits.push({ file, name: literal.split("/")[0] });
    }
  }
  return hits;
}

/** A concrete name for a hit whose source has a variable part. */
function sample(name: string): string {
  if (name.endsWith("-") && name.startsWith(".")) return `${name}a1B2c3`; // mkdtemp prefix
  return name.replace(/\$\{[^}]*\}/g, "x1");
}

/** Static hits that are neither classified nor explained in `notTheDataFolder`. */
export function unclassifiedStaticWrites(hits: Hit[], notTheDataFolder: Record<string, Record<string, string>> = {}): string[] {
  const unknown: string[] = [];
  for (const { file, name } of hits) {
    if (notTheDataFolder[file]?.[name]) continue;
    if (name.startsWith("<<")) { unknown.push(`${file}: a name built from ${name.slice(2, -2)}; classify it or explain it in NOT_THE_DATA_FOLDER`); continue; }
    if (!classifyDataDirEntry(sample(name))) unknown.push(`${file}: ${name}`);
  }
  return unknown;
}


/** Preload for the server child: log each top-level name created under
 * MURAGE_DATA_DIR by any fs call, sync or async. node:sqlite's own -wal and
 * -shm files are not fs calls; the final listing covers them. */
export function dataDirWriteRecorder(log: string): string {
  return `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const LOG = ${JSON.stringify(log)};
const roots = [...new Set([process.env.MURAGE_DATA_DIR, realpathSync(process.env.MURAGE_DATA_DIR)])].flatMap(root => root.endsWith("/") || root.endsWith("\\\\") ? [root] : [root + "/", root + "\\\\"]);
const appendLog = fs.appendFileSync.bind(fs);
const seen = new Set();
const note = target => {
  // a string, a Buffer or a file: URL, with either separator (Windows)
  const path = typeof target === "string" ? target : Buffer.isBuffer(target) ? target.toString() : target instanceof URL ? fileURLToPath(target) : null;
  if (path === null) return;
  for (const root of roots) if (path.startsWith(root)) {
    const name = path.slice(root.length).split(/[\\\\/]/)[0];
    if (name && !seen.has(name)) { seen.add(name); appendLog(LOG, name + "\\n"); }
  }
};
const creating = flags => flags === undefined || typeof flags === "number" ? (flags ?? 0) & (fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_RDWR) : /[wax+]/.test(String(flags));
const wrap = (object, name, pick) => { const original = object[name]; if (typeof original !== "function") return; object[name] = function (...args) { try { pick(args); } catch {} return original.apply(this, args); }; };
for (const [object] of [[fs], [fs.promises]]) {
  for (const name of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync", "createWriteStream"]) wrap(object, name, args => note(args[0]));
  for (const name of ["open", "openSync"]) wrap(object, name, args => { if (creating(args[1])) note(args[0]); });
  for (const name of ["rename", "renameSync", "copyFile", "copyFileSync", "symlink", "symlinkSync", "link", "linkSync", "cp", "cpSync"]) wrap(object, name, args => note(args[1]));
  for (const name of ["mkdtemp", "mkdtempSync"]) wrap(object, name, args => note(String(args[0]) + "XXXXXX"));
}
syncBuiltinESMExports();
`;
}

/** Recorded or listed names no backup classifies. mkdtemp prefixes are
 * recorded with a placeholder suffix. */
export function unclassifiedDataDirNames(names: Iterable<string>): string[] {
  return [...new Set(names)]
    .map(name => name.endsWith("XXXXXX") ? name.slice(0, -6) + "a1B2c3" : name)
    .filter(name => !classifyDataDirEntry(name));
}
