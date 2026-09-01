#!/usr/bin/env node
// Convert Wayland's 60 teams into Murage bot packages.
//
// Why packages and not team manifests: a v2 team manifest deliberately carries
// no room ("New imports intentionally do not create it", team-manifest.ts:112),
// and the manifest import path only creates a group in `project` mode. So a
// team imported from the library arrived as a pile of bots with nowhere to
// talk. A bot package carries rooms[] and routines[], and its import path
// creates the group, sets the bulletin and rolls the whole thing back on
// failure (server/index.ts:6403-6414).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

const WT = "/Volumes/Mando/wayland/app/resources/builtin-extensions/waylandteams";
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "/tmp/murage-teams-repo";

const COLORS = ["green","blue","red","orange","purple","pink","yellow","teal","coral","cyan","lime","amber","indigo","rose"];
const DAYS = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };

const assistants = JSON.parse(readFileSync(join(WT, "contributes/assistants.json"), "utf8"));
const specialists = new Map(assistants.filter((a) => a.kind === "specialist").map((a) => [a.id, a]));
const teams = assistants.filter((a) => a.kind === "team");

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const clamp = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
const colorFor = (i) => COLORS[i % COLORS.length];

function launcher(id) {
  const f = join(WT, "assistants/launchers", `${id}.md`);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

// weekly:monday:11:00 -> a daily routine restricted to that weekday.
// quarterly/annual cannot be expressed by RoutineSchedule (routines.ts:12-14),
// which is only { once } | { daily, time, weekdays[] }. Those are reported and
// dropped rather than silently rounded to something the user did not ask for.
function scheduleFrom(cadence) {
  const weekly = /^weekly:([a-z]+):(\d{2}:\d{2})$/.exec(cadence || "");
  if (weekly && weekly[1] in DAYS) return { type: "daily", time: weekly[2], weekdays: [DAYS[weekly[1]]] };
  const daily = /^daily:(\d{2}:\d{2})$/.exec(cadence || "");
  if (daily) return { type: "daily", time: daily[1], weekdays: [0,1,2,3,4,5,6] };
  return null;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "teams"), { recursive: true });

const catalog = [];
const skipped = [];
const droppedRituals = [];
const missingSkills = new Set();
// The installed skill library is the source of truth for what an agent may cite.
const LIB = "skills-library";
const libraryIds = new Set(existsSync(LIB) ? readdirSync(LIB).filter((d) => existsSync(join(LIB, d, "SKILL.md"))) : []);

for (const team of teams) {
  const members = (team.teammates ?? []).filter((k) => specialists.has(k));
  const missing = (team.teammates ?? []).filter((k) => !specialists.has(k));
  if (members.length === 0) { skipped.push({ id: team.id, missing }); continue; }

  // Display as "Name (Role)". Wayland puts the character in the ID (smith,
  // mira, beacon) and the ROLE in .name (Code, Brand, Channels), so using
  // .name alone gave a roster of generic labels. Where the id IS the role
  // word (research, copy, sales) the parenthetical would just repeat itself,
  // so those keep the plain name.
  const agents = members.map((k, i) => {
    const s = specialists.get(k);
    const character = k.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const sameWord = character.toLowerCase().replace(/\s+/g, "") === s.name.toLowerCase().replace(/\s+/g, "");
    const display = sameWord ? s.name : `${character} (${s.name})`;
    // Only cite skills that actually exist on disk — a dangling id fails at
    // install time, and 32 of Wayland's references exist in neither pack.
    const skills = (s.enabledSkills ?? []).filter((id) => libraryIds.has(id));
    for (const id of (s.enabledSkills ?? [])) if (!libraryIds.has(id)) missingSkills.add(id);
    return {
      key: k,
      name: clamp(display, 100),
      title: s.name,
      description: clamp(s.description, 4000) || undefined,
      appearance: { color: colorFor(i) },
      ...(skills.length ? { skills } : {}),
    };
  });

  const bulletin = clamp(launcher(team.id) || team.description || team.name, 12000);
  const pkg = {
    format: "murage.package",
    version: 1,
    package: {
      id: slug(team.id),
      release: "1.0.0",
      name: team.name,
      tagline: clamp(team.description || team.name, 160),
      summary: clamp(team.description || team.name, 2000),
      category: (team.category || "general").replace(/^./, (c) => c.toUpperCase()),
      author: { name: "Ferrox Labs", url: "https://murage.ai" },
      license: "Apache-2.0",
      ...(team.standing ? { featured: true } : {}),
      outcomes: [clamp(team.description || `Run ${team.name} as a crew.`, 240)],
      setupMinutes: 2,
      requirements: { apps: [], capabilities: [] },
      agents,
      // The room is the whole point: a team without a channel is a pile of bots.
      // `mentions` rather than `everyone` so a four-Ember room does not answer
      // four times per message and bill four turns for one question.
      rooms: [{
        key: "room",
        name: team.name,
        members: members,
        bulletin,
        defaultResponder: { kind: "mentions" },
      }],
    },
  };

  // Standing companies carry their ritual as a routine, disabled until the
  // user turns it on — enabledAfterInstall is literally false in the schema.
  const routines = [];
  for (const ritual of team.rituals ?? []) {
    const schedule = scheduleFrom(ritual.cadence);
    if (!schedule) { droppedRituals.push(`${team.id}: ${ritual.name} (${ritual.cadence})`); continue; }
    routines.push({
      key: slug(ritual.name).slice(0, 64),
      name: clamp(ritual.name.replace(/-/g, " "), 80),
      agent: members[0],
      prompt: clamp(`Run the ${ritual.name.replace(/-/g, " ")} for ${team.name}. ${bulletin}`, 20000),
      runOn: "ember",
      schedule,
      durationMinutes: 30,
      enabledAfterInstall: false,
    });
  }
  if (routines.length) pkg.package.routines = routines;

  const dir = join(OUT, "teams", pkg.package.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pkg.package.id}.emberteam.json`), JSON.stringify(pkg, null, 2) + "\n");
  const roles = agents.map((a) => `- **${a.name}** — ${a.description ?? ""}`).join("\n");
  writeFileSync(join(dir, "README.md"),
    `# ${team.name}\n\n${team.description ?? ""}\n\n## The crew\n\n${roles}\n\n` +
    `_${agents.length} Embers, one room._${routines.length ? ` ${routines.length} routine(s), off until you enable them.` : ""}\n`);

  catalog.push({
    slug: pkg.package.id,
    name: team.name,
    summary: clamp(team.description || team.name, 300),
    category: pkg.package.category,
    ...(team.standing ? { featured: true } : {}),
    manifest: `teams/${pkg.package.id}/${pkg.package.id}.emberteam.json`,
    readme: `teams/${pkg.package.id}/README.md`,
    members: agents.length,
    skills: [],
    requires: { apps: [] },
    setupMinutes: 2,
  });
}

writeFileSync(join(OUT, "catalog.json"), JSON.stringify({
  format: "murage.catalog", version: 1,
  repositoryUrl: "https://github.com/FerroxLabs/murage-teams",
  teams: catalog,
}, null, 2) + "\n");
writeFileSync(join(OUT, "README.md"),
  `# Murage Teams\n\nThe team library for [Murage](https://github.com/FerroxLabs/murage).\n\n` +
  `${catalog.length} teams. Each one imports as a crew of Embers **and the room they work in**.\n`);

console.log(`teams in source   ${teams.length}`);
console.log(`packages written  ${catalog.length}`);
console.log(`featured          ${catalog.filter((t) => t.featured).length}`);
console.log(`skipped           ${skipped.length}`);
for (const s of skipped) console.log(`  ${s.id}: no known members (${s.missing.join(", ")})`);
console.log(`skills in library ${libraryIds.size}`);
console.log(`skill refs dropped ${missingSkills.size} (exist in neither Wayland pack)`);
console.log(`rituals dropped   ${droppedRituals.length} (schedule not expressible)`);
for (const d of droppedRituals) console.log(`  ${d}`);
