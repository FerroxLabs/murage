import { describe, expect, it } from "vitest";

import {
  FIRST_RUN_BRIEF_TIME,
  FIRST_RUN_COPY,
  briefButtonLabel,
  briefRanLine,
  clockLabel,
  foundAgentsLine,
  greetingLine,
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

  it("never sends the person to Settings", () => {
    // The whole point of this release: a guided chat, not a signpost to a
    // settings pane.
    for (const { path, text } of everything) {
      expect.soft(`${path}: ${text}`).not.toMatch(/\bsettings\b/i);
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

  it("greets by name when there is one", () => {
    expect(greetingLine("Sean")).toBe("Thank you, Sean. I have got that.");
    expect(greetingLine("")).toBe("Thank you. I have got that.");
  });
});
