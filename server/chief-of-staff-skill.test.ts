// THE CHIEF OF STAFF SKILL, AND THE ONE THING THAT KEPT KILLING IT.
//
// This skill was written twice before and shipped neither time, because the
// obvious way to install it is the wrong one. A per-bot import keeps SKILL.md
// and throws every supporting file away by design (`server/skills.ts`, v1
// review boundary), so a skill whose instructions defer to reference files
// arrives as a shell pointing at four files that are not there.
//
// It is therefore a BUNDLED skill: `loadBundledSkills` reads whole directories
// out of MURAGE_SKILLS_DIR (Resources/skills in a packaged build, `skills/` in
// the repo), carries the directory through, and `renderSkillInstructions` can
// emit `root=` so the engine's own file tools reach the references.
//
// `root=` is emitted only when the bot works in a local workspace and the run
// is not on the box (`server/index.ts`), so there are runs where the inlined
// SKILL.md is ALL the model gets. That is the load-bearing property these
// tests defend: the references deepen the skill, they are never the only place
// a rule lives.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BRIEF_SECTIONS } from "../shared/brief.ts";
import { loadBundledSkills, renderSkillInstructions, selectBundledSkills } from "./skill-library.ts";

const SKILLS_ROOT = join(process.cwd(), "skills");
const bundled = loadBundledSkills(SKILLS_ROOT);
const chief = bundled.find((skill) => skill.manifest.id === "chief-of-staff");

/** Markdown comments stripped, so a word that appears only in a comment can
 *  never satisfy an assertion about what the model is actually told. */
const withoutComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "");

const instructions = withoutComments(chief?.instructions ?? "");
const reference = (name: string) =>
  withoutComments(readFileSync(join(SKILLS_ROOT, "chief-of-staff", "references", name), "utf8"));

/** TypeScript source with its comments removed, so a phrase that survives
 *  only in a comment can never stand in for the copy a person reads. Read as
 *  source rather than imported: `src/lib/first-run-copy.ts` belongs to the
 *  renderer's bundler resolution and does not compile under the server
 *  project. */
const withoutCodeComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const firstRunCopy = withoutCodeComments(
  readFileSync(new URL("../src/lib/first-run-copy.ts", import.meta.url), "utf8"),
);

/** The sentences the closing card's buttons literally send as the owner's own
 *  turn. Lifted out of the `work:` list so the skill is measured against the
 *  words the product actually puts in their mouth. */
const firstRunOffers = (() => {
  const at = firstRunCopy.indexOf("workLabel:");
  expect(at, "the closing card's list of jobs has moved or been renamed").toBeGreaterThan(-1);
  const block = firstRunCopy.slice(at, firstRunCopy.indexOf("moreLabel:", at));
  return [...block.matchAll(/say: "([^"]+)"/g)].map((match) => match[1]!);
})();

/** The standing-trust promise the connected apps card already makes. Computed
 *  inside the test so a change to the product's own wording fails that test
 *  rather than taking the file down before anything runs. */
const trustPromise = () => {
  const match = /trust: "([^"]+)"/.exec(firstRunCopy);
  expect(match, "the apps card no longer carries a trust sentence").not.toBeNull();
  const sentence = match![1]!;
  expect(sentence, "the apps card's trust sentence has been reworded").toContain("You approve, I send.");
  return sentence.slice(sentence.indexOf("You approve, I send."));
};

describe("the Chief of Staff ships as a bundled skill", () => {
  it("loads out of the packaged skills tree with a manifest the loader accepts", () => {
    expect(chief, "skills/chief-of-staff is not loading as a bundled skill").toBeDefined();
    expect(chief!.directory).toBe(join(SKILLS_ROOT, "chief-of-staff"));
    // Nothing passes a "chief" capability into selectBundledSkills, so any
    // required capability at all would silence this skill on every turn.
    expect(chief!.manifest.requiredCapabilities).toEqual([]);
    expect(chief!.manifest.defaultEnabled).toBe(true);
  });

  it("keeps every reference file it names, which the import path would have dropped", () => {
    const named = [...instructions.matchAll(/references\/([a-z-]+\.md)/g)].map((match) => match[1]!);
    expect(new Set(named).size, "SKILL.md names no reference files").toBeGreaterThan(0);
    for (const name of new Set(named)) {
      expect(() => reference(name), `SKILL.md points at references/${name} and it is not there`).not.toThrow();
    }
  });

  it("hands the engine the directory so the references are reachable", () => {
    const rooted = renderSkillInstructions([chief!], { includeRoot: true });
    expect(rooted).toContain(`root=${JSON.stringify(chief!.directory)}`);
    expect(renderSkillInstructions([chief!])).not.toContain("root=");
  });
});

describe("it mounts on the work the Chief is actually given", () => {
  /** The morning brief routine, read out of the server source rather than
   *  imported: the template lives in server/index.ts, which boots a server on
   *  import. Comments stripped for the same reason as above. */
  const routinePrompts = () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const at = source.indexOf("const SETUP_ROUTINE_TEMPLATES = {");
    expect(at, "the first run's routine templates have moved or been renamed").toBeGreaterThan(-1);
    const block = source.slice(at, source.indexOf("\n} as const;", at));
    return block
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .split("\n")
      .filter((line) => /^\s*\+?\s*["`]/.test(line))
      .join(" ");
  };

  it("mounts on the morning brief, the inbox sort and the watch the first run creates", () => {
    const prompts = routinePrompts();
    for (const phrase of ["Go through my calendar", "Sort the inbox", "Keep an eye on"]) {
      expect(prompts, `the routine templates no longer say "${phrase}"`).toContain(phrase);
      expect(
        selectBundledSkills(phrase, [], bundled).map((skill) => skill.manifest.id),
        `the Chief of Staff skill does not mount on "${phrase}"`,
      ).toContain("chief-of-staff");
    }
  });

  it("mounts on the jobs the closing card offers in the owner's own words", () => {
    expect(firstRunOffers.length, "the closing card offers nothing").toBeGreaterThan(3);
    const mounted = firstRunOffers.filter((say) => selectBundledSkills(say, [], bundled)
      .some((skill) => skill.manifest.id === "chief-of-staff"));
    expect(mounted).toEqual([
      "Help me run my business.",
      "I would like you to look into something for me.",
      "Organise my day for me.",
    ]);
  });

  it("stays out of work that is not the Chief's", () => {
    for (const text of [
      "write me a poem about the sea",
      "fix the type error in this file",
      "open Uber on my Android",
      "/create-verification-skill for my notes app",
    ]) {
      expect(
        selectBundledSkills(text, ["skillAuthoring", "phoneMcp"], bundled).map((skill) => skill.manifest.id),
        `the Chief of Staff skill mounts on "${text}"`,
      ).not.toContain("chief-of-staff");
    }
  });
});

describe("SKILL.md stands alone, because a cloud run gets no reference files", () => {
  it("carries all five jobs itself", () => {
    for (const job of [
      "Morning brief",
      "Organise my day",
      "Make sense of notes",
      "Research a topic",
      "Help me run my business",
    ]) {
      expect.soft(instructions, `SKILL.md no longer names "${job}" as one of the five jobs`).toContain(job);
    }
  });

  it("carries the brief's own sections, in the order the page lays them out", () => {
    const at = BRIEF_SECTIONS.map((section) => ({
      heading: section.heading,
      at: instructions.indexOf(section.heading),
    }));
    for (const section of at) {
      expect.soft(section.at, `SKILL.md never names the "${section.heading}" section`).toBeGreaterThan(-1);
    }
    const order = at.map((section) => section.at);
    expect([...order].sort((a, b) => a - b), "SKILL.md has the brief's sections out of order").toEqual(order);
  });

  it("carries the ask-rather-than-assume rule itself", () => {
    expect.soft(instructions).toMatch(/Bring decisions, not questions/);
    expect.soft(instructions).toMatch(/Never ask what you can look up/);
  });
});

describe("it promises only what this computer can do", () => {
  /** The same twelve hours server/routines.ts records on a missed run. Read
   *  from the source so the skill cannot keep claiming a window the scheduler
   *  stopped honouring. */
  const missedAfter = () => {
    const source = withoutCodeComments(readFileSync(new URL("./routines.ts", import.meta.url), "utf8"));
    const match = /offline for more than (\d+) hours/.exec(source);
    expect(match, "routines.ts no longer explains a missed run by hours offline").not.toBeNull();
    return Number(match![1]);
  };

  it("says a routine runs only while Murage is running, and names the missed window", () => {
    expect(instructions).toMatch(/[Rr]outines run only while Murage is running/);
    expect(missedAfter(), "the skill says twelve hours and the scheduler no longer agrees").toBe(12);
    expect(instructions, "the skill should name the window after which a run is missed")
      .toContain("twelve hours");
  });

  it("does not describe email or calendar access as read only, because there is none", () => {
    expect(instructions).toContain("Email is read and send. Calendar is read and create.");
    expect(instructions.toLowerCase()).not.toMatch(/read.only (access|scope) to (your |their )?(email|mail|calendar)/);
  });

  it("delivers the brief in the app rather than mailing it to the person we read mail for", () => {
    expect(instructions).toMatch(/you do not mail them their own brief/);
    expect(reference("brief.md")).toMatch(/delivered here, in the app/);
  });

  it("does not make memory, routines or teammates wait on a key", () => {
    expect(instructions).toMatch(/need no separate key/);
  });
});

describe("it obeys the house copy rules", () => {
  /** Read inside each test rather than at collection time, so a missing
   *  reference file fails the test that is about missing reference files
   *  instead of taking the whole file down before it runs. */
  const everything = () => [
    instructions,
    reference("brief.md"),
    reference("jobs.md"),
    reference("trust.md"),
    reference("checks.md"),
    readFileSync(join(SKILLS_ROOT, "chief-of-staff", "manifest.json"), "utf8"),
  ].join("\n");

  it("uses no em dash and never names the connector broker", () => {
    const text = everything();
    expect.soft(text).not.toContain("—");
    expect.soft(text).not.toContain("–");
    expect.soft(text.toLowerCase()).not.toContain("composio");
  });

  it("tells the Chief not to argue anything on price", () => {
    expect(instructions).toMatch(/never argue for\s+anything on price/);
    expect(reference("jobs.md")).toMatch(/never make the\s+case for something on price/);
  });

  it("keeps the standing trust sentence the rest of the product already says", () => {
    const promise = trustPromise();
    expect.soft(instructions, "the skill and the apps card no longer say the same thing")
      .toContain(promise);
    expect.soft(reference("trust.md")).toContain(promise);
  });

  // THE SKILL IS WHERE THE FALSE PROMISE WOULD COME BACK FROM.
  //
  // The apps card said "once you trust me with a kind of email, I can send
  // those myself", and so did SKILL.md and trust.md, which are instructions
  // the Chief reads and then repeats to the person in its own words. No such
  // grant exists: a remembered approval is keyed by the whole tool name
  // (`approvalKey`, server/auto-approve.ts) and every connected-app call the
  // Chief makes arrives as one wrapper tool, so one grant covers reading and
  // sending and every account at once.
  //
  // Fixing the card and leaving the skill would have put the same sentence
  // back into the conversation from the other end, said by the assistant
  // rather than printed on a card, which is worse: nobody can diff it.
  it("never tells the Chief it can be granted less than one whole key", () => {
    // The shape of the false promise: a kind of mail narrowed, and in the
    // same sentence the Chief saying it will then act alone on that kind.
    // Deliberately not a ban on the words: this skill legitimately talks
    // about kinds of work as its OWN discipline, and trust.md has to be able
    // to say out loud that no such switch exists in order to warn about it.
    const narrower =
      /\b(?:kind|kinds|type|types|sort|sorts|category|categories)\s+of\s+(?:e-?mail|mails?|message|messages)\b[^.]*\b(?:myself|on my own|without asking|and I (?:can|will) send)\b/i;
    for (const [name, text] of [
      ["SKILL.md", instructions],
      ["trust.md", reference("trust.md")],
      ["jobs.md", reference("jobs.md")],
    ] as const) {
      const hit = narrower.exec(text);
      expect.soft(
        hit ? `${name}: "${hit[0]}"` : null,
        `${name} offers a grant the approval system cannot key`,
      ).toBeNull();
    }
    // And it says out loud what a grant really covers, so the Chief has an
    // honest answer when the person asks before saying yes.
    expect(reference("trust.md")).toMatch(/keyed by the tool/i);
  });
});
