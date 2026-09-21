import { describe, expect, it } from "vitest";
import { firstRunImportAllowed, isUntouchedSeedThread, seedBotCandidate } from "./seed-workspace";

const seed = { threadId: "t1", title: "", description: "", tasks: [{ threadId: "t1" }] };
const opening = [{ role: "bot", kind: "text", text: "Hello." }, { role: "bot", kind: "options", card: {} }];

describe("first-run starter import", () => {
  it("goes ahead on an empty workspace and on one holding only the untouched seeded bot", () => {
    expect(firstRunImportAllowed({ bots: [], groups: [] }, () => [])).toBe(true);
    expect(firstRunImportAllowed({ bots: [seed], groups: [] }, id => (id === "t1" ? opening : []))).toBe(true);
  });
  it("is refused once the person has used the workspace", () => {
    const said = [...opening, { role: "user", kind: "text", text: "Help me plan my week" }];
    expect(firstRunImportAllowed({ bots: [seed], groups: [] }, () => said)).toBe(false);
    expect(firstRunImportAllowed({ bots: [seed, { ...seed, threadId: "t2" }], groups: [] }, () => opening)).toBe(false);
    expect(firstRunImportAllowed({ bots: [seed], groups: [{ id: "g1" }] }, () => opening)).toBe(false);
    expect(firstRunImportAllowed({ bots: [{ ...seed, title: "Operations lead" }], groups: [] }, () => opening)).toBe(false);
    expect(firstRunImportAllowed({ bots: [seed], groups: [] }, () => [...opening, { role: "bot", kind: "activity" }])).toBe(false);
  });
});

// THESE TWO CAME BACK HERE FROM src/lib/onboarding-progress.test.ts.
//
// That file re-exported both helpers from this one so the deleted welcome
// screen could import them from a client path, and its tests were the only
// DIRECT cover either helper had. The re-export is gone with the screen; the
// cover is not, because several of these cases never reach
// `firstRunImportAllowed`: it calls `isUntouchedSeedThread` with a page it
// built itself, so `null`, a non-array `messages` and `hasMore: true` are
// unreachable from above and were tested nowhere else.
describe("what counts as the untouched seeded workspace", () => {
  const seedBot = { id: "b1", threadId: "t1", name: "Ember", title: "", description: "", tasks: [{ threadId: "t1" }] };
  const seedPage = { messages: [...opening], hasMore: false };

  it("treats the untouched seeded bot as a first run", () => {
    expect(seedBotCandidate({ bots: [seedBot], groups: [] })).toBe(seedBot);
    expect(isUntouchedSeedThread(seedPage)).toBe(true);
  });

  it("keeps an existing workspace established", () => {
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
});
