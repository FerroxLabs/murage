// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// ENGINE-SIGNIN-SIMPLE-1014, "Asking on any engine": the owner's words reach the record that carries the page's link, through
// murage_help and through the facts block on an engine with no agents mount, with every link whole inside the facts line.
import { describe, expect, it } from "vitest";
import { CAPABILITY_FACTS_HEADER, CAPABILITY_FACTS_LINE_CHARS, capabilityFactLine, capabilityFacts } from "../shared/capability-facts.ts";
import { CAPABILITY_ENTRIES } from "../shared/capability-db.ts";
import { searchHelp } from "../shared/help-search.ts";
import { parseEngineChatLink } from "../src/lib/engine-chat-link.ts";
import { NO_TOOL_SURFACE, renderMurageTurn } from "./murage-tool-surface.ts";
import type { SendTurnInput } from "./contracts.ts";

const PLAN = "cap:engines.continue-with-chatgpt-grok";
const ROUTER = "cap:engines.use-my-subscription";
const CLAUDE = "cap:engines.set-up-claude-code";
const ENGINE = "cap:engines.set-up-from-the-app";
const entry = (id: string) => CAPABILITY_ENTRIES.find((candidate) => candidate.id === id)!;
const SIGN_IN_CLAUDE = "[Sign in to Claude](murage://engine/sign-in?engine=claude)";
const SET_UP_CLAUDE = "murage://engine/set-up?engine=claude";
const CHANNEL = "open Murage on your computer, Inbox, Engines to sign in to";

const REACH: ReadonlyArray<readonly [string, string, string]> = [
  ["Hey Ember, sign into Claude", CLAUDE, SIGN_IN_CLAUDE],
  ["sign into Claude", CLAUDE, SIGN_IN_CLAUDE],
  ["set up Claude Code", CLAUDE, SET_UP_CLAUDE],
  ["I want to set up Claude", CLAUDE, SET_UP_CLAUDE],
  ["I want to set up Codex", PLAN, "murage://plan/chatgpt"],
  ["I want to use my subscription", ROUTER, "murage://plan/supergrok"],
  ["sign into Grok", ENGINE, "murage://engine/sign-in?engine=grok"],
];

describe("the records carry the page's table", () => {
  it("every murage:// link in a record is one the app draws", () => {
    for (const record of CAPABILITY_ENTRIES) {
      for (const [href] of record.text.matchAll(/murage:\/\/[^\s)]+/g)) expect(parseEngineChatLink(href), `${record.id} ${href}`).not.toBeNull();
    }
  });

  it("subscription asks which, and never lists keys first", () => {
    expect(entry(ROUTER).answer).toMatch(/^Which one do you pay for: ChatGPT, Grok or Claude\?/);
    expect(entry(ROUTER).answer).toContain("Never list keys first.");
    for (const link of ["murage://plan/chatgpt", "murage://plan/supergrok", SET_UP_CLAUDE]) expect(entry(ROUTER).answer).toContain(link);
  });

  it("Grok is said to be Unofficial, and nothing switches a bot", () => {
    for (const id of [PLAN, ROUTER]) {
      expect(entry(id).answer, id).toMatch(/Unofficial/);
      expect(entry(id).answer, id).toMatch(/[Nn]othing switches a\s+bot/);
      expect(entry(id).answer, id).toMatch(/Claude Code moves to Fuigo first/);
    }
    expect(entry(ROUTER).answer).toContain("pick a ChatGPT or Grok model in the model picker");
  });

  it("Claude opens with the page's sentence and the two links, and the bot does not run the login", () => {
    const { answer } = entry(CLAUDE);
    expect(answer).toMatch(/^Let's set up Claude Code and log you in\./);
    expect(answer).toContain(SIGN_IN_CLAUDE);
    expect(answer).toContain(SET_UP_CLAUDE);
    expect(answer).toContain("Never run the login.");
    expect(entry(ENGINE).answer).toContain("Never run the login.");
  });

  it("carries the channel words wherever a sign-in link is", () => {
    for (const id of [CLAUDE, ENGINE]) expect(entry(id).limits, id).toContain(CHANNEL);
  });

  it("has one answer: the separate sign-in record is gone", () => {
    expect(CAPABILITY_ENTRIES.some((record) => record.capability === "engines.sign-in-from-the-app")).toBe(false);
  });
});

describe("reach", () => {
  it.each(REACH)("%s reaches a record with the link through murage_help", (phrase, id, link) => {
    const hits = searchHelp(phrase, { limit: 5 });
    expect(hits.map((hit) => hit.id), phrase).toContain(id);
    expect(hits.find((hit) => hit.id === id)!.text).toContain(link);
  });

  it.each(REACH)("%s reaches the link on an engine with no agents mount", (phrase, _id, link) => {
    const turn = { text: phrase } as SendTurnInput;
    const { text } = renderMurageTurn(turn, NO_TOOL_SURFACE, {});
    expect(text.startsWith(CAPABILITY_FACTS_HEADER), phrase).toBe(true);
    expect(text, phrase).toContain(link);
  });

  it("every facts line keeps its links and channel words whole", () => {
    for (const id of [PLAN, ROUTER, CLAUDE, ENGINE]) {
      const line = capabilityFactLine(entry(id));
      expect(line.length, id).toBeLessThanOrEqual(CAPABILITY_FACTS_LINE_CHARS);
      expect(line, id).toContain(entry(id).answer);
      expect(line, id).toContain(entry(id).limits);
    }
    expect(capabilityFacts("sign into Claude")).toContain(SIGN_IN_CLAUDE);
  });
});
