#!/usr/bin/env node
// Generate library/catalog.json — the library index the app reads with the
// network unplugged.
//
// WHY. Until now the catalog existed only at
// raw.githubusercontent.com/FerroxLabs/murage-teams/main/catalog.json, and
// GET /api/team-library/catalog returned 502 on any failure, so offline the
// library panel was an error box. Murage runs headless, air-gapped and behind
// local models; a network call may never be REQUIRED for the library to work.
//
// INPUTS — all committed, all read from disk, no network:
//   library/assistants/*.json     28 Wayland specialist profiles
//   bot-library/builtins/*.json   29 Murage built-in profiles
//   library/packages/*.{json,md}  65 team documents vendored by
//                                 scripts/vendor-team-packages.mjs
//   skills-library/<id>/          the shipped skill catalog, used to decide
//                                 which declared skill ids actually install
//
// Every one of the 122 sources is a `murage.package`, so there is exactly one
// derivation rule rather than one per provenance. The rule reproduces the live
// catalog's 57 profile entries field-for-field (measured); it deliberately
// differs in two places, both toward honesty:
//
//   * The 59 Wayland team entries carry `skills: []` upstream even though
//     their members install real skills. Here `skills` is derived from the
//     members' declared ids, filtered to what skills-library actually ships,
//     so the count the card shows is the count that lands.
//   * The 6 OpenMausBot entries take their name/summary/outcome from their own
//     package document rather than upstream's separately hand-written catalog
//     text, so the browse label and the import preview cannot disagree. Their
//     `skills` become [] because those ids are PLAYBOOKS in the package, not
//     skills: the importer reads agents[].skills, so upstream's three-SKILL.md
//     advertisement installs nothing, online or offline.
//
// Usage:
//   node --experimental-strip-types scripts/build-local-catalog.mjs [--check]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBotPackage } from "../server/bot-package.ts";
import { checkLibrarySkill } from "../server/skills.ts";
import { TEAM_LIBRARY_REPOSITORY, parseTeamCatalog } from "../server/team-library.ts";

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Where the generated catalog lands. Committed, so staleness is reviewable in
 *  a diff instead of invisible. */
export const LOCAL_CATALOG_FILE = "library/catalog.json";
/** Single-agent profile packages, one file per slug, filename === package id. */
export const PROFILE_DIRECTORIES = ["library/assistants", "bot-library/builtins"];
/** Team documents with no other committed source. See vendor-team-packages.mjs. */
export const PACKAGE_DIRECTORY = "library/packages";
export const SKILL_LIBRARY_DIRECTORY = "skills-library";

const clamp = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/** A skill id installs only if it survives EVERY rule installSkillFromLibrary
 *  applies — so this asks the installer's own checker rather than restating a
 *  subset of it (server/skills.ts checkLibrarySkill).
 *
 *  This used to test `existsSync(SKILL.md) && existsSync(manifest.json)` while
 *  claiming to match the installer. It did not: both files can be present and
 *  the install still fail, most easily when SKILL.md's frontmatter `name`
 *  disagrees with the directory id — the state nine shipped skills were in.
 *  A catalog built on the loose test can therefore advertise a skill whose
 *  "Set this up" button fails, which is the exact dishonesty the `dangling`
 *  report at the bottom of this file exists to prevent. One rule set, owned by
 *  the installer, used by both. */
export function installableSkillIds(root) {
  if (!existsSync(root)) return new Set();
  const installable = new Set();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!("error" in checkLibrarySkill(entry.name, root))) installable.add(entry.name);
  }
  return installable;
}

/** Every local source document, in a stable order: profiles first (matching the
 *  order publish-profiles.mjs appends them), then the vendored team packages. */
export function localCatalogSources(repoRoot = REPO_ROOT) {
  const sources = [];
  for (const directory of PROFILE_DIRECTORIES) {
    const absolute = join(repoRoot, directory);
    if (!existsSync(absolute)) continue;
    for (const file of readdirSync(absolute).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()) {
      sources.push({ slug: file.replace(/\.json$/, ""), path: join(absolute, file), markdown: false });
    }
  }
  const packages = join(repoRoot, PACKAGE_DIRECTORY);
  if (existsSync(packages)) {
    for (const file of readdirSync(packages).filter((f) => (f.endsWith(".json") || f.endsWith(".md")) && !f.startsWith(".")).sort()) {
      sources.push({ slug: file.replace(/\.(json|md)$/, ""), path: join(packages, file), markdown: file.endsWith(".md") });
    }
  }
  return sources;
}

export function buildLocalCatalog(repoRoot = REPO_ROOT) {
  const installable = installableSkillIds(join(repoRoot, SKILL_LIBRARY_DIRECTORY));
  const teams = [];
  const seen = new Set();
  /** Declared-but-not-shipped skill ids, reported rather than advertised. */
  const dangling = [];

  for (const source of localCatalogSources(repoRoot)) {
    const raw = readFileSync(source.path, "utf8");
    // parseBotPackage is the gate the importer runs. A source that does not
    // survive it never reaches the catalog, so the catalog cannot list an entry
    // whose "Set this up" button would fail.
    const pkg = parseBotPackage(source.markdown ? raw : JSON.parse(raw)).package;
    if (pkg.id !== source.slug) throw new Error(`${source.path}: package id ${pkg.id} does not match its filename`);
    if (seen.has(pkg.id)) throw new Error(`${source.path}: duplicate slug ${pkg.id}`);
    seen.add(pkg.id);

    // A profile summary runs to paragraphs and the catalog field caps at 300;
    // the tagline is already the one-line version, so it stands in.
    const summary = clamp(pkg.summary.length > 300 ? pkg.tagline : pkg.summary, 300);
    const outcome = pkg.outcomes?.[0] ? clamp(pkg.outcomes[0], 300) : "";
    // The team packages set outcomes[0] to a truncation of the same sentence as
    // the summary. Repeating it on the card is noise, not information.
    const echoesSummary =
      !outcome ||
      summary === outcome ||
      summary.startsWith(outcome.replace(/…$/, "")) ||
      outcome.startsWith(summary.replace(/…$/, ""));

    const declared = [...new Set(pkg.agents.flatMap((agent) => agent.skills ?? []))];
    for (const id of declared) if (!installable.has(id)) dangling.push(`${pkg.id} → ${id}`);
    const skills = declared.filter((id) => installable.has(id));

    teams.push({
      slug: pkg.id,
      name: pkg.name,
      summary,
      category: pkg.category,
      ...(echoesSummary ? {} : { outcome }),
      setupMinutes: pkg.setupMinutes,
      ...(pkg.featured ? { featured: true } : {}),
      ...(source.markdown ? { package: `packages/${pkg.id}.md` } : {}),
      manifest: `teams/${pkg.id}/${pkg.id}.emberteam.json`,
      readme: `teams/${pkg.id}/README.md`,
      // TeamLibraryPanel renders "{members} bots · {skills.length} playbooks",
      // so a profile reads as "1 bots" against a team's four.
      members: pkg.agents.length,
      skills: skills.map((id) => `teams/${pkg.id}/skills/${id}/SKILL.md`),
      requires: { apps: pkg.requirements.apps.map((app) => clamp(app.label, 100)).slice(0, 30) },
    });
  }

  const catalog = { format: "murage.catalog", version: 1, repositoryUrl: TEAM_LIBRARY_REPOSITORY, teams };
  // The local catalog goes through the same gate as anything arriving from the
  // network. If it cannot survive parseTeamCatalog it must not be committed.
  parseTeamCatalog(catalog);
  return { catalog, dangling };
}

/** The exact bytes library/catalog.json must contain. Pretty-printed on purpose:
 *  a generated file nobody can read in a diff rots without anyone noticing. */
export function renderLocalCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const check = process.argv.includes("--check");
  const { catalog, dangling } = buildLocalCatalog();
  const rendered = renderLocalCatalog(catalog);
  const file = join(REPO_ROOT, LOCAL_CATALOG_FILE);
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;

  console.log(`entries            ${catalog.teams.length}`);
  console.log(`solo profiles      ${catalog.teams.filter((t) => t.members === 1).length}`);
  console.log(`skill references   ${catalog.teams.reduce((n, t) => n + t.skills.length, 0)}`);
  console.log(`bytes              ${Buffer.byteLength(rendered)}`);
  console.log(`declared but not shipped ${dangling.length}`);
  for (const entry of dangling.slice(0, 20)) console.log(`  ${entry}`);

  if (check) {
    if (current === rendered) {
      console.log(`${LOCAL_CATALOG_FILE} is up to date`);
    } else {
      console.error(`${LOCAL_CATALOG_FILE} is stale — run node --experimental-strip-types scripts/build-local-catalog.mjs`);
      process.exit(1);
    }
  } else if (current === rendered) {
    console.log(`${LOCAL_CATALOG_FILE} unchanged`);
  } else {
    writeFileSync(file, rendered);
    console.log(`${LOCAL_CATALOG_FILE} written`);
  }
}
