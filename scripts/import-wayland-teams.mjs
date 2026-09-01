// Convert Wayland's 60 teams into Murage team manifests.
//
// Wayland keeps assistants and teams in one array: every entry in
// `contributes/assistants.json` carries a `kind` of "specialist" (28 of them)
// or "team" (60). A team is a roster — `teammates` is a list of specialist ids
// — plus a launcher prompt in `assistants/launchers/<id>.md`. This writes one
// file per team —
//
//   <out>/teams/<id>.json
//
// — shaped so `parseTeamManifest` (server/team-manifest.ts:137) accepts it.
// The source extension is never modified.
//
// Two things the manifest schema has no room for are kept as sibling keys.
// `parseTeamManifest` builds its result field by field from a Zod object, so
// unknown top-level keys are dropped on read rather than rejected — they ride
// along in the file for the later import step and never reach a bot record:
//
//   schedule   the 7 standing companies' rituals, each pre-resolved to a
//              Murage RoutineSchedule (server/routines.ts:12-14) where one
//              exists, so a routine can be created from it later.
//   wayland    provenance: the source id, category, the launcher prompt
//              verbatim, and any teammate id that did not resolve.
//
// Usage:
//   node scripts/import-wayland-teams.mjs [--out <dir>] [--source <dir>]
//                                         [--force] [--dry-run] [--no-verify]
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SOURCE = "/Volumes/Mando/wayland/app/resources/builtin-extensions/waylandteams";
const DEFAULT_OUT = join(repoRoot, "teams-library");
const TEAM_MANIFEST_PATH = join(repoRoot, "server", "team-manifest.ts");
// Written into the output directory so a re-run knows the tree is ours to
// replace.
const MARKER = ".wayland-import.json";

// Mirrors COLORS in server/team-manifest.ts:14-25 — the enum the member
// appearance is validated against.
const COLORS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];

// server/team-manifest.ts:39-51.
const MEMBER_KEY = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_MEMBER_KEY = 64;
const MAX_MEMBER_NAME = 100;
const MAX_MEMBER_TITLE = 200;
const MAX_MEMBER_DESCRIPTION = 4_000;
const MAX_TEAM_NAME = 100;
const MAX_TEAM_DESCRIPTION = 2_000;

// Date#getDay() ordering, which is what nextOccurrence compares against
// (server/routines.ts:288-293).
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, source: DEFAULT_SOURCE, force: false, dryRun: false, verify: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-verify") options.verify = false;
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

/** Collapse to one line: these strings end up in a picker and in a prompt. */
export function singleLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function clamp(value, max) {
  const text = singleLine(value);
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Wayland writes a specialist's description as "<role label> - <what it does>"
 * for 27 of the 28. The label is the title Murage wants; the remainder is the
 * description. When the pattern is absent the whole string stays the
 * description and the title is left empty — `parseTeamManifest` already
 * defaults a missing title to "" (server/team-manifest.ts:154), so an invented
 * label would be worse than none. */
export function splitRole(description) {
  const text = singleLine(description);
  const at = text.indexOf(" - ");
  if (at <= 0) return { title: "", description: text };
  const title = text.slice(0, at).trim();
  const rest = text.slice(at + 3).trim();
  // A leading clause that is itself a sentence, or long enough to be prose,
  // is not a role label.
  if (!rest || title.length > 60 || /[.!?]/.test(title)) return { title: "", description: text };
  return {
    title: clamp(title, MAX_MEMBER_TITLE),
    description: clamp(rest.charAt(0).toUpperCase() + rest.slice(1), MAX_MEMBER_DESCRIPTION),
  };
}

/** Wayland has no colour on a specialist, and Murage requires one. FNV-1a over
 * the specialist id gives a stable, run-independent starting point; `taken`
 * then walks forward through the palette so no two members of one team share a
 * colour. Importing a team creates a fresh bot per member
 * (server/team-manifest.ts:226-260), so distinctness inside the roster is worth
 * more than the same specialist keeping one colour across all 59 teams. Teams
 * top out at 8 members, so the 10-colour palette never runs out. */
export function colorFor(id, taken = new Set()) {
  let hash = 0x811c9dc5;
  const text = String(id ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const start = hash % COLORS.length;
  for (let step = 0; step < COLORS.length; step += 1) {
    const color = COLORS[(start + step) % COLORS.length];
    if (!taken.has(color)) {
      taken.add(color);
      return color;
    }
  }
  return COLORS[start];
}

/** Wayland ritual cadences are `weekly:<day>:<HH:MM>`, `daily:<HH:MM>`,
 * `quarterly:<HH:MM>` and `annual:<month>:<day>:<HH:MM>`. Murage routines only
 * model `once` and `daily`-with-weekdays (server/routines.ts:12-14), so weekly
 * and daily resolve and the rest return null with the reason attached rather
 * than being bent into something that would fire on the wrong days. */
export function routineFor(cadence) {
  const parts = String(cadence ?? "").split(":");
  const time = (hour, minute) =>
    /^([01]\d|2[0-3])$/.test(hour) && /^[0-5]\d$/.test(minute) ? `${hour}:${minute}` : "";
  if (parts[0] === "weekly" && parts.length === 4) {
    const day = WEEKDAYS.indexOf(String(parts[1]).toLowerCase());
    const at = time(parts[2], parts[3]);
    if (day >= 0 && at) return { routine: { type: "daily", time: at, weekdays: [day] } };
    return { routine: null, unsupported: `cadence "${cadence}" is not a weekly:<day>:<HH:MM> value` };
  }
  if (parts[0] === "daily" && parts.length === 3) {
    const at = time(parts[1], parts[2]);
    if (at) return { routine: { type: "daily", time: at, weekdays: [0, 1, 2, 3, 4, 5, 6] } };
    return { routine: null, unsupported: `cadence "${cadence}" is not a daily:<HH:MM> value` };
  }
  return {
    routine: null,
    unsupported: `"${parts[0] || cadence}" has no RoutineSchedule equivalent — Murage models only once and daily-with-weekdays (server/routines.ts:12-14)`,
  };
}

/** The rituals block for a standing company, or undefined for an ad-hoc team. */
export function scheduleFor(team) {
  if (!team?.standing) return undefined;
  const rituals = (Array.isArray(team.rituals) ? team.rituals : []).map((ritual) => {
    const { routine, unsupported } = routineFor(ritual?.cadence);
    return {
      name: singleLine(ritual?.name),
      cadence: singleLine(ritual?.cadence),
      routine,
      ...(unsupported ? { unsupported } : {}),
    };
  });
  return { standing: true, rituals };
}

export function buildMember(specialist, takenColors = new Set()) {
  const { title, description } = splitRole(specialist.description);
  return {
    key: specialist.id,
    name: clamp(specialist.name, MAX_MEMBER_NAME) || specialist.id,
    title,
    description,
    appearance: { color: colorFor(specialist.id, takenColors) },
  };
}

/** One team file. `specialists` maps a Wayland assistant id to its entry;
 * teammate ids missing from it are collected, never invented. */
export function buildTeamFile(team, specialists, launcher) {
  const members = [];
  const unresolved = [];
  const takenColors = new Set();
  for (const teammate of Array.isArray(team.teammates) ? team.teammates : []) {
    const specialist = specialists.get(teammate);
    if (!specialist) {
      unresolved.push(teammate);
      continue;
    }
    if (!MEMBER_KEY.test(teammate) || teammate.length > MAX_MEMBER_KEY) {
      unresolved.push(teammate);
      continue;
    }
    if (members.some((member) => member.key === teammate)) continue;
    members.push(buildMember(specialist, takenColors));
  }

  const schedule = scheduleFor(team);
  const file = {
    format: "murage.team",
    version: 2,
    team: {
      name: clamp(team.name, MAX_TEAM_NAME) || team.id,
      description: clamp(team.description, MAX_TEAM_DESCRIPTION),
      members,
    },
    ...(schedule ? { schedule } : {}),
    wayland: {
      id: team.id,
      category: singleLine(team.category),
      standing: Boolean(team.standing),
      launcherFile: singleLine(team.contextFile),
      // The team-leader prompt, verbatim. It is Wayland-flavoured (it names
      // WAYLAND_CRON_FIRE and team_spawn_agent) and needs a rebrand pass
      // before it becomes a Murage playbook, so it is carried rather than
      // rewritten here.
      launcher,
      ...(unresolved.length ? { unresolvedTeammates: unresolved } : {}),
    },
  };
  if (!file.team.description) delete file.team.description;
  return { file, unresolved };
}

function prepareOutDir(out, force, dryRun) {
  if (!existsSync(out)) {
    if (!dryRun) mkdirSync(join(out, "teams"), { recursive: true });
    return;
  }
  const existing = readdirSync(out);
  if (existing.length && !existsSync(join(out, MARKER)) && !force) {
    throw new Error(`${out} is not empty and was not written by this script — pass --force to replace it`);
  }
  if (!dryRun) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, "teams"), { recursive: true });
  }
}

/** Round-trip every result through the real parser, not a copy of its rules. */
async function verify(built, out, dryRun) {
  const { parseTeamManifest } = await import(pathToFileURL(TEAM_MANIFEST_PATH).href);
  const failures = [];
  let passed = 0;
  for (const { id, file } of built) {
    const path = join(out, "teams", `${id}.json`);
    try {
      const value = dryRun ? file : JSON.parse(readFileSync(path, "utf8"));
      const parsed = parseTeamManifest(value);
      if (parsed.team.members.length !== file.team.members.length) {
        throw new Error(`parsed ${parsed.team.members.length} members, built ${file.team.members.length}`);
      }
      passed += 1;
    } catch (error) {
      failures.push({ id, path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { passed, failures };
}

async function main() {
  const { out, source, force, dryRun, verify: shouldVerify } = parseArgs(process.argv.slice(2));
  const assistantsPath = join(source, "contributes", "assistants.json");
  if (!existsSync(assistantsPath)) throw new Error(`missing source file: ${assistantsPath}`);

  const assistants = JSON.parse(readFileSync(assistantsPath, "utf8"));
  if (!Array.isArray(assistants)) throw new Error(`${assistantsPath} is not an array`);

  const specialists = new Map();
  for (const entry of assistants) {
    if (entry?.kind === "specialist" && typeof entry.id === "string") specialists.set(entry.id, entry);
  }
  // Sorted by id so the output is byte-identical on every run.
  const teams = assistants
    .filter((entry) => entry?.kind === "team" && typeof entry.id === "string")
    .sort((a, b) => a.id.localeCompare(b.id));

  prepareOutDir(out, force, dryRun);

  const built = [];
  const skipped = [];
  const missingTeammates = new Map();
  const missingLaunchers = [];
  const standing = [];

  for (const team of teams) {
    const launcherPath = join(source, team.contextFile || join("assistants", "launchers", `${team.id}.md`));
    let launcher = "";
    if (existsSync(launcherPath)) launcher = readFileSync(launcherPath, "utf8");
    else missingLaunchers.push({ id: team.id, path: launcherPath });

    const { file, unresolved } = buildTeamFile(team, specialists, launcher);
    for (const teammate of unresolved) {
      if (!missingTeammates.has(teammate)) missingTeammates.set(teammate, []);
      missingTeammates.get(teammate).push(team.id);
    }
    // server/team-manifest.ts:53-55 — a team needs at least one member, and
    // nothing here may invent one.
    if (!file.team.members.length) {
      skipped.push({
        id: team.id,
        reason: `no teammate resolved to one of the ${specialists.size} specialists (${unresolved.join(", ")})`,
      });
      continue;
    }
    if (file.schedule) standing.push({ id: team.id, rituals: file.schedule.rituals });
    built.push({ id: team.id, file });
  }

  if (!dryRun) {
    for (const { id, file } of built) {
      writeFileSync(join(out, "teams", `${id}.json`), `${JSON.stringify(file, null, 2)}\n`);
    }
  }

  const verification = shouldVerify ? await verify(built, out, dryRun) : { passed: 0, failures: [] };

  const report = {
    generatedBy: "scripts/import-wayland-teams.mjs",
    generatedAt: new Date().toISOString(),
    source,
    specialists: specialists.size,
    teams: teams.length,
    written: built.length,
    standing: { inSource: teams.filter((team) => team?.standing).length, written: standing.length },
    skipped,
    missingTeammates: [...missingTeammates].map(([id, usedBy]) => ({ id, usedBy })),
    missingLaunchers,
    verification: shouldVerify
      ? { parser: "server/team-manifest.ts", passed: verification.passed, failed: verification.failures.length, failures: verification.failures }
      : { parser: "server/team-manifest.ts", skipped: true },
  };
  if (!dryRun) writeFileSync(join(out, MARKER), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`source           ${source}`);
  console.log(`out              ${out}${dryRun ? " (dry run, nothing written)" : ""}`);
  console.log(`specialists      ${specialists.size}`);
  console.log(`teams            ${teams.length}`);
  console.log(`written          ${built.length}`);
  console.log(`standing         ${standing.length} written of ${teams.filter((team) => team?.standing).length} in source`);
  for (const item of standing) {
    for (const ritual of item.rituals) {
      const shape = ritual.routine ? JSON.stringify(ritual.routine) : `no routine — ${ritual.unsupported}`;
      console.log(`  ${item.id} ${ritual.name} (${ritual.cadence}) -> ${shape}`);
    }
  }
  console.log(`skipped          ${skipped.length}`);
  for (const item of skipped) console.log(`  skip ${item.id}: ${item.reason}`);
  console.log(`missing teammates ${missingTeammates.size}`);
  for (const [id, usedBy] of missingTeammates) console.log(`  ${id} referenced by ${usedBy.join(", ")}`);
  console.log(`missing launchers ${missingLaunchers.length}`);
  for (const item of missingLaunchers) console.log(`  ${item.id}: ${item.path}`);
  if (shouldVerify) {
    console.log(`parseTeamManifest pass ${verification.passed} / fail ${verification.failures.length}`);
    for (const failure of verification.failures) console.log(`  FAIL ${failure.id}: ${failure.reason}`);
    if (verification.failures.length) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
