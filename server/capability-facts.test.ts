// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CAPABILITY-DB-1010 routes A and B. Route A: murage_help ranks the capability
// records beside the docs and hands the bot status, limits and applicability.
// Route B: a turn with no agents mount (OpenClaw's own tools, a tool-less,
// draft-only or text-only chat turn) gets the matching records with the
// message, bounded, and nothing for an unrelated question.
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FACTS_HEADER, CAPABILITY_FACTS_LINE_CHARS, CAPABILITY_FACTS_MAX_LINES, capabilityFactLine, capabilityFacts,
} from "../shared/capability-facts.ts";
import { CAPABILITY_ENTRIES } from "../shared/capability-db.ts";
import { helpResultForBot, searchHelp } from "../shared/help-search.ts";
import { NO_TOOL_SURFACE, PI_TOOL_SURFACE, renderMurageTurn } from "./murage-tool-surface.ts";
import type { SendTurnInput } from "./contracts.ts";

const turn = (text: string, extra: Partial<SendTurnInput> = {}): SendTurnInput => ({ text, ...extra } as SendTurnInput);
const record = (id: string) => CAPABILITY_ENTRIES.find((entry) => entry.capability === id)!;

describe("route A: murage_help", () => {
  it("ranks the cannot entry first for its own question and carries its status, limits and ask-your-bot step", () => {
    const policy = record("install-account.policy-lock");
    const [first] = searchHelp(policy.heading!.split(" / ")[0], { limit: 5 });
    expect(first?.id).toBe("cap:install-account.policy-lock");
    const forBot = helpResultForBot(first!);
    expect(forBot.status).toBe("cannot");
    expect(forBot.limits).toBe(policy.limits);
    expect(forBot.text).toContain("Ask your bot:");
    expect(forBot.applies).toMatch(/^Applies to /);
  });

  it("hands a desktop-only capability to the bot with its applicability, never as a plain yes", () => {
    const lam = record("memory.learn-about-me");
    const hit = searchHelp(lam.heading!.split(" / ")[0], { limit: 5 }).find((result) => result.id === "cap:memory.learn-about-me");
    expect(hit).toBeDefined();
    const forBot = helpResultForBot(hit!);
    expect(forBot.applies).toBe(lam.applies);
    expect(forBot.applies).not.toMatch(/Android|iPhone|every platform/);
  });

  it("keeps a docs result to the docs fields", () => {
    const docs = searchHelp("back up my data", { limit: 5 }).find((result) => !result.id.startsWith("cap:"));
    expect(docs).toBeDefined();
    expect(Object.keys(helpResultForBot(docs!)).sort()).toEqual(["heading", "text", "title", "url", "where"]);
  });
});

describe("route B: the facts block for a turn with no agents mount", () => {
  const channelQuestion = record("bots.channel-turns").heading!.split(" / ")[0];

  it("gives a tool-less turn the channel turns facts, capped", () => {
    const out = renderMurageTurn(turn(channelQuestion), NO_TOOL_SURFACE, {});
    expect(out.text.startsWith(CAPABILITY_FACTS_HEADER)).toBe(true);
    expect(out.text).toContain(record("bots.channel-turns").title);
    expect(out.text).toContain("Settings → Bots → Advanced → Channel turn timeout");
    expect(out.text.endsWith(channelQuestion)).toBe(true);
    const lines = out.text.split("\n\n")[0].split("\n").slice(1);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(CAPABILITY_FACTS_MAX_LINES);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(CAPABILITY_FACTS_LINE_CHARS + 2);
  });

  it("adds nothing for an unrelated question", () => {
    const text = "Write me a limerick about a sleepy cat on a warm windowsill.";
    expect(renderMurageTurn(turn(text), NO_TOOL_SURFACE, {}).text).toBe(text);
  });

  it("gives a draft-only bot factual help too (Astra r2 M3)", () => {
    const out = renderMurageTurn(turn(channelQuestion, { draftOnly: true }), NO_TOOL_SURFACE, {});
    expect(out.text).toContain(CAPABILITY_FACTS_HEADER);
  });

  it("skips engine commands and turns that can call murage_help", () => {
    expect(renderMurageTurn(turn(channelQuestion, { engineCommand: { name: "help", args: "" } }), NO_TOOL_SURFACE, {}).text).toBe(channelQuestion);
    expect(renderMurageTurn(turn(channelQuestion), PI_TOOL_SURFACE, { agents: "agents" }).text).not.toContain(CAPABILITY_FACTS_HEADER);
  });

  it("is added once, and stays out of the system stack", () => {
    const once = renderMurageTurn(turn(channelQuestion, { system: "persona" }), NO_TOOL_SURFACE, {});
    const twice = renderMurageTurn(once, NO_TOOL_SURFACE, {});
    expect(twice.text.split(CAPABILITY_FACTS_HEADER)).toHaveLength(2);
    expect(once.system ?? "").not.toContain(CAPABILITY_FACTS_HEADER);
  });

  it("searches only the newest 400 characters, so a replayed history does not pick the facts", () => {
    const text = `${channelQuestion} ${"x ".repeat(400)}Write me a limerick about a sleepy cat.`;
    expect(capabilityFacts(text)).toBe("");
  });

  it("keeps a desktop-only capability's applicability through route B (phone-excluded fixture)", () => {
    const lam = record("memory.learn-about-me");
    const block = capabilityFacts(lam.heading!.split(" / ")[0]);
    expect(block).toContain(lam.title);
    expect(block).toContain(lam.applies);
  });

  it("never clips the applicability, limits or ask-your-bot step off a long line", () => {
    const long = { ...record("limits.spending-per-bot"), answer: "word ".repeat(400).trim() };
    const line = capabilityFactLine(long);
    expect(line.length).toBeLessThanOrEqual(CAPABILITY_FACTS_LINE_CHARS + 2);
    expect(line).toContain(long.applies);
    expect(line).toContain(long.limits);
    expect(line).toContain(`Ask your bot: ${long.askYourBot}`);
    for (const entry of CAPABILITY_ENTRIES) expect(capabilityFactLine(entry).length, entry.capability).toBeLessThanOrEqual(CAPABILITY_FACTS_LINE_CHARS + 2);
  });
});
