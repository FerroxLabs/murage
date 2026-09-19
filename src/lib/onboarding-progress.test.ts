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

// A fresh install is seeded with one bot whose thread opens with its greeting
// and intake question. That must still read as a first run.
const seedBot = { id: "b1", threadId: "t1", name: "Ember", title: "", description: "", tasks: [{ threadId: "t1" }] };
const seedPage = { messages: [{ role: "bot", kind: "text", text: "Hello." }, { role: "bot", kind: "options", card: {} }], hasMore: false };
it("treats the untouched seeded bot as a first run", async () => {
  const { seedBotCandidate, isUntouchedSeedThread } = await import("./onboarding-progress");
  expect(seedBotCandidate({ bots: [seedBot], groups: [] })).toBe(seedBot);
  expect(isUntouchedSeedThread(seedPage)).toBe(true);
});
it("keeps an existing workspace established", async () => {
  const { seedBotCandidate, isUntouchedSeedThread } = await import("./onboarding-progress");
  // more than one bot, a room, a profile the person wrote, a second task
  expect(seedBotCandidate({ bots: [seedBot, { ...seedBot, id: "b2", threadId: "t2" }], groups: [] })).toBeNull();
  expect(seedBotCandidate({ bots: [seedBot], groups: [{ id: "g1" }] })).toBeNull();
  expect(seedBotCandidate({ bots: [{ ...seedBot, title: "Operations lead" }], groups: [] })).toBeNull();
  expect(seedBotCandidate({ bots: [{ ...seedBot, description: "Keeps the week moving." }], groups: [] })).toBeNull();
  expect(seedBotCandidate({ bots: [{ ...seedBot, tasks: [{}, {}] }], groups: [] })).toBeNull();
  // the person has said something, or there is history beyond this page
  expect(isUntouchedSeedThread({ messages: [...seedPage.messages, { role: "user", kind: "text", text: "Help me plan my week" }] })).toBe(false);
  expect(isUntouchedSeedThread({ ...seedPage, hasMore: true })).toBe(false);
  expect(isUntouchedSeedThread({ messages: [...seedPage.messages, { role: "bot", kind: "activity" }] })).toBe(false);
  // unreadable answers never send an existing user back to the welcome
  expect(isUntouchedSeedThread(null)).toBe(false);
  expect(isUntouchedSeedThread({ messages: "nope" })).toBe(false);
});
