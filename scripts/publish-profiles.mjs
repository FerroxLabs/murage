// Publish the 57 single-agent profiles into the live murage-teams repo.
//
// A single-agent package IS the "assign an assistant profile to a bot"
// mechanism: same import path as a team, one agent instead of four, carrying
// its persona, playbook and skills. The content existed in library/assistants
// and bot-library/builtins and was never published, so the library UI only
// ever offered crews.
//
// Unlike import-wayland-teams-packages.mjs this MERGES. That script rmSyncs
// its output and rebuilds from Wayland; running it at the live repo would
// delete the 65 teams already there. Here the existing catalog entries are
// carried through byte for byte, in their original order, and the profiles are
// appended.
//
// Layout is dictated by parseTeamCatalog (server/team-library.ts:97-108), which
// only accepts paths under teams/<slug>/: the manifest, the README and every
// skill live there or the catalog is rejected before it reaches the renderer.
//
// Usage:
//   node scripts/publish-profiles.mjs [--repo <clone>] [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBotPackage } from "../server/bot-package.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCES = [join(repoRoot, "library", "assistants"), join(repoRoot, "bot-library", "builtins")];
const SKILL_LIBRARY = join(repoRoot, "skills-library");
// library/assistants holds the Wayland specialists; bot-library/builtins the rest.
const WAYLAND_PROFILES = 28;

const options = { repo: "/tmp/murage-teams-live", dryRun: false };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--repo") options.repo = process.argv[++i];
  else throw new Error(`unknown argument: ${arg}`);
}
if (!existsSync(join(options.repo, "catalog.json"))) throw new Error(`no catalog.json in ${options.repo}`);

const clamp = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
};

// Source files, in a stable order. `.wayland-import.json` is the importer's
// own marker, not a package.
const files = SOURCES.flatMap((dir) =>
  readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort().map((f) => join(dir, f)),
);

const catalog = JSON.parse(readFileSync(join(options.repo, "catalog.json"), "utf8"));
// Re-runnable: a second pass replaces the profiles it published last time and
// leaves everything else — the teams — exactly where it found it.
const profileSlugs = new Set(files.map((file) => JSON.parse(readFileSync(file, "utf8")).package.id));
const existing = catalog.teams.filter((entry) => !profileSlugs.has(entry.slug));
const before = existing.map((entry) => JSON.stringify(entry));

const entries = [];
const seen = new Set();
const danglingSkills = [];

for (const file of files) {
  // parseBotPackage is the gate the app itself runs. A package that does not
  // survive it is never written, so the catalog cannot advertise an entry the
  // installer will refuse.
  const document = parseBotPackage(JSON.parse(readFileSync(file, "utf8")));
  const pkg = document.package;
  if (pkg.agents.length !== 1) throw new Error(`${file}: ${pkg.agents.length} agents — not a profile`);
  if (seen.has(pkg.id)) throw new Error(`${file}: duplicate slug ${pkg.id}`);
  seen.add(pkg.id);

  const dir = join(options.repo, "teams", pkg.id);
  // Only the profile's own tree is replaced; every other entry is untouched.
  if (!options.dryRun) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "skills"), { recursive: true });
  }

  // Skills the on-disk library actually holds. 32 of the generated references
  // exist in neither Wayland pack; those are reported rather than published as
  // catalog paths that resolve to nothing. The manifest itself is copied
  // verbatim — import logs and skips a dangling id (server/index.ts:6399-6404).
  const declared = pkg.agents[0].skills ?? [];
  const skills = [];
  for (const id of declared) {
    const source = join(SKILL_LIBRARY, id, "SKILL.md");
    if (!existsSync(source)) { danglingSkills.push(`${pkg.id} → ${id}`); continue; }
    if (!options.dryRun) {
      mkdirSync(join(dir, "skills", id), { recursive: true });
      copyFileSync(source, join(dir, "skills", id, "SKILL.md"));
    }
    skills.push(`teams/${pkg.id}/skills/${id}/SKILL.md`);
  }

  if (!options.dryRun) {
    if (!skills.length) rmSync(join(dir, "skills"), { recursive: true, force: true });
    writeFileSync(join(dir, `${pkg.id}.emberteam.json`), JSON.stringify(document, null, 2) + "\n");
    writeFileSync(join(dir, "README.md"), readme(pkg, skills.length));
  }

  entries.push({
    slug: pkg.id,
    name: pkg.name,
    // A profile summary runs to paragraphs; the catalog field caps at 300 and
    // the tagline is already the one-line version, so it stands in.
    summary: clamp(pkg.summary.length > 300 ? pkg.tagline : pkg.summary, 300),
    category: pkg.category,
    outcome: clamp(pkg.outcomes[0], 300),
    setupMinutes: pkg.setupMinutes,
    ...(pkg.featured ? { featured: true } : {}),
    manifest: `teams/${pkg.id}/${pkg.id}.emberteam.json`,
    readme: `teams/${pkg.id}/README.md`,
    // The one field the client keys off: TeamLibraryPanel renders
    // "{members} bots · {skills.length} playbooks", so a profile reads as
    // "1 bots" against a team's four without inventing a field nothing reads.
    members: 1,
    skills,
    requires: { apps: pkg.requirements.apps.map((app) => clamp(app.label, 100)).slice(0, 30) },
  });
}

function readme(pkg, skillCount) {
  const agent = pkg.agents[0];
  const playbooks = (pkg.playbooks ?? []).map((p) => `- **${p.name}** — ${p.summary}`).join("\n");
  return [
    `# ${pkg.name}`,
    "",
    pkg.tagline,
    "",
    "## What it is",
    "",
    `A single-agent profile. Loading it gives one bot — **${agent.name}**${agent.title ? ` (${agent.title})` : ""} — its persona, its playbook, and its skills, through the same import path a team uses.`,
    "",
    pkg.summary,
    "",
    "## Outcomes",
    "",
    pkg.outcomes.map((o) => `- ${o}`).join("\n"),
    ...(playbooks ? ["", "## Playbooks", "", playbooks] : []),
    "",
    `_1 Ember${skillCount ? `, ${skillCount} skill${skillCount === 1 ? "" : "s"}` : ""}. ~${pkg.setupMinutes} min to set up._`,
    "",
  ].join("\n");
}

const merged = { ...catalog, teams: [...existing, ...entries] };

// The 65 that were already live must come back unchanged and in order.
const after = merged.teams.slice(0, existing.length).map((entry) => JSON.stringify(entry));
for (const [index, json] of before.entries()) {
  if (after[index] !== json) throw new Error(`existing entry ${index} changed: ${before[index]} -> ${after[index]}`);
}

if (!options.dryRun) {
  writeFileSync(join(options.repo, "catalog.json"), JSON.stringify(merged, null, 2) + "\n");
  writeFileSync(join(options.repo, "README.md"), readmeIndex(existing.length, entries.length));
}

/** The repo README is edited, not regenerated: its provenance paragraph names
 * the six OpenMausBot teams and their licence, and losing that would strip an
 * attribution the library is obliged to carry. */
function readmeIndex(teamCount, profileCount) {
  const current = readFileSync(join(options.repo, "README.md"), "utf8");
  const headline =
    `${teamCount} teams and ${profileCount} single-agent profiles. A team imports as a crew of Embers ` +
    `**and the room they work in**, with each member's playbook and skills attached. A profile is the same ` +
    `import, one Ember deep: pick one to give a single bot a persona, a playbook and its skills.`;
  const provenance =
    `The ${profileCount} profiles are ${WAYLAND_PROFILES} Wayland specialists and ` +
    `${profileCount - WAYLAND_PROFILES} Murage built-ins, one agent each.`;
  if (!current.includes("## Where these came from")) return `${current.trimEnd()}\n\n${headline}\n`;
  const rewritten = current.replace(/\n[^\n]*teams(?: and [^\n]*profiles)?\.[\s\S]*?(?=\n## Where these came from)/, `\n${headline}\n`);
  return rewritten.includes(provenance) ? rewritten : `${rewritten.trimEnd()}\n\n${provenance}\n`;
}

console.log(`teams kept        ${existing.length}`);
console.log(`profiles written  ${entries.length}`);
console.log(`catalog entries   ${merged.teams.length}`);
console.log(`skill files       ${entries.reduce((n, e) => n + e.skills.length, 0)}`);
console.log(`skill refs dropped ${danglingSkills.length} (not in skills-library/)`);
for (const d of danglingSkills) console.log(`  ${d}`);
