// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertNoLearningData, isLearningLocalPath, parseBotPackage } from "./bot-package.ts";
import { createBotPackageExport } from "./package-export.ts";
import { collectPackageExportSkills } from "./package-export-files.ts";
import { classifyRoutineOutbound } from "./routine-outbound.ts";
import type { BotRecord } from "./store.ts";

const SECRET = "Harborview needs a forty percent discount";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("a bot with prospect learning on exports no learning field, lesson or prospect wording", () => {
  const bot = { id: "dax", threadId: "t", name: "Dax", title: "Sales", description: "Sells", color: "green", notifications: true, unread: false, createdAt: 1,
    learning: { enabled: true, askFirst: false, prospectLearning: true, revision: 3 }, lessons: [{ text: SECRET }], prospectDerived: SECRET } as unknown as BotRecord;
  const exported = createBotPackageExport({ name: "Crew", bots: [bot], groups: [], routines: [] });
  const text = JSON.stringify(exported);
  expect(text).not.toMatch(/Harborview|prospectLearning|prospectDerived|lessons|"learning"/);
  expect(() => parseBotPackage(exported as never)).not.toThrow();
});

it("refuses a package carrying learning keys anywhere", () => {
  const base = createBotPackageExport({ name: "Crew", bots: [{ id: "a", threadId: "t", name: "A", title: "T", description: "d", color: "green", notifications: true, unread: false, createdAt: 1 } as BotRecord], groups: [], routines: [] });
  const bad = structuredClone(base) as unknown as { package: { agents: Array<Record<string, unknown>> } };
  bad.package.agents[0].learning = { prospectLearning: true };
  expect(() => parseBotPackage(bad as never)).toThrow(/Learning data is not part of a package/);
  expect(() => assertNoLearningData({ a: [{ prospectDerived: true }] })).toThrow();
  expect(() => assertNoLearningData({ outcomes: ["x"] })).not.toThrow();
  // owner-typed feedback text lives in memory_feedback.correction; the table never rides a package
  expect(() => assertNoLearningData({ memory_feedback: [{ correction: "use my phone number" }] })).toThrow();
});

function skillFixture(files: Record<string, string>) {
  const workspace = mkdtempSync(join(tmpdir(), "murage-learning-skills-")); roots.push(workspace);
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(workspace, path)), { recursive: true }); writeFileSync(join(workspace, path), content); }
  return workspace;
}
const skill = (extra = "") => `---\nname: working-guide\ndescription: How this bot works\n${extra}---\nBody\n`;

it("sharing refuses a prospect-derived skill and anything under learning-local", () => {
  expect(() => collectPackageExportSkills(skillFixture({ "skills/working-guide/SKILL.md": skill("prospectDerived: true\n") }), ["working-guide"])).toThrow("PROSPECT_DERIVED_SKILL");
  expect(() => collectPackageExportSkills(skillFixture({ "skills/working-guide/SKILL.md": skill(), "skills/working-guide/learning-local/pat.md": SECRET }), ["working-guide"])).toThrow("LEARNING_LOCAL_EXCLUDED");
  expect(isLearningLocalPath("skills/x/learning-local/a")).toBe(true);
  expect(isLearningLocalPath("skills/x/learning-localish/a")).toBe(false);
  const ok = collectPackageExportSkills(skillFixture({ "skills/working-guide/SKILL.md": skill() }), ["working-guide"]);
  expect([...ok.payloads.keys()]).toEqual(["skills/working-guide/SKILL.md"]);
});

const routine = (prompt: string, extra: Record<string, unknown> = {}) => ({ prompt, target: "bot" as const, ...extra });
it("classifies outbound routines, and treats unclear as outbound", () => {
  const known = { writeToolsMounted: false, deliversToOwnOnly: true };
  expect(classifyRoutineOutbound(routine("Summarize my inbox for me each morning"), known).outbound).toBe(false);
  // unknown delivery or unknown tools is outbound (T1-13)
  expect(classifyRoutineOutbound(routine("Summarize my inbox for me each morning")).reasons).toEqual(["unknown-tools", "unknown-delivery"]);
  expect(classifyRoutineOutbound(routine("Summarize my inbox"), { writeToolsMounted: false }).reasons).toEqual(["unknown-delivery"]);
  expect(classifyRoutineOutbound(routine("Summarize my inbox"), { deliversToOwnOnly: true }).reasons).toEqual(["unknown-tools"]);
  // the words are never read (Tier 1 allowlist 3.7): only the structure decides
  expect(classifyRoutineOutbound(routine("Send the weekly update email to customers"), known).outbound).toBe(false);
  expect(classifyRoutineOutbound(routine("Post the draft to LinkedIn")).outbound).toBe(true); // unknown structure is outbound
  expect(classifyRoutineOutbound(routine("Pay the open invoices"), known).reasons).toEqual([]);
  expect(classifyRoutineOutbound(routine("Coordinate the room", { target: "room-goal" })).reasons).toContain("room-goal");
  expect(classifyRoutineOutbound(routine("Summarize notes"), { deliversToOwnOnly: false }).reasons).toContain("non-owner-audience");
  expect(classifyRoutineOutbound(routine("Summarize notes"), { writeToolsMounted: true }).outbound).toBe(true);
  expect(classifyRoutineOutbound(routine("   "), known).reasons).toEqual(["no-instructions"]);
});
