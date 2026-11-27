import { expect, it } from "vitest";
import { isSkillSwitchAction, SKILL_SWITCH_ACTIONS, skillRequestBehavior } from "./skill-request.ts";
it("maps exactly the switch labels to allow and keeps unknown labels denied", () => {
  // MAIN RULING 1115-UP-DESIGNS-GROK: switch words authorize only that card’s own option.
  for (const label of ["Turn off", "Turn on", "Delete"]) {
    expect(skillRequestBehavior(label, { action: label === "Delete" ? "delete" : label === "Turn on" ? "turn_on" : "turn_off" }, [label, "Deny"])).toBe("allow");
    expect(skillRequestBehavior(label)).toBe("deny");
  }
  for (const label of ["Take off", "Delete everything", "unknown", "Never", "Deny"]) expect(skillRequestBehavior(label)).toBe("deny");
});
it("recognizes only the three switch actions", () => {
  expect(SKILL_SWITCH_ACTIONS).toEqual(["turn_on", "turn_off", "delete"]);
  for (const action of SKILL_SWITCH_ACTIONS) expect(isSkillSwitchAction(action)).toBe(true);
  for (const action of [undefined, "create", "update", "enable", {}, "toString"]) expect(isSkillSwitchAction(action)).toBe(false);
});

// MAIN RULING 1115-SKILLS-GROK e: keep Enable denied for every switch action.
it("Grok C1: a switch answer must match the card's own affirmative option", () => {
  for (const action of SKILL_SWITCH_ACTIONS) {
    const label = action === "turn_on" ? "Turn on" : action === "turn_off" ? "Turn off" : "Delete";
    for (const answer of ["Enable", "Update", "Yes", "Allow", "Confirm", "Delete", "Turn on", "Turn off"]) {
      expect(skillRequestBehavior(answer, { action }, [label, "Deny"])).toBe(answer === label ? "allow" : "deny");
    }
    expect(skillRequestBehavior(label, { action }, [])).toBe("deny");
    expect(skillRequestBehavior(label, { action }, [label])).toBe("deny");
  }
  for (const action of ["create", "update"] as const) for (const label of ["Delete", "Turn off", "Turn on"]) {
    expect(skillRequestBehavior(label, { action }, [label, "Deny"])).toBe("deny");
  }
});
