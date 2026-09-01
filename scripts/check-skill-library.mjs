// Reads every skills-library/<id>/SKILL.md through the real parser and reports
// how many yield a usable index line.
//
// The catalog is generated, so a frontmatter shape the parser cannot read is
// silent: the skill installs, shows an empty description, and the model never
// has a reason to open it. This turns that into a number.
//
// Usage: node scripts/check-skill-library.mjs [--root <dir>] [--samples 3]
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DESCRIPTION_MAX, parseSkillMd } from "../server/skills.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const root = flag("--root", join(repoRoot, "skills-library"));
const sampleCount = Number(flag("--samples", "3"));

const directories = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const failures = [];
const samples = [];
let longest = { id: "", length: 0 };
let parsed = 0;

for (const id of directories) {
  const result = parseSkillMd(readFileSync(join(root, id, "SKILL.md"), "utf8"));
  if ("error" in result) {
    failures.push(`${id}: ${result.error}`);
    continue;
  }
  if (!result.description.trim()) {
    failures.push(`${id}: empty description`);
    continue;
  }
  if (result.description.length > longest.length) longest = { id, length: result.description.length };
  parsed += 1;
  // Spread the samples across the alphabet rather than showing three neighbours.
  if (samples.length < sampleCount && parsed % Math.ceil(directories.length / (sampleCount + 1)) === 1) {
    samples.push(result);
  }
}

console.log(`root               ${root}`);
console.log(`skill directories  ${directories.length}`);
console.log(`non-empty parses   ${parsed}`);
console.log(`failures           ${failures.length}`);
console.log(`longest description ${longest.length} chars (${longest.id}), limit ${DESCRIPTION_MAX}`);
for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`);
for (const sample of samples) console.log(`\n  ${sample.name}\n    ${sample.description}`);

process.exit(failures.length ? 1 : 0);
