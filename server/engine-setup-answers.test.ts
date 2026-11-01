// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ENGINE-SETUP-ANSWERS: an owner asking in their own words how to set up an engine, or use a subscription, gets the right
// checked record first on every engine: through murage_help where it is mounted, through the facts block where it is not.
import { describe, expect, it } from "vitest";
import { CAPABILITY_FACTS_LINE_CHARS, capabilityFacts } from "../shared/capability-facts.ts";
import { searchHelp } from "../shared/help-search.ts";
import { CAPABILITY_ENTRIES } from "../shared/capability-db.ts";
import { capabilitiesPrimer, ENGINE_SETUP_FACTS_LINE, ENGINE_SETUP_LINE, type PrimerFacts } from "./capabilities-primer.ts";

const PLAN = "cap:engines.continue-with-chatgpt-grok";
const ROUTER = "cap:engines.use-my-subscription";
const CLAUDE = "cap:engines.set-up-claude-code";
const ENGINE = "cap:engines.set-up-from-the-app";

const PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["I want to set up Codex", PLAN],
  ["set up Codex", PLAN],
  ["I want to set up Grok", PLAN],
  ["set up Grok", PLAN],
  ["use my ChatGPT subscription", PLAN],
  ["use my ChatGPT plan", PLAN],
  ["use my Grok subscription", PLAN],
  ["use my SuperGrok plan", PLAN],
  ["I want to use my subscription", ROUTER],
  ["use my subscription", ROUTER],
  ["I want to set up Claude", CLAUDE],
  ["set up Claude", CLAUDE],
  ["set up Claude Code", CLAUDE],
  ["use my Claude subscription", CLAUDE],
  ["log in to Claude Code", CLAUDE],
  ["set up Kimi Code", ENGINE],
  ["install an engine", ENGINE],
  ["what is Terminal", ENGINE],
  ["I do not have Node.js", ENGINE],
  ["install the Codex app", ENGINE],
];

describe("engine setup questions in the owner's words", () => {
  it.each(PHRASES)("%s reaches the right record first through murage_help", (phrase, id) => {
    expect(searchHelp(phrase)[0]?.id).toBe(id);
  });

  // The facts block needs two of the question's own words, so an ordinary message with one shared word carries nothing.
  it.each(PHRASES.filter(([phrase]) => phrase.split(" ").length > 2 && phrase !== "what is Terminal"))("%s reaches the same record on an engine with no murage_help", (phrase, id) => {
    const block = capabilityFacts(phrase);
    const title = CAPABILITY_ENTRIES.find((entry) => entry.id === id)!.title;
    expect(block.split("\n")[1]).toContain(`- ${title}:`);
  });

  it("carries each answer whole in the facts block, with no step clipped", () => {
    for (const id of [PLAN, ROUTER, CLAUDE, ENGINE]) {
      const entry = CAPABILITY_ENTRIES.find((candidate) => candidate.id === id)!;
      const line = capabilityFacts(entry.heading!.split(" / ")[0]).split("\n").find((text) => text.startsWith(`- ${entry.title}:`))!;
      expect(line.length).toBeLessThanOrEqual(CAPABILITY_FACTS_LINE_CHARS);
      expect(line, id).toContain(entry.answer);
    }
  });

  it("names the plain words and the real buttons, and no command", () => {
    const words = (id: string) => CAPABILITY_ENTRIES.find((entry) => entry.id === id)!;
    expect(words(CLAUDE).answer).toMatch(/^Let's set up Claude Code and log you in\./);
    expect(words(CLAUDE).answer).toContain("Open install in Terminal");
    expect(words(CLAUDE).answer).toContain("Open sign-in in Terminal");
    expect(words(ENGINE).answer).toContain("Terminal is a window for typed commands.");
    expect(words(ENGINE).limits).toContain("nodejs.org");
    expect(words(CLAUDE).answer).toContain("nodejs.org");
    expect(words(ROUTER).limits).toContain("SuperGrok or X Premium");
    expect(words(PLAN).limits).toContain("Unofficial");
    expect(words(PLAN).engines).not.toContain("claude");
    expect(words(ROUTER).answer).toMatch(/^Which one do you pay for: ChatGPT, Grok or Claude\?/);
    expect(words(PLAN).answer).toContain("your bots use the plan on Fuigo");
    expect(words(PLAN).answer).toContain("The Codex and Grok apps are separate.");
    expect(words(CLAUDE).answer).toContain("tell me what it shows");
    expect(words(PLAN).url).toContain("#use-a-plan-you-already-have");
    expect(words(ROUTER).url).toContain("#use-a-plan-you-already-have");
    expect(words(CLAUDE).url).toContain("#install-an-ai-app");
    expect(words(ENGINE).url).toContain("#install-an-ai-app");
    for (const id of [PLAN, ROUTER, CLAUDE, ENGINE]) {
      expect(words(id).text, id).not.toMatch(/--provider|fuigo login|npm install|auth login|murage:\/\//);
    }
    for (const id of [PLAN, CLAUDE, ENGINE]) expect(words(id).limits, id).toContain("Never put a sign-in code or key in a chat.");
  });
});

describe("the primer line", () => {
  const facts = (over: Partial<PrimerFacts>): PrimerFacts => ({
    engine: "Fuigo", toolAccess: "direct", imageInput: "inline", mounted: {}, memory: "active", imageProvider: false,
    folder: "none", peers: 0, canAskOwner: true, ...over,
  });

  it("reaches the owner on an engine with murage_help and on one without it", () => {
    expect(capabilitiesPrimer(facts({ ownerAudience: true, mounted: { agents: true } }))).toContain(ENGINE_SETUP_LINE);
    expect(capabilitiesPrimer(facts({ ownerAudience: true }))).toContain(ENGINE_SETUP_FACTS_LINE);
  });

  it("stays off a turn that is not the owner's", () => {
    expect(capabilitiesPrimer(facts({ ownerAudience: false, mounted: { agents: true } }))).not.toContain(ENGINE_SETUP_LINE);
  });

  it("stays small and byte-identical, one sentence pair on an existing line", () => {
    expect(Buffer.byteLength(ENGINE_SETUP_LINE)).toBeLessThanOrEqual(102);
    const owner = facts({ ownerAudience: true, mounted: { agents: true } });
    expect(capabilitiesPrimer(owner)).toBe(capabilitiesPrimer(owner));
    const contact = { ...owner, ownerAudience: false };
    // An owner has one line more than a contact, the MCP servers line; this clause adds no line of its own.
    expect(capabilitiesPrimer(owner).split("\n").length).toBe(capabilitiesPrimer(contact).split("\n").length + 1);
    expect(capabilitiesPrimer(owner)).toContain(`behaviour. ${ENGINE_SETUP_LINE}`);
  });
});
