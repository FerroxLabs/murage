import { expect, it } from "vitest";
import { ONBOARDING_CHOICES, readOnboardingProgress } from "./onboarding-progress";
it("maps the three outcomes to existing shipped profiles", () => {
  expect(ONBOARDING_CHOICES.map(choice => choice.title)).toEqual(["Organize my day", "Run my business", "Build and create"]);
  expect(ONBOARDING_CHOICES.map(choice => choice.id)).toEqual(["starter-personal-home", "starter-solo-business", "starter-business-team"]);
});
it("resumes only a known choice without inventing an engine or model", () => {
  expect(readOnboardingProgress({ getItem: () => JSON.stringify({ choice: "starter-personal-home" }) })).toEqual({ choice: "starter-personal-home", instanceId: "", model: "" });
  expect(readOnboardingProgress({ getItem: () => JSON.stringify({ choice: "starter-solo-business", instanceId: "fuigo", model: "selected" }) })).toEqual({ choice: "starter-solo-business", instanceId: "fuigo", model: "selected" });
});
it("ignores unreadable or unknown progress without importing anything", () => {
  for (const value of ["{", "null", '{"choice":"unknown"}']) expect(readOnboardingProgress({ getItem: () => value }).choice).toBeNull();
  expect(readOnboardingProgress({ getItem: () => { throw new Error("Denied"); } }).choice).toBeNull();
});
