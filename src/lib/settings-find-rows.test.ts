// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings v10 S1: skill rows open their own sheet on the named bot; settings then skills only.
import { describe, expect, it } from "vitest";
import { askChiefLine, findRows, skillOpenTarget } from "./settings-find-rows";
import { searchSettingsIndex } from "./settings-search";

const BOTS = [{ id: "b-nova", name: "Nova" }, { id: "b-rex", name: "Rex" }];
const SKILL = { kind: "skill" as const, ref: { skillId: "weekly-report", botId: "b-rex" }, title: "Weekly report" };

describe("settings finder rows (S1)", () => {
  it("a skill opens its own sheet on the bot the result names", () => {
    expect(skillOpenTarget(SKILL)).toEqual({ page: "skills", sheet: { skillId: "weekly-report" }, bot: "b-rex" });
    expect(skillOpenTarget({ ...SKILL, ref: { skillId: "weekly-report" } })).toEqual({ page: "skills", sheet: { skillId: "weekly-report" } });
  });
  it("settings lead, then skills; the real ranker's hits are kept whole", () => {
    const { hits } = searchSettingsIndex("working folder", { desktop: true, cloud: false, bots: BOTS, currentBotId: "b-nova" });
    expect(hits.length).toBeGreaterThan(0);
    const rows = findRows(hits, [SKILL]);
    expect(rows.map((r) => r.kind)).toEqual([...hits.map(() => "setting"), "skill"]);
    expect(rows.find((r) => r.kind === "setting" && r.hit.bot?.id === "b-nova")).toBeTruthy();
  });
  it("Ask Chief names the chief, with a fallback", () => {
    expect(askChiefLine("Nova")).toBe("Can't find it? Ask Nova.");
    expect(askChiefLine("  ")).toBe("Can't find it? Ask Chief.");
  });
});
