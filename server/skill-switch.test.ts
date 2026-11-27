// MAIN RULING design F §1.1: every action requires a complete scan/verdict snapshot; OPEN for GrokBuild approval.
import { scanSkill } from './skill-guard/scan.ts';
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planSkillSwitch, checkSkillSwitchStillValid, skillVerdictHash, type SwitchInput } from "./skill-switch.ts";
import type { SkillListing } from "./skills.ts";
const text = "---\nname: sample-skill\ndescription: Sample instructions\n---\nRead supplied notes.\n";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const listing = (over: Partial<SkillListing> = {}): SkillListing => ({ name: "sample-skill", description: "Sample instructions", enabled: true, editable: true, source: "learn:conversation", sha256: hash(text), importedAt: "2026-01-01", warnings: [], skippedFiles: [], scan:scanSkill({name:"sample-skill",description:"Sample instructions",triggerTerms:[],files:[{path:"SKILL.md",content:text}]}), ...over });
const input: SwitchInput = { schema:1,name: "sample-skill", action: "turn_off", skillSha256: hash(text), enabledBefore: true,source:"learn:conversation",shared:false,previewSha256:hash(text),scanContentHash:listing().scan!.contentHash,verdictHash:skillVerdictHash(listing().scan) };
describe("planning a skill switch without writes", () => {
  it.each(["sample-skill", "builtin:chief-of-staff", "shipped-guide"])("refuses a missing manifest entry: %s", name => {
    expect(planSkillSwitch(undefined, text, "turn_off", name)).toMatchObject({ ok: false, status: 404 });
  });
  it.each([[true, "turn_on"], [false, "turn_off"]] as const)("refuses an already-set switch %s %s", (enabled, action) => {
    expect(planSkillSwitch(listing({ enabled }), text, action, "sample-skill")).toMatchObject({ ok: false, status: 409, error: expect.stringContaining(enabled ? "Already on" : "Already off") });
  });
  it("refuses blocked on, unreadable bytes and an edited skill before showing a card", () => {
    expect(planSkillSwitch(listing({ enabled: false, scan: { verdict: "blocked", scannerVersion: 1, scannedAt: "2026-01-01", contentHash: "a".repeat(64), findings: [] } }), text, "turn_on", "sample-skill")).toMatchObject({ ok: false, status: 409 });
    expect(planSkillSwitch(listing(), null, "delete", "sample-skill")).toMatchObject({ ok: false, status: 422 });
    expect(planSkillSwitch(listing({ enabled: false }), text + "Changed", "turn_on", "sample-skill")).toMatchObject({ ok: false, status: 422 });
  });
  it.each(["collection:sample-skill", "library:sample-skill@1"])("explains that a shared take-off keeps the other copies: %s", source => {
    expect(planSkillSwitch(listing({ source }), text, "delete", "sample-skill", "Fixture bot")).toMatchObject({ ok: true, shared: true, title: 'Take skill "sample-skill" off Fixture bot?', subtitle: expect.stringContaining("Your other bots and the shared copy keep it"), allowLabel: "Delete" });
  });
  it.each(["learn:conversation", "https://example.com/skills"])("explains an irreversible delete: %s", source => {
    expect(planSkillSwitch(listing({ source }), text, "delete", "sample-skill", "Fixture bot")).toMatchObject({ ok: true, shared: false, subtitle: "This is the only copy. It can't be undone." });
  });
  it("masks before showing and binds masked and raw content separately", () => {
    const secretText = text + "\npassword=" + "fixture-private-password\n";
    const plan = planSkillSwitch(listing({ sha256: hash(secretText) }), secretText, "turn_off", "sample-skill");
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.preview).not.toContain("fixture-private-password");
    expect(plan.previewSha256).toBe(hash(plan.preview));
    expect(plan.skillSha256).toBe(hash(secretText));
  });
  it("captures the review findings and acknowledgement at card time", () => {
    const plan = planSkillSwitch(listing({ enabled: false, scan: { verdict: "review", scannerVersion: 1, scannedAt: "2026-01-01", contentHash: "b".repeat(64), findings: [{ rule: "sample", message: "Review this instruction", severity: "review" }] as any } }), text, "turn_on", "sample-skill");
    // MAIN RULING 1115-UP-DESIGNS-GROK: capture a snapshot, never an acknowledgement.
    expect(plan).toMatchObject({ ok: true, subtitle: expect.stringContaining("Review this instruction"), scanContentHash: "b".repeat(64) });
    expect(plan).not.toHaveProperty("acknowledged");
  });
});
describe("settling only the reviewed state", () => {
  it("accepts the unchanged state", () => expect(checkSkillSwitchStillValid(listing(), input)).toBeNull());
  it.each([undefined, listing({ sha256: "c".repeat(64) }), listing({ enabled: false })])("refuses a gone, edited or toggled skill", entry => expect(checkSkillSwitchStillValid(entry, input)).toContain("nothing was changed"));
  it("refuses scan drift and a blocked skill at settlement", () => {
    const enable: SwitchInput = { ...input, action: "turn_on", enabledBefore: false, acknowledged: "b".repeat(64) };
    expect(checkSkillSwitchStillValid(listing({ enabled: false, scan: { verdict: "review", scannerVersion: 1, scannedAt: "2026-01-01", contentHash: "c".repeat(64), findings: [] } }), enable)).not.toBeNull();
    expect(checkSkillSwitchStillValid(listing({ enabled: false, scan: { verdict: "blocked", scannerVersion: 1, scannedAt: "2026-01-01", contentHash: "b".repeat(64), findings: [] } }), enable)).not.toBeNull();
  });
});

it("Grok H1: a saved scan snapshot is not an owner acknowledgement", () => {
  const scan = { verdict: "review" as const, scannerVersion: 1, scannedAt: "2026-01-01", contentHash: "b".repeat(64), findings: [] };
  const proposal: SwitchInput = { ...input, action: "turn_on", enabledBefore: false, scanContentHash: scan.contentHash,verdictHash:skillVerdictHash(scan) };
  expect(checkSkillSwitchStillValid(listing({ enabled: false, scan }), proposal)).not.toBeNull();
  expect(checkSkillSwitchStillValid(listing({ enabled: false, scan }), { ...proposal, acknowledged: scan.contentHash })).toBeNull();
});
