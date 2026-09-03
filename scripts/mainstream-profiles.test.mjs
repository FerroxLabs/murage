// The seven mainstream profiles must actually install what their cards promise.
//
// Two failures this pins, both learned the hard way:
//
//   * A profile whose skills all fail to resolve is INVISIBLE. chooseIntakeProfile
//     (src/lib/onboarding-intake.ts) does `if (skills.length === 0) continue;`, so a
//     profile declaring nothing — or nothing real — can never be offered by the
//     intake matcher. 18 of the older bot-library/builtins are in that state.
//   * PARTIAL resolution silently over-promises. The gate only requires
//     skills.length > 0, so a profile declaring ten ids of which one resolves is
//     still offered, and the card renders prose written for all ten.
//
// So: every id, not most of them. And installability is not "the directory
// exists" — it is every rule installSkillFromLibrary applies, which is why this
// asks checkLibrarySkill instead of restating a subset of them. Nine catalogued
// skills were broken on the frontmatter-name rule and are now repaired;
// server/skill-library-integrity.test.ts walks the whole library, so a tenth
// cannot appear unnoticed and no blocklist has to be kept here to rot.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseBotPackage } from "../server/bot-package.ts";
import { checkLibrarySkill } from "../server/skills.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillLibrary = join(repoRoot, "skills-library");

/** The profiles this test owns. Added together, aimed at the ~80% of real usage
 *  (Practical Guidance, Seeking Information, Writing) the library did not serve. */
const MAINSTREAM_PROFILES = ["concierge", "writer", "explainer", "researcher", "advisor", "creator", "builder"];

function loadProfile(slug) {
  const file = join(repoRoot, "bot-library", "builtins", `${slug}.json`);
  return parseBotPackage(JSON.parse(readFileSync(file, "utf8"))).package;
}

function declaredSkills(pkg) {
  return [...new Set(pkg.agents.flatMap((agent) => agent.skills ?? []))];
}

/** Why this id would not install, or null if it would. Delegates to the
 *  installer's own checker rather than restating its rules: this function used
 *  to hand-roll a SUBSET of them, and a profile test that quietly disagrees
 *  with the installer is worse than no test at all. */
function installFailure(id) {
  const checked = checkLibrarySkill(id, skillLibrary);
  return "error" in checked ? checked.error : null;
}

describe("mainstream profiles", () => {
  it.each(MAINSTREAM_PROFILES)("%s declares skills that all resolve", (slug) => {
    const pkg = loadProfile(slug);
    const declared = declaredSkills(pkg);
    // Zero skills is the invisibility bug: the intake matcher skips the profile
    // entirely, so the card can never be offered no matter how well it is written.
    expect(declared.length).toBeGreaterThan(0);
    const broken = declared.map((id) => [id, installFailure(id)]).filter(([, why]) => why !== null);
    expect(broken).toEqual([]);
  });

  it("promises no connector it cannot honour", () => {
    // Zero of the 2,237 shipped skills can drive Composio or MCP, so a
    // REQUIRED app would advertise a capability that does not exist — the
    // exact silent failure this whole set was written to avoid.
    //
    // An OPTIONAL one is the opposite: a declaration. Researcher is better
    // with live search and honest without it, and `requirements.apps` is the
    // field the package format already has for saying so — declared by 122
    // entries as empty and read by nothing but re-export until now. Every
    // optional entry still has to carry a reason, because an app named with
    // no explanation is a prompt nobody can act on.
    for (const slug of MAINSTREAM_PROFILES) {
      const pkg = loadProfile(slug);
      const required = (pkg.requirements.apps ?? []).filter((app) => app.optional !== true);
      expect(required, `${slug} requires an app no shipped skill can reach`).toEqual([]);
      for (const app of pkg.requirements.apps ?? []) {
        expect(app.slug, `${slug} declares an app with no slug`).toBeTruthy();
        expect(app.reason, `${slug} declares ${app.slug} with no reason`).toBeTruthy();
      }
      expect(pkg.requirements.capabilities).toEqual([]);
    }
  });
});

// Every builtin, not just the seven. The seven above are the profiles this file
// OWNS; this block is the weaker-per-profile but wider guarantee that no builtin
// anywhere declares an id the installer would refuse. It is the cheap version of
// the lesson at the top: a dangling id does not throw, it is logged and skipped
// (server/index.ts, installSkillFromLibrary's caller), so the bot installs with
// a persona and a hole in it and nothing on screen says so.
const ALL_BUILTINS = readdirSync(join(repoRoot, "bot-library", "builtins"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length))
  .sort();

/** The five profiles Wave 0 filled, and exactly what the cross-audit approved.
 *
 *  Pinned by value rather than merely "non-empty" because these five were empty
 *  on purpose-by-omission for a long time, and BOTH directions are regressions:
 *  losing a row puts the profile back behind chooseIntakeProfile's zero-skill
 *  skip (invisible to intake again), and adding one silently widens the profile's
 *  intake vocabulary, which is what routes a stranger's first sentence. 13 of the
 *  18 formerly-empty builtins stay empty by design and are deliberately absent. */
const WAVE0_PROFILES = {
  "beautiful-mermaid": ["diagram-architect"],
  "book-production": ["self-publishing-guide"],
  "excel-creator": [
    "excel-lookup-formulas",
    "pivot-table-builder",
    "conditional-formatting-rules",
    "data-validation-setup",
  ],
  "human-3-coach": ["life-coach"],
  "story-roleplay": ["character-development", "world-building", "dialogue-writing"],
};

describe("every builtin profile", () => {
  it.each(ALL_BUILTINS)("%s declares no skill the installer would refuse", (slug) => {
    const broken = declaredSkills(loadProfile(slug))
      .map((id) => [id, installFailure(id)])
      .filter(([, why]) => why !== null);
    expect(broken).toEqual([]);
  });
});

describe("wave 0 profiles", () => {
  it.each(Object.keys(WAVE0_PROFILES))("%s declares exactly the approved skills", (slug) => {
    expect(declaredSkills(loadProfile(slug))).toEqual(WAVE0_PROFILES[slug]);
  });
});

describe("the front door reaches people the honest way", () => {
  // Concierge cannot win the intake matcher and must not be made to. Its
  // value is being generic; `intakeProfileMatches` rewards topic-specific
  // vocabulary. Padding its summary to make it rank is a lie AND the exact
  // trick that made the bare word "say" start matching Researcher.
  //
  // So it is offered as the answer to "nothing matched" — which is the
  // question a front door exists to answer, and the one a person hit after
  // typing the card's own placeholder text.
  it("is offered last, only when a match and loose skills both found nothing", () => {
    const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
    // Ordered: a real match wins, loose skills beat the front door, and two
    // words of noise that happen to tokenise are refused outright.
    expect(server).toContain("!profile && skills.length === 0 && tokens.length > 0 && words >= 3");
    expect(server).toContain("await intakeFrontDoor()");
    // A real match still wins, and loose skills still beat the front door.
    expect(server).toContain("profile: profile ?? frontDoor");
  });

  it("refuses to offer a front door that would configure nothing", () => {
    const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
    const fn = server.slice(server.indexOf("async function intakeFrontDoor"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toContain("if (skills.length === 0) return null;");
  });

  it("says it is a front door rather than a match", () => {
    const card = readFileSync(new URL("../src/components/BotIntakeCard.tsx", import.meta.url), "utf8");
    expect(card).toContain("profile.fallback &&");
    expect(card).toContain("Nothing in the library matches that exactly");
  });

  it("does not pad Concierge's summary to game the matcher", () => {
    // The failure this whole approach exists to avoid. If someone ever
    // "fixes" ranking by stuffing generic verbs in here, they will break
    // other profiles' matching the way "say" did.
    const concierge = JSON.parse(
      readFileSync(new URL("../bot-library/builtins/concierge.json", import.meta.url), "utf8"),
    ).package;
    for (const filler of [" say ", " help me ", " anything ", " something "]) {
      expect(concierge.summary.toLowerCase(), `summary was padded with "${filler.trim()}"`).not.toContain(filler);
    }
  });
});
