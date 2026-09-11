// Convert Wayland's 28 specialist assistant profiles into Murage bot packages.
//
// Wayland keeps a specialist in three places: an entry in
// `contributes/assistants.json` (name, description, category, enabledSkills,
// prompts, kickoffs), a persona file at `assistants/roles/<id>.md`, and a
// skill catalog in `contributes/skills.json`. Murage keeps the same thing in
// one portable document — the bot package parsed by `parseBotPackage`
// (server/bot-package.ts). This writes one package per specialist:
//
//   <out>/assistants/<id>.json     format "murage.package", version 1
//
// The mapping, field by field (nothing here is invented — every value comes
// from the source, or is a documented constant):
//
//   package.id          ← assistant id
//   package.name        ← assistant name
//   package.tagline     ← assistant description (clamped to 160)
//   package.summary     ← description + the persona file's lead paragraphs
//   package.category    ← assistant category, title-cased
//   package.outcomes    ← assistant `prompts`, or — for the six Quiet Money
//                         layer specialists, which ship none — the bullets of
//                         the persona file's behaviour section
//   agents[0]           ← the one specialist: key/name/title/description
//   agents[0].skills    ← assistant `enabledSkills`, verbatim
//   playbooks[0]        ← the persona markdown, verbatim, as `instructions`
//
// Constants, because the source has no equivalent field: release 1.0.0,
// author "Wayland" (contributes/../aion-extension.json), license Apache-2.0
// (this repo's LICENSE), setupMinutes 5, no required apps or capabilities.
//
// Colours come from the package schema's COLORS enum and mascot expressions
// from EmberAvatar's state names (src/components/EmberAvatar.tsx:1956); both
// are assigned per source category so a category reads as one visual family.
//
// `enabledSkills` are kept exactly as written. Resolution against the
// installed library happens at import time (docs/plans/wayland-library-port.md),
// so this only *reports* which ids are present in `--skills-dir` and in the
// Wayland catalog — it never silently drops one.
//
// The source tree is never modified.
//
// Usage:
//   node scripts/import-wayland-assistants.mjs [--out <dir>] [--source <dir>]
//                                              [--skills-dir <dir>]
//                                              [--force] [--dry-run]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SOURCE = "/Volumes/Mando/wayland/app/resources/builtin-extensions/waylandteams";
const DEFAULT_OUT = join(repoRoot, "library");
const DEFAULT_SKILLS_DIR = join(repoRoot, "skills-library");
// Written into <out>/assistants so a re-run knows the tree is ours to replace.
// A dotfile, so a consumer listing packages with a `*.json` glob skips it.
const MARKER = ".wayland-import.json";

const PACKAGE_ID = /^[a-z0-9][a-z0-9-]*$/;
const KEY = /^[a-z0-9][a-z0-9_-]*$/;

const RELEASE = "1.0.0";
const AUTHOR = "Wayland";
const LICENSE = "Apache-2.0";
const SETUP_MINUTES = 5;

// server/bot-package.ts COLORS — the only values `appearance.color` accepts.
const COLORS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];

/** One colour and one resting face per Wayland category, so the six families
 * stay visually distinct. Every expression is an EmberAvatar state name. */
const CATEGORY_APPEARANCE = {
  research: { color: "cyan", mascotExpression: "searching" },
  write: { color: "purple", mascotExpression: "writing" },
  sell: { color: "orange", mascotExpression: "sending" },
  run: { color: "green", mascotExpression: "working" },
  build: { color: "blue", mascotExpression: "humming" },
  office: { color: "teal", mascotExpression: "thinking" },
};
const FALLBACK_EXPRESSION = "idle";

function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUT,
    source: DEFAULT_SOURCE,
    skillsDir: DEFAULT_SKILLS_DIR,
    force: false,
    dryRun: false,
  };
  const dirFlags = { "--out": "out", "--source": "source", "--skills-dir": "skillsDir" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (dirFlags[arg]) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a directory`);
      options[dirFlags[arg]] = value;
      index += 1;
    } else if (arg.includes("=") && dirFlags[arg.split("=")[0]]) {
      const [flag, ...rest] = arg.split("=");
      options[dirFlags[flag]] = rest.join("=");
    } else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of ["out", "source", "skillsDir"]) {
    options[field] = isAbsolute(options[field]) ? options[field] : resolve(process.cwd(), options[field]);
  }
  return options;
}

/** Collapse to one line. Package text fields are single-line by contract
 * (tagline, title, outcomes, triggers); only summary and instructions keep
 * their line breaks. */
export function singleLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** Cut to `max` characters on a word boundary, marking the cut with an
 * ellipsis so a truncated field never reads as the whole sentence. */
export function clamp(value, max) {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The first sentence, or "" when the text has no terminator. */
export function firstSentence(value) {
  const match = singleLine(value).match(/^[^.!?]+[.!?]/);
  return match ? match[0].trim() : "";
}

/** "research" → "Research". Used for the package category, which the app
 * shows as a label (see the fixture in server/bot-package.test.ts). */
export function titleCase(value) {
  return String(value ?? "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (/[A-Z]/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/** Wayland descriptions lead with the role, then an em- or hyphen-dash, then
 * the method: "Sales specialist - SPIN-disciplined discovery, …". The lead is
 * the natural title. Descriptions without a dash fall back to their first
 * sentence. */
export function titleFrom(description) {
  const text = singleLine(description);
  const dash = text.match(/^(.{3,200}?)\s+[-–—]\s+\S/);
  if (dash) return dash[1].trim();
  return clamp(firstSentence(text) || text, 200);
}

/** The persona file's lead: everything before its first `## ` section, minus
 * the `# Title` line and the `As of:` stamp some files carry. */
export function personaLead(markdown) {
  const head = String(markdown ?? "").split(/\r?\n(?=##\s)/)[0];
  return head
    .split(/\r?\n/)
    .filter((line) => !/^#\s/.test(line) && !/^\*?As of:/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Bullets under `## How you behave` / `## Voice and taste …`. Every persona
 * file has one of those sections; it is the only list source for the six
 * Quiet Money layer specialists, which ship no `prompts`. */
export function behaviourBullets(markdown) {
  const sections = String(markdown ?? "").split(/\r?\n(?=##\s)/);
  const section = sections.find((part) => /^##\s+(How you behave|Voice and taste)/i.test(part));
  if (!section) return [];
  return section
    .split(/\r?\n/)
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => singleLine(line.replace(/^[-*]\s+/, "")))
    .filter(Boolean);
}

/** The phrase after `## Core method — …`, when the file names one. It is the
 * best short statement of what the persona actually does, so it earns a spot
 * in the playbook triggers. */
export function coreMethodPhrase(markdown) {
  const match = String(markdown ?? "").match(/^##\s+Core method\s*[-–—:]\s*(.+)$/m);
  return match ? singleLine(match[1]).toLowerCase() : "";
}

/** What the bot delivers. `prompts` are the assistant's own advertised asks;
 * the six Quiet Money layer specialists ship none, so their behaviour bullets
 * stand in. Never empty — the schema requires at least one. */
export function outcomesFor(entry, markdown, tagline) {
  const prompts = (Array.isArray(entry?.prompts) ? entry.prompts : []).map(singleLine).filter(Boolean);
  const source = prompts.length ? prompts : behaviourBullets(markdown);
  const outcomes = source.slice(0, 12).map((item) => clamp(item, 240));
  return outcomes.length ? outcomes : [clamp(tagline, 240)];
}

/** When to reach for this playbook: the role's own names, its category, the
 * core-method phrase, and one phrase per kickoff (their ids are already
 * hyphenated topic labels, e.g. `script-for-switch-interview`). */
export function triggersFor(entry, markdown) {
  const terms = [];
  const seen = new Set();
  const push = (value) => {
    const term = clamp(singleLine(value).toLowerCase(), 100);
    if (!term || seen.has(term)) return;
    seen.add(term);
    terms.push(term);
  };
  push(entry?.name);
  push(entry?.id);
  push(entry?.category);
  push(coreMethodPhrase(markdown));
  for (const kickoff of Array.isArray(entry?.kickoffs) ? entry.kickoffs : []) {
    push(String(kickoff?.id ?? "").replace(/-/g, " "));
  }
  return terms.slice(0, 30);
}

/** Category colour and face, with a stable per-id fallback so an unrecognised
 * category still produces a legal, deterministic appearance. */
export function appearanceFor(entry) {
  const known = CATEGORY_APPEARANCE[String(entry?.category ?? "")];
  if (known) return { ...known };
  const id = String(entry?.id ?? "");
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) % 1_000_003;
  return { color: COLORS[hash % COLORS.length], mascotExpression: FALLBACK_EXPRESSION };
}

/** Build one complete package document. `markdown` is the persona file. */
export function buildPackage(entry, markdown) {
  const id = String(entry?.id ?? "");
  if (!PACKAGE_ID.test(id) || id.length > 80) throw new Error(`assistant id is not a package slug: ${JSON.stringify(id)}`);
  const name = singleLine(entry?.name) || titleCase(id);
  const description = singleLine(entry?.description);
  if (!description) throw new Error(`${id} has no description`);
  const persona = String(markdown ?? "").trim();
  if (!persona) throw new Error(`${id} has an empty persona file`);

  const tagline = clamp(description.length <= 160 ? description : firstSentence(description) || description, 160);
  const lead = personaLead(persona);
  const summary = clamp(lead ? `${description}\n\n${lead}` : description, 2_000);
  const skills = (Array.isArray(entry?.enabledSkills) ? entry.enabledSkills : [])
    .map((skill) => singleLine(skill))
    .filter((skill) => KEY.test(skill) && skill.length <= 64)
    .slice(0, 200);
  const playbookKey = clamp(`${id}-playbook`, 64);

  return {
    format: "murage.package",
    version: 1,
    package: {
      id,
      release: RELEASE,
      name: clamp(name, 100),
      tagline,
      summary,
      category: titleCase(entry?.category) || "Specialist",
      author: { name: AUTHOR },
      license: LICENSE,
      tags: ["wayland", "specialist", String(entry?.category ?? "").toLowerCase()].filter(Boolean),
      outcomes: outcomesFor(entry, persona, tagline),
      setupMinutes: SETUP_MINUTES,
      requirements: { apps: [], capabilities: [] },
      agents: [
        {
          key: id,
          name: clamp(name, 100),
          title: clamp(titleFrom(description), 200),
          description: clamp(summary, 4_000),
          appearance: appearanceFor(entry),
          playbooks: [playbookKey],
          ...(skills.length ? { skills } : {}),
        },
      ],
      chiefOfStaff: id,
      playbooks: [
        {
          key: playbookKey,
          name: clamp(`${name} playbook`, 100),
          summary: clamp(description, 300),
          triggers: triggersFor(entry, persona),
          // Verbatim. The persona file *is* the playbook; paraphrasing it here
          // would be the one place this import could quietly change behaviour.
          instructions: clamp(persona, 24_000),
        },
      ],
    },
  };
}

function prepareOutDir(directory, force, dryRun) {
  if (!existsSync(directory)) {
    if (!dryRun) mkdirSync(directory, { recursive: true });
    return;
  }
  const existing = readdirSync(directory);
  if (!existing.length) return;
  if (!existsSync(join(directory, MARKER)) && !force) {
    throw new Error(`${directory} is not empty and was not written by this script — pass --force to replace it`);
  }
  if (!dryRun) {
    safeWipeSync(directory, { within: repoRoot });
    mkdirSync(directory, { recursive: true });
  }
}

function readInstalledSkillIds(skillsDir) {
  if (!existsSync(skillsDir)) return null;
  return new Set(
    readdirSync(skillsDir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name),
  );
}

function main() {
  const { out, source, skillsDir, force, dryRun } = parseArgs(process.argv.slice(2));
  const assistantsPath = join(source, "contributes", "assistants.json");
  const catalogPath = join(source, "contributes", "skills.json");
  for (const path of [assistantsPath, catalogPath]) {
    if (!existsSync(path)) throw new Error(`missing source file: ${path}`);
  }

  const all = JSON.parse(readFileSync(assistantsPath, "utf8"));
  if (!Array.isArray(all)) throw new Error(`${assistantsPath} is not an array`);
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const catalogIds = new Set((Array.isArray(catalog) ? catalog : []).map((skill) => skill?.name).filter(Boolean));
  const installedIds = readInstalledSkillIds(skillsDir);

  const specialists = all.filter((entry) => entry?.kind === "specialist");
  const outDir = join(out, "assistants");
  prepareOutDir(outDir, force, dryRun);

  const written = [];
  const skipped = [];
  const unresolved = new Map();

  for (const entry of specialists) {
    const id = String(entry?.id ?? "");
    const contextFile = String(entry?.contextFile ?? "");
    const skip = (reason) => skipped.push({ id: id || "(no id)", reason });
    if (!contextFile || contextFile.startsWith("/") || contextFile.split("/").some((part) => !part || part === "..")) {
      skip(`contextFile ${JSON.stringify(entry?.contextFile ?? null)} is not a safe relative path`);
      continue;
    }
    const personaPath = join(source, contextFile);
    if (!existsSync(personaPath)) {
      skip(`persona file not found: ${personaPath}`);
      continue;
    }

    let document;
    try {
      document = buildPackage(entry, readFileSync(personaPath, "utf8"));
    } catch (error) {
      skip(error instanceof Error ? error.message : String(error));
      continue;
    }

    for (const skill of document.package.agents[0].skills ?? []) {
      const inLibrary = installedIds ? installedIds.has(skill) : false;
      const inCatalog = catalogIds.has(skill);
      if (inLibrary || inCatalog) continue;
      if (!unresolved.has(skill)) unresolved.set(skill, []);
      unresolved.get(skill).push(id);
    }

    if (!dryRun) writeFileSync(join(outDir, `${id}.json`), `${JSON.stringify(document, null, 2)}\n`);
    written.push({
      id,
      persona: contextFile,
      skills: (document.package.agents[0].skills ?? []).length,
      outcomes: document.package.outcomes.length,
    });
  }

  const report = {
    generatedBy: "scripts/import-wayland-assistants.mjs",
    generatedAt: new Date().toISOString(),
    source,
    skillsDir: installedIds ? skillsDir : `${skillsDir} (not present — skills checked against the Wayland catalog only)`,
    specialists: specialists.length,
    written: written.length,
    packages: written,
    skipped,
    unresolvedSkills: Object.fromEntries([...unresolved].map(([skill, ids]) => [skill, ids])),
  };
  if (!dryRun) writeFileSync(join(outDir, MARKER), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`source        ${source}`);
  console.log(`out           ${outDir}${dryRun ? " (dry run, nothing written)" : ""}`);
  console.log(`skills dir    ${skillsDir}${installedIds ? ` (${installedIds.size} installed)` : " (missing)"}`);
  console.log(`specialists   ${specialists.length}`);
  console.log(`written       ${written.length}`);
  console.log(`skipped       ${skipped.length}`);
  for (const item of skipped) console.log(`  skip ${item.id}: ${item.reason}`);
  console.log(`unresolved    ${unresolved.size} skill ids referenced but not installed and not in the Wayland catalog`);
  for (const [skill, ids] of unresolved) console.log(`  ${skill} <- ${ids.join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
