import { expect, it } from "vitest";
import { leadershipAdmissionError } from "./leadership-admission.ts";
it("requires an enabled declared delegation capability", () => {
  expect(leadershipAdmissionError({ enabled: true, adapter: { capabilities: { agentsMcp: true } } }, "ready")).toBeNull();
  for (const instance of [undefined, { enabled: true, adapter: { capabilities: {} } }, { enabled: true, adapter: { capabilities: { agentsMcp: false } } }, { enabled: false, adapter: { capabilities: { agentsMcp: true } } }]) {
    expect(leadershipAdmissionError(instance, "fixture-engine")).toContain("fixture-engine");
  }
});
