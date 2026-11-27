// MAIN RULING design F §1.1: scan-complete proposal fixture; OPEN for GrokBuild approval.
import { scanSkill } from './skill-guard/scan.ts';
// Skill proposal/acceptance owner: this build lane. Queue policy owner: decision/No-limits lane.
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { planSkillSwitch } from "./skill-switch.ts";
import { ProducerApprovalQueue } from "./narrow-denials.ts";
import { fixture, d } from "./decision/fixture.ts";
import { DATA_DIR } from "./config.ts";
import { join } from "node:path";
it("a real queue refusal under No limits never executes or presents a switch", async () => {
  const host = fixture("unlimited");
  // The decision fixture exposes disabled-capability refusal; skills have no
  // per-tool Never store. Use the real host policy hook rather than inventing one.
  const uninstall = d.installDecisionHost({ store: host.store, view: () => ({ title: "Fixture", subtitle: "Fixture" }), featureOff: () => "Fixture capability is off." });
  const text = "Sample instructions";
  const plan = planSkillSwitch({ name: "sample-skill", description: "Sample", enabled: true, editable: true, source: "learn:conversation", sha256: createHash("sha256").update(text).digest("hex"), importedAt: "2026-01-01", warnings: [], skippedFiles: [],scan:scanSkill({name:"sample-skill",description:"Sample",triggerTerms:[],files:[{path:"SKILL.md",content:text}]}) }, text, "turn_off", "sample-skill");
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error(plan.error);
  const queue = new ProducerApprovalQueue("skill", join(DATA_DIR, "fixture-switch-queue.json"));
  const execute = vi.fn();
  const request = queue.open({ authority: { claim: host.claim, proof: "trusted" }, ref: "fixture-switch", tool: "switch_skill", input: { name: plan.name, action: plan.action, skillSha256: plan.skillSha256, enabledBefore: plan.enabledBefore }, action: { requestId: "fixture-switch", tool: "switch_skill", options: [plan.allowLabel, "Deny"], skillRequest: { id: "fixture-switch", stagedId: "", action: plan.action, name: plan.name } }, view: { title: plan.title, subtitle: plan.subtitle }, base: { approve: null, source: "no-grant" } });
  expect(await queue.execute(request, execute)).toMatchObject({ kind: "refuse", message: expect.any(String) });
  expect(execute).not.toHaveBeenCalled();
  expect(queue.pendingApprovals()).toEqual([]);
  expect(host.db.prepare("SELECT count(*) AS n FROM messages WHERE kind='options'").get()!.n).toBe(0);
  uninstall(); host.dispose();
});
