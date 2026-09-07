// End-to-end proof for the Wayland library port (docs/plans/wayland-library-port.md).
//
// Every other skill test builds its own synthetic library and proves the
// mechanism. This one runs the real generated artifacts through the real
// code path — the on-disk catalog in skills-library/, the assistant packages
// in library/assistants/, the vendored team packages in library/packages/ — so a
// generator that writes something the installer will not accept fails here
// rather than in a customer's workspace.
//
// The idiom is skills.test.ts's: a fresh random botId per test, workspaces
// under the throwaway HOME that server/testing/setup.ts installs, and
// assertions read back through the same exported functions the app calls.
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBotPackage } from "./bot-package.ts";
import { installSkillFromLibrary, listSkills, setSkillEnabled, skillsSystemPrompt } from "./skills.ts";
import { workspaceDir } from "./workspace.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SKILL_LIBRARY = join(REPO, "skills-library");
const ASSISTANT_LIBRARY = join(REPO, "library", "assistants");
const BUILTIN_LIBRARY = join(REPO, "bot-library", "builtins");
// teams-library/teams was an untracked generator intermediate. Customers
// receive the richer committed package documents, so a clean checkout must
// validate those exact bytes rather than require the generator author's tree.
const TEAM_LIBRARY = join(REPO, "library", "packages");

/** The three native discovery directories syncSkillLinks publishes into. */
const NATIVE_SKILL_DIRS = [".claude/skills", ".agents/skills", ".grok/skills"];

/** Three real catalog entries, named rather than discovered, so a regenerated
 * library that drops one is a loud failure instead of a silent substitution.
 * All three are declared by library/assistants/smith.json's agent. */
const SKILLS = ["ai-agent-builder", "feature-spec", "monorepo-architect"];

let bot: string;

beforeEach(() => {
  bot = `wayland-lib-${Math.random().toString(36).slice(2, 10)}`;
});

describe("the generated Wayland library installs through the real per-bot skill path", () => {
  it("installs three catalog skills disabled, then publishes native links that resolve to the catalog's SKILL.md", () => {
    // 1 + 2 — a temp bot (its workspace is created on first write) and three
    // installs straight out of the generated catalog.
    for (const id of SKILLS) {
      const installed = installSkillFromLibrary(bot, id, SKILL_LIBRARY);
      expect(installed, `installing ${id}: ${JSON.stringify(installed)}`).not.toHaveProperty("error");
      expect(installed).toMatchObject({ name: id, enabled: false, editable: false });
      // provenance names the catalog entry and its manifest version
      const manifest = JSON.parse(readFileSync(join(SKILL_LIBRARY, id, "manifest.json"), "utf8"));
      expect(installed).toMatchObject({ source: `library:${id}@${manifest.version}` });
    }
    expect(listSkills(bot).map((s) => s.name)).toEqual([...SKILLS].sort());
    // nothing an install carries reaches the prompt before a person enables it
    expect(skillsSystemPrompt(bot)).toBe("");

    // 3 — enable each one.
    for (const id of SKILLS) {
      expect(setSkillEnabled(bot, id, true), `enabling ${id}`).toMatchObject({ name: id, enabled: true });
    }

    // 4 — syncSkillLinks (called by setSkillEnabled) published a symlink into
    // each native dir, and each link resolves to THIS skill's reviewed bytes.
    const root = workspaceDir(bot);
    for (const dir of NATIVE_SKILL_DIRS) {
      for (const id of SKILLS) {
        const link = join(root, dir, id);
        expect(existsSync(link), `${dir}/${id} link should exist`).toBe(true);
        expect(lstatSync(link).isSymbolicLink(), `${dir}/${id} must be a symlink, not a copy`).toBe(true);
        const linked = readFileSync(join(link, "SKILL.md"), "utf8");
        expect(linked, `${dir}/${id} must resolve to the catalog's SKILL.md`).toBe(
          readFileSync(join(SKILL_LIBRARY, id, "SKILL.md"), "utf8"),
        );
        // and to this bot's own store, not to the repo checkout
        expect(realpathSync(link).startsWith(realpathSync(root))).toBe(true);
      }
      // the link set is exactly the enabled set — no stragglers
      expect(readdirSync(join(root, dir)).sort()).toEqual([...SKILLS].sort());
    }

    // supporting files stay outside the review boundary: the catalog's
    // manifest.json is never published into the engine's discovery path
    expect(existsSync(join(root, ".claude/skills", SKILLS[0]!, "manifest.json"))).toBe(false);

    // disabling one revokes its links everywhere, leaving the other two
    expect(setSkillEnabled(bot, SKILLS[0]!, false)).toMatchObject({ enabled: false });
    for (const dir of NATIVE_SKILL_DIRS) {
      expect(existsSync(join(root, dir, SKILLS[0]!))).toBe(false);
      expect(existsSync(join(root, dir, SKILLS[1]!))).toBe(true);
    }
  });

  it("carries each catalog skill's real description into the prompt index", () => {
    // The index line IS the selection surface: name + description is all the
    // model sees before deciding to read a SKILL.md. A description that does
    // not survive the generator's frontmatter is a skill the bot cannot pick.
    const id = SKILLS[0]!;
    expect(installSkillFromLibrary(bot, id, SKILL_LIBRARY)).not.toHaveProperty("error");
    setSkillEnabled(bot, id, true);

    const catalogDescription: string = JSON.parse(
      readFileSync(join(SKILL_LIBRARY, id, "manifest.json"), "utf8"),
    ).description;
    const firstSentence = catalogDescription.split(". ")[0]!;

    const listed = listSkills(bot).find((s) => s.name === id)!;
    expect(listed.description).toContain(firstSentence.slice(0, 60));
    expect(skillsSystemPrompt(bot)).toContain(firstSentence.slice(0, 60));
  });
});

describe("a shipped Wayland team package resolves to generated assistant packages", () => {
  it("parses dev-shop and finds every member key as a real bot package agent", () => {
    const raw = JSON.parse(readFileSync(join(TEAM_LIBRARY, "dev-shop.json"), "utf8"));
    const document = parseBotPackage(raw);
    expect(document.package.id).toBe("dev-shop");
    expect(document.package.name).toBe("Dev Shop");
    expect(document.package.agents.length).toBeGreaterThan(0);

    for (const member of document.package.agents) {
      const assistant = join(ASSISTANT_LIBRARY, `${member.key}.json`);
      const builtin = join(BUILTIN_LIBRARY, `${member.key}.json`);
      const path = existsSync(assistant) ? assistant : builtin;
      expect(existsSync(path), `member "${member.key}" must have a generated package`).toBe(true);

      const pkg = parseBotPackage(JSON.parse(readFileSync(path, "utf8")));
      expect(pkg.format).toBe("murage.package");
      // the package's own agent carries the same key the roster points at
      expect(pkg.package.agents.map((a) => a.key)).toContain(member.key);
    }
  });

  it("resolves every member of every shipped Wayland team package", () => {
    const files = readdirSync(TEAM_LIBRARY).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(50);
    // Starter packages author their roles inline. The importer creates bots
    // from these definitions and their linked playbooks, without consulting
    // the standalone assistant library. Keep that exception explicit so a
    // missing generated assistant in any existing team still fails.
    const embeddedRosters: Record<string, string[]> = {
      "starter-personal-home": ["home-planner"],
      "starter-solo-business": ["business-planner", "draft-partner"],
      "starter-business-team": ["team-coordinator", "delivery-partner", "review-partner"],
    };
    for (const id of Object.keys(embeddedRosters)) expect(files).toContain(`${id}.json`);
    const unresolved: string[] = [];
    for (const file of files) {
      const document = parseBotPackage(JSON.parse(readFileSync(join(TEAM_LIBRARY, file), "utf8")));
      const embeddedRoster = embeddedRosters[document.package.id];
      if (embeddedRoster) {
        expect(document.package.agents.map((member) => member.key)).toEqual(embeddedRoster);
      }
      for (const member of document.package.agents) {
        if (embeddedRoster) {
          expect(member.description?.trim().length, `${file} → ${member.key} description`).toBeGreaterThan(0);
          expect(member.playbooks?.length, `${file} → ${member.key} playbooks`).toBeGreaterThan(0);
          for (const key of member.playbooks ?? []) {
            const playbook = document.package.playbooks?.find((entry) => entry.key === key);
            expect(playbook?.instructions.trim().length, `${file} → ${member.key} → ${key}`).toBeGreaterThan(0);
          }
          continue;
        }
        const found =
          existsSync(join(ASSISTANT_LIBRARY, `${member.key}.json`)) ||
          existsSync(join(BUILTIN_LIBRARY, `${member.key}.json`));
        if (!found) unresolved.push(`${file} → ${member.key}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("finds every skill a generated assistant package declares in the generated catalog", () => {
    // bot-package.ts:79 lets an agent name library skills. An id that names
    // nothing in skills-library/ is an assistant that installs short of its
    // own profile — installSkillFromLibrary returns
    // `no library skill named "..."` for it.
    const files = readdirSync(ASSISTANT_LIBRARY).filter(
      (f) => f.endsWith(".json") && !f.startsWith("."),
    );
    expect(files.length).toBeGreaterThan(0);
    const missing: string[] = [];
    let declared = 0;
    for (const file of files) {
      const pkg = parseBotPackage(JSON.parse(readFileSync(join(ASSISTANT_LIBRARY, file), "utf8")));
      for (const agent of pkg.package.agents) {
        for (const id of agent.skills ?? []) {
          declared++;
          if (!existsSync(join(SKILL_LIBRARY, id, "SKILL.md"))) missing.push(`${file} → ${id}`);
        }
      }
    }
    expect(declared).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
