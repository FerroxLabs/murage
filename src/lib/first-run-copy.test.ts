import { describe, expect, it } from "vitest";

import { fluxRecommendation } from "@/components/FirstRunFluxCard";
import {
  FIRST_RUN_BRIEF_TIME,
  FIRST_RUN_COPY,
  briefButtonLabel,
  briefRanLine,
  clockLabel,
  foundAgentsLine,
  greetingLine,
  localModelLine,
  signedOutAgentsLine,
  joinNames,
} from "./first-run-copy";

/**
 * THE COPY GATE.
 *
 * Every string a person can read during the first run is in one module, so
 * the rules the product owner has rejected work over can be checked over all
 * of it at once rather than argued about per pull request. A rule that lives
 * only in a brief is a rule that comes back.
 *
 * The walk is deep and type blind on purpose: a new card added to
 * FIRST_RUN_COPY is covered the moment it exists, without anyone remembering
 * to add it here. Strings produced by the module's formatters are fed in
 * beside it, because a sentence assembled at render time is still a sentence
 * on screen.
 */
function walk(value: unknown, path: string, into: Array<{ path: string; text: string }>): void {
  if (typeof value === "string") {
    into.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, into));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, into);
  }
}

const strings: Array<{ path: string; text: string }> = [];
walk(FIRST_RUN_COPY, "FIRST_RUN_COPY", strings);
// Slugs are wire identifiers, not copy. Everything else on a row is read out.
const readable = strings.filter((entry) => !entry.path.endsWith(".slug") && !entry.path.endsWith(".template"));

const assembled: Array<{ path: string; text: string }> = [
  { path: "foundAgentsLine(one)", text: foundAgentsLine(["Claude Code"]) },
  { path: "foundAgentsLine(two)", text: foundAgentsLine(["Claude Code", "Codex"]) },
  { path: "foundAgentsLine(three)", text: foundAgentsLine(["Claude Code", "Codex", "Fuigo"]) },
  { path: "foundAgentsLine(none)", text: foundAgentsLine([]) },
  { path: "briefRanLine", text: briefRanLine(FIRST_RUN_BRIEF_TIME) },
  { path: "briefRanLine(pm)", text: briefRanLine("18:30") },
  { path: "briefButtonLabel", text: briefButtonLabel(FIRST_RUN_BRIEF_TIME) },
  { path: "greetingLine", text: greetingLine("Sean") },
  { path: "greetingLine(blank)", text: greetingLine("  ") },
  { path: "signedOutAgentsLine(one)", text: signedOutAgentsLine(["Claude Code"]) },
  { path: "signedOutAgentsLine(two)", text: signedOutAgentsLine(["Claude Code", "Codex"]) },
  { path: "signedOutAgentsLine(none)", text: signedOutAgentsLine([]) },
  { path: "localModelLine", text: localModelLine("Qwen3.8-27B", "llama.cpp") },
  { path: "localModelLine(no host)", text: localModelLine("qwen3:8b", "") },
  { path: "localModelLine(none)", text: localModelLine("", "") },
  { path: "agents.signed-out.commandFor", text: FIRST_RUN_COPY.agents["signed-out"].commandFor("Codex") },
];

const everything = [...readable, ...assembled];

describe("first run copy: the house rules", () => {
  it("has strings to check at all", () => {
    expect(readable.length).toBeGreaterThan(40);
  });

  it("never uses an em dash", () => {
    for (const { path, text } of everything) {
      expect.soft(`${path}: ${text}`).not.toContain("—");
    }
  });

  it("never uses an en dash as punctuation", () => {
    for (const { path, text } of everything) {
      expect.soft(`${path}: ${text}`).not.toContain("–");
    }
  });

  it("never names the connected app broker", () => {
    for (const { path, text } of everything) {
      expect.soft(`${path}: ${text}`.toLowerCase()).not.toContain("composio");
    }
  });

  it("never sells on price", () => {
    // Money in any form: the adjectives, the nouns, and the figures. The
    // first run says what the thing does, never what it costs.
    const banned = /\b(cheap\w*|discount\w*|wholesale|afford\w*|budget\w*|spend\w*|cost\w*|pric\w*|token\w*|free|dollars?|cents?|per month|save money|value for money)\b/i;
    for (const { path, text } of everything) {
      const hit = banned.exec(text);
      expect.soft(hit ? `${path}: ${hit[0]} in "${text}"` : null).toBeNull();
    }
    for (const { path, text } of everything) {
      expect.soft(`${path}: ${text}`).not.toMatch(/[$£€]\s?\d/);
    }
  });

  it("never states a model count", () => {
    // "500+ apps" is the one figure this flow is allowed, and it is about
    // apps. A figure attached to models is the claim that was rejected.
    for (const { path, text } of everything) {
      for (const match of text.matchAll(/(\d[\d,]*)\s*\+/g)) {
        const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 12);
        expect.soft(`${path}: ${match[0]}${tail}`, `${path}: ${text}`).toMatch(/\d[\d,]*\s*\+\s*apps\b/);
      }
      expect.soft(`${path}: ${text}`).not.toMatch(/\d[\d,]*\s*\+?\s*(of the |latest |ai )*models/i);
    }
  });

  it("never frames the first run as school", () => {
    const banned = /\b(lesson|lessons|exercise|exercises|quiz|quizzes|assignment|assignments|homework|curriculum|tutorial)\b/i;
    for (const { path, text } of everything) {
      const hit = banned.exec(text);
      expect.soft(hit ? `${path}: ${hit[0]}` : null).toBeNull();
    }
  });

  it("never describes a capability as a limit", () => {
    const banned = /\b(i can never|i cannot|i can't|i am not allowed|i am unable|never able to)\b/i;
    for (const { path, text } of everything) {
      const hit = banned.exec(text);
      expect.soft(hit ? `${path}: ${hit[0]}` : null).toBeNull();
    }
  });

  // ONE NAMED EXEMPTION, AND ONLY ONE.
  //
  // The rule is that the flow does not hand somebody a signpost instead of
  // doing the thing. It is about the PATH THROUGH: every step the Chief asks
  // for, it also carries out, in the conversation, which is the whole point
  // of this release and what the modal it replaced got wrong.
  //
  // It is not a ban on the word. Somebody who has just declined the key on a
  // machine with nothing on it has deliberately stepped off that path, and
  // the two ways back, their own endpoint or a local model, genuinely live in
  // Settings and have no in-chat flow yet. Refusing to say so would not keep
  // them out of Settings; it would only stop them finding the thing that
  // rescues them. When that walk-through exists in the chat, this exemption
  // goes with it.
  const SETTINGS_EXEMPT = new Set(["FIRST_RUN_COPY.flux.no-key.secondBare"]);

  it("never sends the person to Settings on the way through", () => {
    for (const { path, text } of everything) {
      if (SETTINGS_EXEMPT.has(path)) continue;
      expect.soft(`${path}: ${text}`).not.toMatch(/\bsettings\b/i);
    }
  });

  it("keeps that exemption down to the branch it was written for", () => {
    // A growing list here is the rule quietly being repealed.
    expect(SETTINGS_EXEMPT.size).toBe(1);
    for (const path of SETTINGS_EXEMPT) {
      expect(everything.some((entry) => entry.path === path), `${path} no longer exists`).toBe(true);
    }
  });
});

describe("first run copy: the things the flow promises", () => {
  it("leads the Flux Router card with routing, then apps, then media", () => {
    const flux = FIRST_RUN_COPY.flux.key;
    expect(flux.body).toContain("all the latest AI models");
    expect(flux.body).toContain("smart routing");
    expect(flux.second).toContain("500+ apps");
    for (const named of ["Gmail", "Slack", "Notion", "GitHub"]) expect(flux.second).toContain(named);
    expect(flux.third).toMatch(/pictures.*voice.*transcription/);
    expect(flux.recommendation.toLowerCase()).toContain("recommended");
  });

  it("puts email on graduated trust wherever email is mentioned", () => {
    const line = "You approve, I send. Once you trust me with a kind of email, I can send those myself.";
    expect(FIRST_RUN_COPY.apps.apps.trust).toContain(line);
    expect(FIRST_RUN_COPY.routines["more-routines"].rows[0].why).toContain(line);
  });

  it("offers a job rather than a team on the closing card", () => {
    const next = FIRST_RUN_COPY.routines.next;
    const hire = next.more.find((offer) => /teammate/i.test(offer.label));
    expect(hire?.label).toBe("Hire your first teammate");
    for (const offer of [...next.work, ...next.more]) {
      expect.soft(offer.label).not.toMatch(/build a team/i);
      expect.soft(offer.say).not.toMatch(/build a team/i);
    }
  });

  // Backups are a smart default and never a step: nothing in the six-step
  // checklist is about them, and everything the flow says about them lives in
  // the one `backups` group under the closing card. The group has more than
  // one sentence because it tells the truth about two different machines, one
  // where backups are already running and one where they are not, and about
  // what happened after the press. What it must never do is become a step, or
  // turn up in the middle of the flow.
  it("keeps backups out of the steps, and in one place", () => {
    const mentions = readable.filter((entry) => /backup/i.test(entry.text));
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      expect.soft(mention.path, `${mention.path} talks about backups outside the backups group`)
        .toMatch(/^FIRST_RUN_COPY\.backups\./);
    }
  });

  it("never claims found engines on a bare machine", () => {
    expect(FIRST_RUN_COPY.agents.bare.body).not.toMatch(/found|connected them/i);
    expect(foundAgentsLine(["Claude Code", "Codex"])).toContain("Claude Code and Codex");
  });
});

// THE KEY CARD IS READ BY TWO PEOPLE IN DIFFERENT SITUATIONS.
//
// Murage ships the engine, not the brain. On a clean machine this key is what
// gives the engine something to think with, and calling it merely
// "recommended" is an understatement they discover one card later. On a
// machine that already had Claude Code or Codex, they are working already and
// telling them they NEED it would be false, and false in the way that reads
// as a sales pitch.
describe("what the key card claims, to whom", () => {
  const key = FIRST_RUN_COPY.flux.key;

  it("does not tell somebody who is already working that they need it", () => {
    expect(fluxRecommendation({ agents: [{ id: "claude" }] })).toBe(key.recommendationBonus);
    expect(key.recommendationBonus).toMatch(/optional/i);
    expect(key.recommendationBonus).not.toMatch(/\bneed\b|\brequired\b/i);
  });

  it("does not undersell it to somebody who has nothing", () => {
    expect(fluxRecommendation({ agents: [] })).toBe(key.recommendationBare);
    expect(key.recommendationBare).not.toMatch(/optional/i);
  });

  it("takes the milder claim when it cannot tell", () => {
    // The claim that is never wrong is the one to make with no answer yet.
    expect(fluxRecommendation(null)).toBe(key.recommendation);
    expect(fluxRecommendation({})).toBe(key.recommendation);
  });

  it("leads on routing in every version, and never counts models", () => {
    for (const line of [key.body, key.recommendation, key.recommendationBare, key.recommendationBonus]) {
      expect.soft(line, line).not.toMatch(/\d+\s*\+?\s*models/i);
      expect.soft(line, line).not.toMatch(/composio/i);
    }
    expect(key.body).toMatch(/all the latest/i);
    expect(key.body).toMatch(/routing/i);
  });
});

// THE NO-KEY BRANCH IS NOT A DEAD END, AND MUST NOT READ LIKE ONE.
//
// The engine takes any OpenAI-style endpoint with a key, which is most of the
// industry, plus anything running on the machine itself. So "not now" always
// has a way on. What it must never do is tell somebody with nothing that they
// are carrying on with what is on their machine, because there is nothing on
// their machine and they would sit there believing they had chosen it.
describe("saying not now to the key", () => {
  const noKey = FIRST_RUN_COPY.flux["no-key"];

  it("does not claim there is something to carry on with when there is not", () => {
    expect(noKey.body).toMatch(/carry on/i);
    expect(noKey.bodyBare).not.toMatch(/carry on/i);
  });

  it("names a real way on, and does not promise a flow that does not exist", () => {
    expect(noKey.secondBare).toMatch(/openai/i);
    // No "I will walk you through it": nothing implements that walk yet, and
    // the whole point of this release is not promising what has not happened.
    expect(noKey.secondBare).not.toMatch(/walk you through|I will set (it|that) up/i);
  });
});

describe("first run copy: the sentence builders", () => {
  it("joins engine names the way a person would say them", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["  "])).toBe("");
    expect(joinNames(["Codex"])).toBe("Codex");
    expect(joinNames(["Claude Code", "Codex"])).toBe("Claude Code and Codex");
    expect(joinNames(["Claude Code", "Codex", "Fuigo"])).toBe("Claude Code, Codex and Fuigo");
  });

  it("says a time out loud rather than in 24 hour clock", () => {
    expect(clockLabel("07:00")).toBe("7:00 am");
    expect(clockLabel("00:30")).toBe("12:30 am");
    expect(clockLabel("12:00")).toBe("12:00 pm");
    expect(clockLabel("18:30")).toBe("6:30 pm");
    // Nonsense in, the same nonsense out: never a wrong time said with
    // confidence.
    expect(clockLabel("nope")).toBe("nope");
    expect(clockLabel("42:00")).toBe("42:00");
  });

  it("repeats the chosen time back on the button", () => {
    expect(briefButtonLabel("07:00")).toBe("Set my brief for 7:00 am");
  });

  it("greets by name when there is one, and is not a receipt", () => {
    expect(greetingLine("Sean")).toContain("Sean");
    expect(greetingLine("  Sean  ")).toContain("Sean");
    expect(greetingLine("")).not.toContain("undefined");
    // "Thank you. I have got that." was correct and read like a form
    // confirming a submission. This is the first thing a chief of staff ever
    // says to the person they work for.
    for (const line of [greetingLine("Sean"), greetingLine("")]) {
      expect.soft(line, line).not.toMatch(/thank you|got that|saved|recorded/i);
    }
  });
});
