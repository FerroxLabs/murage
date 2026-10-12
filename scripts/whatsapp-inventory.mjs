// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const excludedPackage = name => name === "sharp" || name.startsWith("@img/");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const allowed = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "Zlib"]);
export function licenseAllowed(name, expression) {
  const tokens = String(expression ?? "").match(/\(|\)|AND|OR|[A-Za-z0-9.+-]+/g) ?? [];
  let i = 0;
  const atom = () => {
    if (tokens[i] === "(") { i++; const value = or(); if (tokens[i++] !== ")") throw Error("Invalid licence"); return value; }
    const id = tokens[i++];
    return allowed.has(id) || name === "libsignal" && ["GPL-3.0", "GPL-3.0-only", "GPL-3.0-or-later"].includes(id);
  };
  const and = () => { let value = atom(); while (tokens[i] === "AND") { i++; const next = atom(); value = value && next; } return value; };
  const or = () => { let value = and(); while (tokens[i] === "OR") { i++; const next = and(); value = value || next; } return value; };
  try { return or() && i === tokens.length; } catch { return false; }
}

/** The staged closure of the WhatsApp runtime. The tree is hoisted (see stage-hoisted.mjs), so the closure is
 * found the way Node finds it: from each package, walk up its node_modules chain for every declared dependency. */
function resolveStaged(name, from, modules) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = basename(dir) === "node_modules" ? join(dir, name) : join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === modules || dirname(dir) === dir) return null;
  }
}
function declaredRequired(pkg) {
  return Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).filter(name => !pkg.optionalDependencies?.[name] && !pkg.peerDependenciesMeta?.[name]?.optional &&
    // The pinned workspace extension makes Baileys' sharp peer optional. A regular dependency still fails.
    !(pkg.name === "baileys" && name === "sharp" && !pkg.dependencies?.sharp));
}
function packageDirectories(server) {
  const modules = join(resolve(server), "node_modules"), dirs = [], seen = new Set();
  const walk = dir => {
    if (seen.has(dir)) return;
    if (!existsSync(join(dir, "package.json"))) throw Error(`Missing staged package: ${dir}`);
    seen.add(dir); dirs.push(dir);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), identity = `${pkg.name}@${pkg.version}`;
    const required = new Set(declaredRequired(pkg));
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      if (excludedPackage(dependency)) throw Error(`Excluded WhatsApp dependency: ${dependency}`);
      const target = resolveStaged(dependency, dir, modules);
      if (target) walk(target);
      else if (required.has(dependency)) throw Error(`Missing staged dependency: ${identity} -> ${dependency}`);
    }
    for (const dependency of required) if (!resolveStaged(dependency, dir, modules)) throw Error(`Missing staged dependency: ${identity} -> ${dependency}`);
  };
  for (const name of ["baileys", "jimp"]) walk(join(modules, name));
  return dirs;
}
function notices(dir) {
  const files = [];
  const walk = folder => {
    for (const name of readdirSync(folder).sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(folder, name), stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (/^(licen[cs]e|copying|notice|copyright)([.-]|$)/i.test(name)) files.push(path);
    }
  };
  walk(dir); return files;
}

// Text that makes a root markdown file the package's licence text (stage-hoisted.mjs keeps root markdown only
// for packages that publish no licence file).
const LICENCE_TEXT = /permission is hereby granted|permission to use, copy, modify|redistribution and use in source|licensed under the apache license|apache license,? version 2|this is free and unencumbered software/i;
function licenceDocuments(dir) {
  return readdirSync(dir).sort().filter(name => /\.md$/i.test(name) && !/^changelog/i.test(name) && statSync(join(dir, name)).isFile() && LICENCE_TEXT.test(readFileSync(join(dir, name), "utf8"))).map(name => join(dir, name));
}

// Licence text can also sit inside a retained source file (omggif.js opens with the MIT text).
const EMBEDDED_LICENCE = /permission is hereby granted|permission to use, copy, modify|redistribution and use in source|licensed under the (apache|mit|bsd|isc)|apache license,? version 2|this is free and unencumbered software|spdx-license-identifier:/i;
function carriesLicenceText(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules") continue;
    const path = join(dir, name), stat = statSync(path);
    if (stat.isDirectory()) { if (carriesLicenceText(path)) return true; }
    else if (stat.size <= 2_000_000 && /\.(c?js|mjs|ts|d\.ts|json|txt|md)$/i.test(name) && name !== "package.json" && EMBEDDED_LICENCE.test(readFileSync(path, "utf8"))) return true;
  }
  return false;
}

/** Identities that publish no licence text anywhere: the inventory carries only the generated LICENSE.declared
 * metadata and no retained file under `server` embeds licence text. Reviewed by hand; the packaging check reports them. */
export function declaredOnly(inventory, server) {
  return inventory.filter(pkg => pkg.licenseFiles.every(file => file.source === "package.json") && !(server && carriesLicenceText(join(resolve(server), pkg.path)))).map(pkg => `${pkg.name}@${pkg.version}`);
}
function declaredNotice(pkg, license) {
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return [`${pkg.name}@${pkg.version}`, `Licence declared in package.json: ${license}`,
    ...(author ? [`Author: ${author}`] : []), ...(repository ? [`Source: ${repository}`] : []),
    "The published package includes no licence file; this notice is generated from its package.json.", ""].join("\n");
}

/** Generate from the actual staged closure, with the lockfile as the integrity authority. */
export function generateInventory({ server, lockfile, write = true }) {
  const lock = parse(readFileSync(lockfile, "utf8"));
  const directories = packageDirectories(server);
  return directories.map(dir => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const { name, version } = pkg, identity = `${name}@${version}`;

    if (excludedPackage(name)) throw Error(`Excluded WhatsApp dependency: ${name}`);
    const integrity = lock.packages?.[identity]?.resolution?.integrity;
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity ?? "")) throw Error(`Missing registry integrity: ${identity}`);
    const license = pkg.license ?? (pkg.licenses?.map(item => item.type).join(" OR ")) ?? (identity === "exif-parser@0.1.12" ? "MIT" : null);
    if (!licenseAllowed(name, license)) throw Error(`Review licence: ${identity}: ${license}`);
    let files = notices(dir);
    if (!files.length) files = licenceDocuments(dir);
    // A few permissive packages publish no licence file. Their notice is generated from the
    // licence they declare in package.json, marked as generated, and never invented beyond it.
    if (!files.length && !/^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD)$/.test(license ?? "")) throw Error(`Missing licence files: ${identity}`);
    const declared = files.length ? [] : [{ source: "package.json", name: "LICENSE.declared", bytes: Buffer.from(declaredNotice(pkg, license)) }];
    const licenseFiles = [...files.map(path => ({ source: relative(dir, path), name: relative(dir, path), bytes: readFileSync(path) })), ...declared].map(({ source, name, bytes }) => {
      const target = join("licenses", "whatsapp", encodeURIComponent(identity), name);
      if (write) { mkdirSync(dirname(join(server, target)), { recursive: true }); writeFileSync(join(server, target), bytes); }
      return { source, path: target, sha256: digest(bytes), bytes: bytes.length };
    });
    return { name, version, license, integrity, path: relative(server, dir), licenseFiles };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

export function verifyInventory({ server, lockfile, advisory, requireAdvisory = true }) {
  const manifest = JSON.parse(readFileSync(join(server, "whatsapp-runtime-manifest.json"), "utf8"));
  const bridge = manifest.bridge;
  const bridgePath = join("channels", "whatsapp", "bridge.js");
  if (!bridge || bridge.path?.replaceAll("\\", "/") !== "channels/whatsapp/bridge.js") throw Error("WhatsApp bridge inventory is required");
  const bytes = readFileSync(join(server, bridgePath));
  if (bridge.bytes !== bytes.length || bridge.sha256 !== digest(bytes)) throw Error("WhatsApp bridge differs from inventory");
  const actual = generateInventory({ server, lockfile, write: false });
  if (JSON.stringify(manifest.packages) !== JSON.stringify(actual)) throw Error("WhatsApp dependency inventory differs from staged files");
  for (const pkg of actual) for (const file of pkg.licenseFiles) {
    if (digest(readFileSync(join(server, file.path))) !== file.sha256) throw Error(`Licence copy differs: ${file.path}`);
  }
  if (requireAdvisory) {
    const record = JSON.parse(readFileSync(advisory, "utf8"));
    const baileys = actual.find(pkg => pkg.name === "baileys");
    if (record.status !== "reviewed" || record.id !== "GHSA-qvv5-jq5g-4cgg" ||
      record.source !== "https://github.com/advisories/GHSA-qvv5-jq5g-4cgg" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(record.checkedAt ?? "") || !record.affectedRange || !record.patchedRange ||
      !record.distTagLatest || record.version !== baileys.version || record.integrity !== baileys.integrity) throw Error("WhatsApp advisory review evidence is required");
  }
  return actual.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const server = resolve(process.argv[2] ?? join(root, "dist-server"));
  const options = { server, lockfile: join(root, "pnpm-lock.yaml"), advisory: join(root, "third_party/baileys/advisory.json") };
  if (!process.argv.includes("--check")) {
    const path = join(server, "whatsapp-runtime-manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.packages = generateInventory(options); writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  }
  console.log(`Verified ${verifyInventory(options)} WhatsApp dependency records`);
  const bare = declaredOnly(JSON.parse(readFileSync(join(server, "whatsapp-runtime-manifest.json"), "utf8")).packages, server);
  console.log(`Packages that publish no licence text (declared metadata only): ${bare.length ? bare.join(", ") : "none"}`);
}
