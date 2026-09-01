#!/usr/bin/env node
// Merge upstream's six teams into the Murage library.
//
// They are MIT-licensed and genuinely good, and they cover outbound ground the
// Wayland set does not. Two transforms are needed and both are pure renames the
// fork created: the manifest extension (.mausteam.json -> .emberteam.json) and
// the routine target enum (runOn: maus -> ember). Authorship is left ALONE —
// keeping "OpenMausBot" as the author is the honest attribution.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const UP = "https://raw.githubusercontent.com/milind-soni/openmausbot-teams/main";
const OUT = "/tmp/murage-teams-repo";

const get = async (p) => {
  const r = await fetch(`${UP}/${p}`);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.text();
};
const put = (rel, body) => { mkdirSync(dirname(join(OUT, rel)), { recursive: true }); writeFileSync(join(OUT, rel), body); };

const ours = JSON.parse(readFileSync(join(OUT, "catalog.json"), "utf8"));
const mine = new Set(ours.teams.map((t) => t.slug));
const up = JSON.parse(await get("catalog.json"));

const added = [], collided = [];
for (const t of up.teams) {
  if (mine.has(t.slug)) { collided.push(t.slug); continue; }

  // the package markdown, with the two fork renames applied
  const pkgPath = `packages/${t.slug}.md`;
  let md = await get(t.package ?? pkgPath);
  md = md.replace(/^(\s*runOn:\s*)maus\s*$/gm, "$1ember");
  put(pkgPath, md);

  // the manifest, renamed to the extension our catalog parser requires
  const manifest = `teams/${t.slug}/${t.slug}.emberteam.json`;
  put(manifest, (await get(t.manifest)).replace(/"maus\.(team|package)"/g, '"murage.$1"').replace(/"openmaus\.(team|package)"/g, '"murage.$1"'));
  put(`teams/${t.slug}/README.md`, await get(t.readme));
  for (const s of t.skills ?? []) put(s, await get(s));

  added.push({ ...t, manifest, package: pkgPath });
}

ours.teams = [...ours.teams, ...added].sort((a, b) => a.slug.localeCompare(b.slug));
writeFileSync(join(OUT, "catalog.json"), JSON.stringify(ours, null, 2) + "\n");
console.log(`  merged ${added.length}: ${added.map((t) => t.slug).join(", ")}`);
if (collided.length) console.log(`  slug collisions skipped: ${collided.join(", ")}`);
console.log(`  catalog now ${ours.teams.length} teams`);
