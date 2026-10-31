// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// When does an image render ask the owner first? One pure decision, read from
// the bot's approval level, its per-bot "Images" setting, who started the
// turn and who it answers to, and the optional "ask again after N images"
// guard. The harness wiring (server/index.ts) only gathers these facts; the
// rules live here so every level, setting and guard has a row.
import { describe, expect, it } from "vitest";
import { IMAGE_ASK_AFTER_MAX, decideImageApproval, imageAskAfterOf, imageApprovalOf, type ImageApprovalFacts } from "./image-approval.ts";
import type { FullAccessOrigin } from "./auto-approve.ts";

const LEVELS = {
  ask: { autoApprove: false },
  auto: { autoApprove: true },
  full: { autoApprove: true, fullAccess: true },
  unlimited: { autoApprove: true, fullAccess: true, noLimits: true },
} as const;
const facts = (over: Partial<ImageApprovalFacts> = {}): ImageApprovalFacts => ({
  level: LEVELS.ask, origin: "owner", ownerAudience: true, count: 1, madeThisTurn: 0, ...over,
});

describe("image approval follows the permission level", () => {
  it("makes images without a card on Full access and No limits", () => {
    expect(decideImageApproval(facts({ level: LEVELS.full }))).toEqual({ ask: false, basis: "Full access" });
    expect(decideImageApproval(facts({ level: LEVELS.unlimited }))).toEqual({ ask: false, basis: "No limits" });
  });
  it("keeps the card on Ask and Auto", () => {
    expect(decideImageApproval(facts({ level: LEVELS.ask })).ask).toBe(true);
    expect(decideImageApproval(facts({ level: LEVELS.auto })).ask).toBe(true);
    expect(decideImageApproval(facts({ level: undefined })).ask).toBe(true);
  });
  it("counts Full access only on top of Auto, as every other tool reads it", () => {
    expect(decideImageApproval(facts({ level: { autoApprove: false, fullAccess: true } })).ask).toBe(true);
  });
});

describe("the Images setting", () => {
  it("Follow permission level (the default) is the level's own answer", () => {
    for (const setting of [undefined, "follow"] as const) {
      expect(decideImageApproval(facts({ setting, level: LEVELS.full })).ask).toBe(false);
      expect(decideImageApproval(facts({ setting, level: LEVELS.auto })).ask).toBe(true);
    }
  });
  it("Ask before each image asks even on Full access and No limits", () => {
    for (const level of [LEVELS.full, LEVELS.unlimited]) expect(decideImageApproval(facts({ setting: "ask", level }))).toMatchObject({ ask: true, reason: "setting" });
  });
  it("Make images without asking overrides Ask and Auto for the owner's own turn", () => {
    for (const level of [LEVELS.ask, LEVELS.auto, LEVELS.full]) expect(decideImageApproval(facts({ setting: "allow", level }))).toEqual({ ask: false, basis: "the Images setting" });
  });
});

describe("only the owner's audience is spared the card", () => {
  const spared = [LEVELS.full, LEVELS.unlimited];
  it("a contact, someone else in a room or words nobody proved always get the card, whatever the level or setting", () => {
    for (const level of [...spared, LEVELS.ask]) for (const setting of [undefined, "follow", "allow"] as const) {
      expect(decideImageApproval(facts({ level, setting, ownerAudience: false })), `${setting} ${JSON.stringify(level)}`).toMatchObject({ ask: true, reason: "audience" });
    }
  });
});

describe("unattended and automated turns are never judged more loosely than Full access judges them", () => {
  const covered = (origin: FullAccessOrigin, over: Partial<ImageApprovalFacts> = {}) => !decideImageApproval(facts({ level: LEVELS.full, origin, ...over })).ask;
  it("a webhook, someone else's message or an unproven origin asks", () => {
    expect(covered("other")).toBe(false);
    expect(covered("other", { setting: "allow" as const })).toBe(false);
    expect(decideImageApproval(facts({ level: LEVELS.full, origin: "owner", unattended: true }))).toMatchObject({ ask: true, reason: "unattended" });
    expect(decideImageApproval(facts({ setting: "allow", level: LEVELS.ask, origin: "owner", unattended: true })).ask).toBe(true);
  });
  it("the owner's routine runs at its judged level, and the setting reaches it like the owner's own turn", () => {
    expect(covered("routine")).toBe(true);
    expect(decideImageApproval(facts({ level: LEVELS.auto, origin: "routine" })).ask).toBe(true);
    expect(decideImageApproval(facts({ level: LEVELS.auto, origin: "routine", setting: "allow" })).ask).toBe(false);
  });
  it("the owner's own channel message needs the bot's Full access option, with or without the setting", () => {
    expect(covered("owner-channel")).toBe(false);
    expect(covered("owner-channel", { level: { ...LEVELS.full, fullAccessChannelMessages: true } } as Partial<ImageApprovalFacts>)).toBe(true);
    expect(decideImageApproval(facts({ level: LEVELS.ask, origin: "owner-channel", setting: "allow" })).ask).toBe(true);
    expect(decideImageApproval(facts({ level: { ...LEVELS.ask, fullAccessChannelMessages: true }, origin: "owner-channel", setting: "allow" })).ask).toBe(false);
  });
});

describe("ask again after N images in one turn", () => {
  it("blank means the internal ceiling of 50 images a turn, so a looping model cannot spend without bound", () => {
    const at = (made: number, count = 1) => decideImageApproval(facts({ level: LEVELS.full, madeThisTurn: made, count, askAfter: undefined }));
    expect(at(0).ask).toBe(false);
    expect(at(49).ask).toBe(false);
    expect(at(50)).toMatchObject({ ask: true, reason: "loop-guard" });
    expect(at(0, 51)).toMatchObject({ ask: true, reason: "loop-guard" });
    expect(at(0, 50).ask).toBe(false);
    expect(IMAGE_ASK_AFTER_MAX).toBe(50);
  });
  it("asks for the image that would pass N, and never before", () => {
    const at = (made: number, count = 1) => decideImageApproval(facts({ level: LEVELS.full, askAfter: 3, madeThisTurn: made, count }));
    expect(at(0).ask).toBe(false);
    expect(at(2).ask).toBe(false);
    expect(at(3)).toMatchObject({ ask: true, reason: "loop-guard" });
    expect(at(0, 4)).toMatchObject({ ask: true, reason: "loop-guard" });
    expect(at(0, 3).ask).toBe(false);
    // 2 made, then 2 more: the second batch passes the limit of 3
    expect(at(2, 2)).toMatchObject({ ask: true, reason: "loop-guard" });
  });
  it("applies under the override too", () => {
    expect(decideImageApproval(facts({ setting: "allow", askAfter: 1, madeThisTurn: 1 }))).toMatchObject({ ask: true, reason: "loop-guard" });
  });
});

describe("what a stored setting is read as", () => {
  it("keeps only ask and allow; anything else is the default", () => {
    expect(imageApprovalOf("ask")).toBe("ask");
    expect(imageApprovalOf("allow")).toBe("allow");
    for (const bad of [undefined, null, "follow", "ALLOW", true, 1, {}, []]) expect(imageApprovalOf(bad)).toBeUndefined();
  });
  it("keeps only a whole number from 1 to 50 for the guard", () => {
    expect(imageAskAfterOf(1)).toBe(1);
    expect(imageAskAfterOf(50)).toBe(50);
    for (const bad of [undefined, null, 0, -1, 51, 1.5, "3", NaN, Infinity, true]) expect(imageAskAfterOf(bad)).toBeUndefined();
  });
});
