#!/usr/bin/env node
// Vendor every library document that has no committed source in this repo.
//
// WHY THIS EXISTS. The library's 122 entries have three provenances and only
// two of them were ever committed here:
//
//   57 single-agent profiles  library/assistants/ (28) + bot-library/builtins/ (29)
//                             — committed, and byte-identical to what the live
//                               repo serves. Nothing to vendor.
//   59 Wayland team packages  teams-library/teams/*.json is NOT the same document.
//                             Those are `murage.team` v2 — no rooms, no playbooks,
//                             no skills — and they are not tracked by git at all
//                             (`git ls-files teams-library` is empty). The live
//                             repo serves the RICH `murage.package` form built by
//                             scripts/import-wayland-teams-packages.mjs from a
//                             Wayland checkout that exists on one machine.
//    6 OpenMausBot teams      MIT, from milind-soni/openmausbot-teams, merged by
//                             scripts/merge-upstream-teams.mjs. Never in this repo.
//
// So 65 of the 122 documents an offline install needs live only on the network.
// This script pulls them once and commits them. It is the ONLY networked step in
// the local-catalog chain: scripts/build-local-catalog.mjs and everything the
// server does at runtime read committed bytes.
//
// Run it when the live library changes, then commit library/packages/ and the
// regenerated library/catalog.json together.
//
// Usage:
//   node scripts/vendor-team-packages.mjs [--dry-run] [--root <catalog url>]
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBotPackage } from "../server/bot-package.ts";
import { TEAM_LIBRARY_RAW_ROOT } from "../server/team-library.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const PROFILE_SOURCE_DIRECTORIES = ["library/assistants", "bot-library/builtins"];
export const VENDORED_PACKAGE_DIRECTORY = "library/packages";

const options = { dryRun: false, root: TEAM_LIBRARY_RAW_ROOT };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--root") options.root = process.argv[++i];
  else throw new Error(`unknown argument: ${arg}`);
}

const profileSlugs = new Set(
  PROFILE_SOURCE_DIRECTORIES.flatMap((directory) =>
    readdirSync(join(repoRoot, directory))
      .filter((file) => file.endsWith(".json") && !file.startsWith("."))
      .map((file) => file.replace(/\.json$/, "")),
  ),
);

const response = await fetch(`${options.root}/catalog.json`, { redirect: "error" });
if (!response.ok) throw new Error(`catalog.json -> HTTP ${response.status}`);
const catalog = JSON.parse(await response.text());
if (catalog.format !== "murage.catalog" || catalog.version !== 1) throw new Error("not a murage.catalog v1");

const outDirectory = join(repoRoot, VENDORED_PACKAGE_DIRECTORY);
mkdirSync(outDirectory, { recursive: true });

const written = [];
const kept = new Set();
let bytes = 0;

for (const entry of catalog.teams) {
  if (profileSlugs.has(entry.slug)) continue;
  // `package` is the markdown playbook form and takes precedence at install
  // time (fetchShareable in server/team-library.ts), so it is the document to
  // vendor whenever it is declared.
  const relative = entry.package ?? entry.manifest;
  const markdown = relative.endsWith(".md");
  const document = await fetch(`${options.root}/${relative}`, { redirect: "error" });
  if (!document.ok) throw new Error(`${relative} -> HTTP ${document.status}`);
  const body = await document.text();
  // The gate the app itself runs. A document that does not survive it is never
  // committed, so the generated catalog cannot advertise an entry the importer
  // would refuse.
  const parsed = parseBotPackage(markdown ? body : JSON.parse(body));
  if (parsed.package.id !== entry.slug) {
    throw new Error(`${relative}: package id ${parsed.package.id} does not match catalog slug ${entry.slug}`);
  }
  const file = join(outDirectory, `${entry.slug}${markdown ? ".md" : ".json"}`);
  kept.add(`${entry.slug}${markdown ? ".md" : ".json"}`);
  bytes += Buffer.byteLength(body);
  const unchanged = existsSync(file) && readFileSync(file, "utf8") === body;
  if (!unchanged && !options.dryRun) writeFileSync(file, body);
  if (!unchanged) written.push(entry.slug);
}

// A slug that left the live catalog must leave the vendored tree too, or the
// generated catalog keeps offering something upstream has retired.
const stale = readdirSync(outDirectory).filter((file) => !kept.has(file));
for (const file of stale) if (!options.dryRun) rmSync(join(outDirectory, file));

console.log(`catalog entries   ${catalog.teams.length}`);
console.log(`profiles skipped  ${profileSlugs.size} (committed under ${PROFILE_SOURCE_DIRECTORIES.join(", ")})`);
console.log(`vendored          ${kept.size} documents, ${bytes} bytes`);
console.log(`changed           ${written.length}${written.length ? `: ${written.join(", ")}` : ""}`);
console.log(`removed           ${stale.length}${stale.length ? `: ${stale.join(", ")}` : ""}`);
if (options.dryRun) console.log("(dry run — nothing written)");
