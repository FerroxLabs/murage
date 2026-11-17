// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SkillDetail } from "@/lib/skills-api";

export const bots = [{ id: "builder", name: "Builder" }, { id: "growth", name: "Growth" }];
export function detail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    ref: "library:testing", name: "A/B Testing Specialist", description: "Design, run and read A/B tests.",
    kind: "library", source: "Library", verdict: "clean", usedBy: [], skipped: [],
    text: "---\nname: testing\ndescription: Test well\n---\n# A/B Testing Specialist\n\n**Decide the run time first.**\n\n## When to use\n\n- Before launching a test\n- When results look too good\n",
    files: ["SKILL.md", "sample-size.md"],
    scan: { verdict: "clean", findings: [], contentHash: "a".repeat(64) },
    bots: bots.map((bot) => ({ botId: bot.id, botName: bot.name, enabled: bot.id === "growth", canUseSkills: true })),
    ...overrides,
  };
}
export function reviewed() {
  return detail({ verdict: "review", scan: { verdict: "review", contentHash: "b".repeat(64), findings: [{ rule: "x", category: "c", severity: "medium", confidence: 1, message: "Tells the bot to ignore its instructions", evidence: "Ignore earlier instructions", file: "SKILL.md" }] } });
}
