import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { READER_PREVIEW_CHARS, SkillReaderView, type SkillReaderViewProps } from "./SkillReader";
import type { SkillDetail } from "@/lib/skills-api";

const detail = (over: Partial<SkillDetail> = {}): SkillDetail => ({
  ref: "collection:invoice-chaser",
  name: "invoice-chaser",
  description: "Chases overdue invoices.",
  kind: "collection",
  verdict: "clean",
  source: "Imported from a zip",
  usedBy: [],
  text: "# Invoices\nDraft polite reminders.",
  files: ["SKILL.md"],
  skipped: [],
  scan: { verdict: "clean", findings: [], contentHash: "c".repeat(64) },
  bots: [{ botId: "b1", botName: "Sable", canUseSkills: true, enabled: false }, { botId: "b2", botName: "Grok bot", canUseSkills: false, enabled: false }],
  ...over,
});
const finding = (message: string) => ({ rule: "x", category: "c", severity: "medium", confidence: 0.8, message, evidence: "e", file: "SKILL.md" });
const noop = () => {};
const render = (over: Partial<SkillReaderViewProps> = {}) =>
  renderToStaticMarkup(createElement(SkillReaderView, {
    skill: detail(), mode: { kind: "settings" }, busy: false, pending: null, error: "", showAll: false,
    onBack: noop, onSwitch: noop, onConfirm: noop, onCancel: noop, onDelete: noop, onShowAll: noop, ...over,
  }));

describe("the skill reader", () => {
  it("shows a clean skill with a switch per bot, and says which engines can't use skills", () => {
    const html = render();
    expect(html).toContain("No red flags");
    expect(html).toContain("The safety check found no red flags.");
    expect(html).toContain("Use with");
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).toContain("This bot&#x27;s engine can&#x27;t use skills.");
    expect(html).toContain("Draft polite reminders.");
    expect(html).toContain("Delete");
  });

  it("lists findings once each for a skill that needs a look, and asks before switching it on", () => {
    const skill = detail({ verdict: "review", scan: { verdict: "review", contentHash: "c".repeat(64), findings: [finding("Tells the bot to ignore its instructions"), finding("Tells the bot to ignore its instructions")] } });
    const html = render({ skill });
    expect(html.match(/Tells the bot to ignore its instructions/g)).toHaveLength(1);
    const asking = render({ skill, pending: { kind: "enable", botId: "b1" } });
    expect(asking).toContain("Use invoice-chaser anyway?");
    expect(asking).toContain("Use it anyway");
  });

  it("gives a Blocked skill no switch and no Add button, and says why", () => {
    const skill = detail({ verdict: "blocked", scan: { verdict: "blocked", contentHash: "c".repeat(64), findings: [finding("Reads passwords, keys or tokens")] } });
    const html = render({ skill });
    expect(html).toContain("This skill was blocked by the safety check and can&#x27;t be switched on.");
    expect(html).not.toContain('role="switch"');
    expect(render({ skill, mode: { kind: "bot", botId: "b1" } })).not.toContain(">Add<");
  });

  it("has one Add button in the bot window, and says Added once it is on", () => {
    expect(render({ mode: { kind: "bot", botId: "b1" } })).toContain(">Add<");
    expect(render({ mode: { kind: "bot", botId: "b1" } })).not.toContain("Use with");
    const added = detail({ bots: [{ botId: "b1", botName: "Sable", canUseSkills: true, enabled: true }] });
    expect(render({ skill: added, mode: { kind: "bot", botId: "b1" } })).toContain("Added");
  });

  it("names the bots before deleting a skill they use", () => {
    expect(render({ pending: { kind: "delete", bots: ["Sable", "Ember"] } })).toContain("Sable, Ember use it. It will be removed from them too.");
  });

  it("renders a very long skill quickly, with Show all", () => {
    const skill = detail({ text: "A line of instructions for the bot.\n".repeat(6000) });
    const start = performance.now();
    const html = render({ skill });
    expect(performance.now() - start).toBeLessThan(1500);
    expect(skill.text.length).toBeGreaterThan(READER_PREVIEW_CHARS);
    expect(html).toContain("Show all");
  });
});
