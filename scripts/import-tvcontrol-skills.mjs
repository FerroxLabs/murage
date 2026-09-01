// Convert the 11 published tvcontrol skills into Murage skill directories.
//
// Source of truth is ~/dev/tvcontrol/skills/<id>/SKILL.md — the MIT-licensed
// skills that ship with the tvcontrol package. Only these eleven ship; the
// unpublished trading research that lives elsewhere on disk is deliberately
// not a source here and must never become one.
//
// Each one is written as
//
//   <out>/<id>/manifest.json   generated (parseSkillManifest, server/skill-library.ts:32)
//   <out>/<id>/SKILL.md        the body, with `license` added to the frontmatter
//
// Usage: node scripts/import-tvcontrol-skills.mjs [--out <dir>] [--source <dir>] [--dry-run]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SOURCE = join(homedir(), "dev/tvcontrol/skills");
const DEFAULT_OUT = join(repoRoot, "skills-library");
const LICENSE = "MIT";

// Named rather than discovered: the source directory is someone else's repo,
// so a skill appearing there later must be an explicit decision to publish it.
const SKILLS = [
  "chart-analysis",
  "morning-prep",
  "multi-symbol-scan",
  "multi-pane-analysis",
  "learn-from-losses",
  "replay-practice",
  "strategy-ab-test",
  "strategy-report",
  "pine-develop",
  "porting-pine-versions",
  "rebuild-from-screenshot",
];

// Every one of these drives a chart; the shared terms are what a selector
// actually matches on, and the id words cover the specific job.
const SHARED_TERMS = ["trading", "tradingview", "charts", "markets"];

const options = { out: DEFAULT_OUT, source: DEFAULT_SOURCE, dryRun: false };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--out" || arg === "--source") options[arg.slice(2)] = process.argv[++i];
  else throw new Error(`unknown argument: ${arg}`);
}
options.out = isAbsolute(options.out) ? options.out : resolve(process.cwd(), options.out);
options.source = isAbsolute(options.source) ? options.source : resolve(process.cwd(), options.source);

const singleLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const humanName = (id) => id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** Read the two frontmatter keys the spec requires without a YAML engine —
 * same narrow reader as server/skills.ts:parseSkillMd, for the same reason. */
function frontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md has no frontmatter");
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { fields, head: match[1], body: match[2] };
}

let written = 0;
for (const id of SKILLS) {
  const sourceFile = join(options.source, id, "SKILL.md");
  if (!existsSync(sourceFile)) throw new Error(`missing source skill: ${sourceFile}`);
  const raw = readFileSync(sourceFile, "utf8");
  const { fields, head, body } = frontmatter(raw);
  if (fields.name !== id) throw new Error(`${id}: frontmatter name is ${JSON.stringify(fields.name)}`);
  if (!fields.description) throw new Error(`${id}: frontmatter has no description`);

  // The store displays `license` and the catalog is public, so the term the
  // source ships under is carried rather than assumed downstream.
  const skillMd = fields.license ? raw : `---\n${head}\nlicense: ${LICENSE}\n---\n${body}`;
  const manifest = {
    id,
    name: humanName(id),
    version: "1.0.0",
    description: singleLine(fields.description),
    defaultEnabled: false,
    triggerTerms: [...new Set([...id.split("-"), ...SHARED_TERMS])],
    requiredCapabilities: [],
  };

  const dir = join(options.out, id);
  if (!options.dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillMd);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  written += 1;
  console.log(`${options.dryRun ? "would write" : "wrote"}  ${id}`);
}
console.log(`\n${written}/${SKILLS.length} skills into ${options.out}`);
