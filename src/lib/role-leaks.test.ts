// The org chart is three fields that only mean something read together, and
// every defect it has produced has the same shape: somewhere read one of them
// alone.
//
//   `chiefOfStaff`  true for the Chief of Staff AND for every team leader
//   `chiefScope`    "workspace" on the Chief alone — the thing that separates them
//   `individual`    leads nothing, reports straight to the Chief
//
// Reading `chiefOfStaff` by itself and calling the answer "Chief of Staff" is
// wrong for a team leader every time. It has shipped four times now: a team
// leader wearing the Chief's accent row; a right-click menu offering "Remove
// Chief of Staff" on a team leader; an archive tooltip telling a leader to
// choose another Chief of Staff; and, worst, electing a leader firing the
// Chief because the demotion loop matched on the raw flag.
//
// `botRole()` is the one function allowed to turn those three fields into a
// role. This test is the sweep: any USER-VISIBLE decision — a label, a colour,
// an icon, a tooltip — made from the raw field in a component is a leak, and
// every exception has to be written down with a reason.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that may read the raw field, and why each one is not a leak. */
const ALLOWED: Record<string, string> = {
  "state/store.tsx": "the client's copy of the record — it owns the fields",
  "state/bot-patch-queue.ts": "names the field as a PATCH key, does not render it",
  "lib/bot-role.ts": "defines the mapping every other reader must use",
  "lib/sidebar-layout.ts": "reads BOTH flag and scope together to place the one top row",
  "lib/team-map.ts": "reads BOTH flag and scope together to build the chart",
  "lib/group-routing.ts": "picks a default recipient — any leader will do, no role is shown",
  "lib/team-import.ts": "the package wire format, where chiefOfStaff is a member KEY, not a boolean",
  "components/SettingsPanel.tsx": "a PATCH key in a type union, not a rendered value",
  "components/TeamLibraryPanel.tsx": "package preview: chiefOfStaff is the lead's NAME, a string",
  "components/Sidebar.tsx":
    "the archive/restore round-trip sends the flag back over the wire verbatim; every " +
    "rendered role in this file goes through botRole()",
};

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

describe("the org chart has one reader", () => {
  it("keeps raw role fields out of everything but the allowlist", () => {
    const offenders: string[] = [];
    for (const file of sources(join(root, "components")).concat(sources(join(root, "lib")), sources(join(root, "state")))) {
      // Comments are stripped: this file's own prose names the field.
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      if (!/\bchiefOfStaff\b|\bchiefScope\b/.test(source)) continue;
      const name = relative(root, file).replace(/\\/g, "/");
      if (!(name in ALLOWED)) offenders.push(name);
    }
    expect(offenders, "these read the org chart's raw fields with no recorded reason").toEqual([]);
  });

  it("does not let the allowlist rot into files that no longer exist", () => {
    for (const name of Object.keys(ALLOWED)) {
      expect(`${name} exists`).toBe(
        statSync(join(root, name), { throwIfNoEntry: false }) ? `${name} exists` : `${name} missing`,
      );
    }
  });

  it("names a team leader a team leader, everywhere the sidebar says a role", () => {
    // The three defects reported against this file, pinned as text so they
    // cannot come back by someone re-reading the raw flag for convenience.
    const sidebar = readFileSync(join(root, "components/Sidebar.tsx"), "utf8").replace(/\r\n/g, "\n");

    // The accent row belongs to the Chief alone.
    expect(sidebar).toContain('botRole(bot) === "chief"\n      ? selected');
    // The menu is named for the role held, not for the field.
    expect(sidebar).toContain("`Remove ${BOT_ROLE_TITLE[role]}`");
    expect(sidebar).toContain('"Make Team leader"');
    // And it sends a whole role, not one flag of three.
    expect(sidebar).toContain('botRolePatch("member")');
    expect(sidebar).toContain('botRolePatch("leader")');
    // A leader's blocked-archive reason names the leader's team.
    expect(sidebar).toContain("Choose another lead for ${bot.section?.trim() || \"this team\"} first");
  });

  it("puts the teams a person arranged above the chats bots opened themselves", () => {
    // A bot-to-bot DM is created automatically whenever one bot messages
    // another. One Chief of Staff talking to four teammates put 340px of
    // machine-generated rows above the entire org chart and pushed a whole
    // team below the fold — which read as the team having been disconnected.
    // The members were rendered the whole time, just out of view.
    const sidebar = readFileSync(join(root, "components/Sidebar.tsx"), "utf8").replace(/\r\n/g, "\n");
    const natural = sidebar.slice(
      sidebar.indexOf("const naturalSectionIds = ["),
      sidebar.indexOf("];", sidebar.indexOf("const naturalSectionIds = [")),
    );
    expect(natural.indexOf("sectionNames.map(userSectionId)")).toBeLessThan(
      natural.indexOf("BOT_CHATS_SECTION_ID"),
    );
  });
});
