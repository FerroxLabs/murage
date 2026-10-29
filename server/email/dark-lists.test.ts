// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dark launch (BOT-EMAIL-MURAGE-109 3.1): the email tools reach an engine's pre-allow list or ask-free matcher only on a turn whose email
// mount listed them. With the probe off no turn has a mode, and every list equals the build without email.
import { describe, expect, it } from "vitest";

import { OWN_UNASKED, ownToolListedOnTurn } from "../../shared/own-servers.ts";
import { claudeOwnUnaskedTools } from "../drivers/claude.ts";
import { hermesAskMatcher } from "../drivers/acp/hermes.ts";

const EMAIL = ["email_list", "email_read", "email_send", "email_reply", "email_trust_offer"];
const READS = ["email_list", "email_read"];
const asks = (matcher: string, tool: string) => new RegExp(`^(?:${matcher})$`).test(tool);
const nonEmailAgents = OWN_UNASKED.filter((row) => row.mount === "own:agents").flatMap((row) => row.tools).filter((tool) => !EMAIL.includes(tool));

describe("email tools on engine lists only when the turn's email mount holds", () => {
  it("Claude's pre-allowed agents tools carry no email tool with no mode, exactly the other unasked tools", () => {
    expect(claudeOwnUnaskedTools("agents")).toEqual(nonEmailAgents.map((tool) => `mcp__agents__${tool}`));
    for (const mode of [undefined, "", "other"]) for (const tool of EMAIL) expect(claudeOwnUnaskedTools("agents", mode)).not.toContain(`mcp__agents__${tool}`);
  });

  it("Claude pre-allows the two reads on a read turn and all five on a send turn", () => {
    const read = claudeOwnUnaskedTools("agents", "read");
    for (const tool of EMAIL) expect(read.includes(`mcp__agents__${tool}`)).toBe(READS.includes(tool));
    const send = claudeOwnUnaskedTools("agents", "send");
    for (const tool of EMAIL) expect(send).toContain(`mcp__agents__${tool}`);
    expect(send.length).toBe(nonEmailAgents.length + EMAIL.length);
  });

  it.each([false, true])("Hermes asks for every email tool with no mode, and lets them through by mode (host computer %s)", (host) => {
    for (const tool of EMAIL) expect(asks(hermesAskMatcher(host), `mcp__agents__${tool}`)).toBe(true);
    for (const tool of EMAIL) expect(asks(hermesAskMatcher(host, false, "read"), `mcp__agents__${tool}`)).toBe(!READS.includes(tool));
    for (const tool of EMAIL) expect(asks(hermesAskMatcher(host, false, "send"), `mcp__agents__${tool}`)).toBe(false);
    for (const tool of nonEmailAgents) expect(asks(hermesAskMatcher(host), `mcp__agents__${tool}`)).toBe(false);
  });

  it("ownToolListedOnTurn leaves every other tool alone", () => {
    expect(ownToolListedOnTurn("list_bots", undefined)).toBe(true);
    expect(ownToolListedOnTurn("email_send", "read")).toBe(false);
    expect(ownToolListedOnTurn("email_read", "read")).toBe(true);
    expect(ownToolListedOnTurn("email_list", undefined)).toBe(false);
  });
});
