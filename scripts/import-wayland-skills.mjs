// Convert the Wayland skill pack into Murage skill directories.
//
// The pack is an index plus one packed blob: `index.json` describes every
// skill, `skill-bodies.offsets.json` maps each skill's path to a
// [byteStart, byteLength] pair, and `skill-bodies.bin` holds the bodies back
// to back. This writes one directory per skill —
//
//   <out>/<id>/manifest.json   generated from the index entry
//   <out>/<id>/SKILL.md        the body, byte for byte
//
// — shaped so `parseSkillManifest` (server/skill-library.ts:32) accepts it.
// The source pack is never modified.
//
// Usage:
//   node scripts/import-wayland-skills.mjs [--out <dir>] [--source <dir>]
//                                          [--force] [--dry-run]
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SOURCE = "/Volumes/Mando/wayland/app/.skill-pack/skills-library";
const DEFAULT_OUT = join(repoRoot, "skills-library");
// Written into the output directory so a re-run knows the tree is ours to
// replace. It is not a skill directory, so the loader skips it.
const MARKER = ".wayland-import.json";

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_VERSION = /^\d+\.\d+\.\d+$/;
const FALLBACK_VERSION = "1.0.0";

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, source: DEFAULT_SOURCE, force: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--out" || arg === "--source") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a directory`);
      options[arg === "--out" ? "out" : "source"] = value;
      index += 1;
    } else if (arg.startsWith("--out=") || arg.startsWith("--source=")) {
      const [flag, ...rest] = arg.split("=");
      options[flag === "--out" ? "out" : "source"] = rest.join("=");
    } else throw new Error(`unknown argument: ${arg}`);
  }
  options.out = isAbsolute(options.out) ? options.out : resolve(process.cwd(), options.out);
  options.source = isAbsolute(options.source) ? options.source : resolve(process.cwd(), options.source);
  return options;
}

/** Slugify to the exact shape `SAFE_ID` accepts, or "" when nothing survives. */
export function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Manifest descriptions are single line: the parser keeps the raw string and
 * it ends up in a prompt, so newlines and runs of spaces are collapsed. */
export function singleLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** The pack writes most descriptions as a YAML block scalar:
 *
 *     description: |
 *       Designs an A/B test from scratch...
 *
 * The body used to be copied out byte for byte, so every emitted SKILL.md kept
 * that shape and only manifest.json got `singleLine`. server/skills.ts reads
 * block scalars now, but a catalog whose frontmatter is one safely-quoted line
 * is readable by every other consumer too — and by anyone diffing the tree.
 * Only the description line changes; the rest of the file is untouched, and a
 * second pass finds no block header, so re-runs are stable. */
export function normalizeFrontmatterDescription(body) {
  // Unanchored to the file start would let a markdown `---` rule masquerade as
  // frontmatter, so a body that does not open with one is left alone.
  const match = body.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!match) return body;
  const eol = match[1].endsWith("\r\n") ? "\r\n" : "\n";
  const lines = match[2].split(/\r?\n/);
  const start = lines.findIndex((line) => /^description:[ \t]*[|>][-+]?\d*[-+]?[ \t]*$/.test(line));
  if (start < 0) return body;
  // The block runs to the next line that starts in column 0.
  let end = start + 1;
  while (end < lines.length && !(lines[end].trim() && !/^[ \t]/.test(lines[end]))) end += 1;
  const text = singleLine(lines.slice(start + 1, end).join(" "));
  if (!text) return body;
  // JSON string syntax is a valid YAML double-quoted scalar.
  const frontmatter = [...lines.slice(0, start), `description: ${JSON.stringify(text)}`, ...lines.slice(end)];
  return (
    body.slice(0, match.index) +
    match[1] +
    frontmatter.join(eol) +
    match[3] +
    body.slice(match.index + match[0].length)
  );
}

/** "executive-communicator" reads as a slug in a picker, so title-case it.
 * Words that already carry capitals are left alone. */
export function humanName(name) {
  const words = String(name ?? "").split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return "";
  return words.map((word) => (/[A-Z]/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1))).join(" ");
}

/** Tags plus the category, deduplicated, order preserved. Falls back to the id
 * so the array is never empty — the parser rejects a skill with no terms. */
export function triggerTermsFor(entry, id) {
  const terms = [];
  const seen = new Set();
  const push = (value) => {
    const term = singleLine(value).toLowerCase();
    if (!term || seen.has(term)) return;
    seen.add(term);
    terms.push(term);
  };
  for (const tag of Array.isArray(entry.tags) ? entry.tags : []) push(tag);
  push(entry.category);
  if (!terms.length) push(id);
  return terms;
}

export function versionFor(entry) {
  const version = entry?.metadata?.version;
  return typeof version === "string" && SAFE_VERSION.test(version) ? version : FALLBACK_VERSION;
}

/** Two categories can hold the same skill name (`code-reviewer` lives under
 * both agents/engineering and skills/software-engineering). The first one
 * sorted by path keeps the bare slug; later ones take a category suffix, then
 * a numeric one if even that is taken. */
export function claimId(slug, entry, taken) {
  if (!taken.has(slug)) return { id: slug, collided: false };
  const category = slugify(entry.category);
  const suffixed = category ? `${slug}-${category}` : "";
  if (suffixed && SAFE_ID.test(suffixed) && !taken.has(suffixed)) return { id: suffixed, collided: true };
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return { id: candidate, collided: true };
  }
  return { id: "", collided: true };
}

export function buildManifest(entry, id) {
  return {
    id,
    name: humanName(entry.name) || id,
    version: versionFor(entry),
    description: singleLine(entry.description),
    // Always false. The bundled loader injects every enabled skill whose
    // trigger words hit, so 2k enabled skills would flood each turn; this
    // library is a catalog bots install from (docs/plans/wayland-library-port.md).
    defaultEnabled: false,
    triggerTerms: triggerTermsFor(entry, id),
    // Deliberately empty: selection needs every named capability to be present
    // (server/skill-library.ts:127), so an invented name hides the skill.
    requiredCapabilities: [],
  };
}

function prepareOutDir(out, force, dryRun) {
  if (!existsSync(out)) {
    if (!dryRun) mkdirSync(out, { recursive: true });
    return;
  }
  const existing = readdirSync(out);
  if (!existing.length) return;
  if (!existsSync(join(out, MARKER)) && !force) {
    throw new Error(`${out} is not empty and was not written by this script — pass --force to replace it`);
  }
  // A previous run's marker is not a licence to delete what a later hand
  // added: the tree is replaced wholesale, so a directory count above what the
  // marker recorded means someone else's skills are in here too.
  if (!force && existsSync(join(out, MARKER))) {
    const recorded = JSON.parse(readFileSync(join(out, MARKER), "utf8"))?.written;
    const directories = existing.filter((name) => !name.startsWith(".")).length;
    if (Number.isInteger(recorded) && directories > recorded) {
      throw new Error(
        `${out} holds ${directories} skill directories, ${directories - recorded} more than the last ` +
          `import wrote (${recorded}). Move the additions aside or pass --force to delete them.`,
      );
    }
  }
  if (!dryRun) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
  }
}

function main() {
  const { out, source, force, dryRun } = parseArgs(process.argv.slice(2));
  const indexPath = join(source, "index.json");
  const offsetsPath = join(source, "skill-bodies.offsets.json");
  const bodiesPath = join(source, "skill-bodies.bin");
  for (const path of [indexPath, offsetsPath, bodiesPath]) {
    if (!existsSync(path)) throw new Error(`missing pack file: ${path}`);
  }

  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  if (!Array.isArray(index)) throw new Error(`${indexPath} is not an array`);
  const offsets = JSON.parse(readFileSync(offsetsPath, "utf8"))?.entries;
  if (!offsets || typeof offsets !== "object") throw new Error(`${offsetsPath} has no entries map`);
  const bodies = readFileSync(bodiesPath);

  // Sorted by pack path so ids — and therefore which duplicate keeps the bare
  // slug — are the same on every run.
  const entries = [...index].sort((a, b) => String(a.path).localeCompare(String(b.path)));

  prepareOutDir(out, force, dryRun);

  const taken = new Set();
  const bySlug = new Map();
  const collisions = [];
  const skipped = [];
  let written = 0;

  for (const entry of entries) {
    const path = String(entry?.path ?? "");
    const skip = (reason) => skipped.push({ path: path || "(no path)", name: entry?.name ?? "", reason });

    const slug = slugify(entry?.name);
    if (!SAFE_ID.test(slug)) {
      skip(`name ${JSON.stringify(entry?.name ?? null)} does not slugify to a valid id`);
      continue;
    }
    const description = singleLine(entry?.description);
    if (!description) {
      skip("empty description");
      continue;
    }
    const span = offsets[path];
    if (!Array.isArray(span) || span.length < 2 || !Number.isInteger(span[0]) || !Number.isInteger(span[1])) {
      skip("no byte range in skill-bodies.offsets.json");
      continue;
    }
    const [start, length] = span;
    if (start < 0 || length <= 0 || start + length > bodies.length) {
      skip(`byte range [${start}, ${length}] is outside skill-bodies.bin (${bodies.length} bytes)`);
      continue;
    }
    const body = bodies.subarray(start, start + length).toString("utf8");
    // Same check the loader makes on the file it reads (skill-library.ts:61-62).
    if (!body.trim().startsWith("---")) {
      skip("body has no `---` frontmatter");
      continue;
    }

    const { id, collided } = claimId(slug, entry, taken);
    if (!id) {
      skip(`could not find a free id for slug ${slug}`);
      continue;
    }
    if (collided) collisions.push({ slug, id, path, keptBy: bySlug.get(slug) ?? "" });
    taken.add(id);
    if (!bySlug.has(slug)) bySlug.set(slug, path);

    if (!dryRun) {
      const directory = join(out, id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(buildManifest(entry, id), null, 2)}\n`);
      // The body is the skill; only the frontmatter description is reshaped
      // into one quoted line (see normalizeFrontmatterDescription).
      writeFileSync(join(directory, "SKILL.md"), normalizeFrontmatterDescription(body));
    }
    written += 1;
  }

  const report = {
    generatedBy: "scripts/import-wayland-skills.mjs",
    generatedAt: new Date().toISOString(),
    source,
    indexed: index.length,
    written,
    collisions,
    skipped,
  };
  if (!dryRun) writeFileSync(join(out, MARKER), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`source     ${source}`);
  console.log(`out        ${out}${dryRun ? " (dry run, nothing written)" : ""}`);
  console.log(`indexed    ${index.length}`);
  console.log(`written    ${written}`);
  console.log(`skipped    ${skipped.length}`);
  for (const item of skipped) console.log(`  skip ${item.path}: ${item.reason}`);
  console.log(`collisions ${collisions.length}`);
  for (const item of collisions) console.log(`  ${item.slug} taken by ${item.keptBy} -> ${item.path} became ${item.id}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
