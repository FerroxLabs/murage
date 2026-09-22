// The sentence that would have ended an hour of misdiagnosis in two seconds.
//
// On 2026-09-22 the server crashed and the window stayed open looking healthy.
// The owner and his Chief of Staff worked through nine subsystems — browser,
// memory, tools, connected apps, the phone, message queueing — before anyone
// checked whether the engine was alive. It was not. There was one fault.
import { describe, expect, it } from "vitest";

import { serverLifecycleNotice } from "./ServerLifecycleBanner";

describe("what the app says when its engine is not running", () => {
  it("says nothing at all while it is running", () => {
    // Furniture is not read. A banner that is always on screen is furniture.
    expect(serverLifecycleNotice({ state: "running", since: null, attempt: 0 })).toBeNull();
  });

  it("says nothing before the first report arrives", () => {
    // No bridge means no desktop server to report on: browser, dev, companion.
    expect(serverLifecycleNotice(null)).toBeNull();
  });

  it("tells them it is coming back, and what happens to their work", () => {
    const notice = serverLifecycleNotice({ state: "restarting", since: 1, attempt: 1 });
    expect(notice?.tone).toBe("working");
    // The actual question a person has while their bots stop mid-sentence.
    expect(notice?.text).toContain("pick up where they left off");
    expect(notice?.text, "they installed Murage, not a server").toContain("Murage");
    expect(notice?.text.toLowerCase(), "no plumbing words").not.toContain("server child");
  });

  it("tells them plainly when it cannot recover, and what to do", () => {
    const notice = serverLifecycleNotice({ state: "failed", since: 1, attempt: 4 });
    expect(notice?.tone).toBe("stopped");
    expect(notice?.text, "an instruction, not a status").toContain("Quit and open it again");
  });

  it("never reports a failure as though it were recovering", () => {
    const failed = serverLifecycleNotice({ state: "failed", since: 1, attempt: 4 });
    const restarting = serverLifecycleNotice({ state: "restarting", since: 1, attempt: 1 });
    expect(failed?.tone).not.toBe(restarting?.tone);
    expect(failed?.text).not.toBe(restarting?.text);
  });

  it("is readable, in both states", () => {
    for (const state of ["restarting", "failed"] as const) {
      const notice = serverLifecycleNotice({ state, since: 1, attempt: 1 });
      expect(notice?.text.length, `${state}: must be a sentence somebody can read`).toBeGreaterThan(40);
      expect(notice?.text, `${state}: must end as a sentence`).toMatch(/[.!?]$/);
    }
  });
});

// COPY A STRANGER HAS TO BE ABLE TO READ.
//
// The stopped banner shipped saying "tell Sean what you were doing". That is
// useful on one machine and meaningless on every other, and the app has
// channels, teams and a companion in it precisely so other people use it.
//
// The rule is not "never write a name": it is that a notice shown to whoever
// happens to be looking cannot address one person by their first name. The
// control below is that ordinary words survive, so this cannot be satisfied
// by deleting the sentence.
describe("what the banner can say to somebody who is not the owner", () => {
  const every = [
    serverLifecycleNotice({ state: "restarting", since: 0, attempt: 1 }),
    serverLifecycleNotice({ state: "failed", since: 0, attempt: 4 }),
  ];

  it("addresses nobody by name", () => {
    for (const notice of every) {
      expect(notice!.text, notice!.tone).not.toMatch(/\bSean\b/);
    }
  });

  it("still says what happened and what to do about it", () => {
    // The negative control. An empty string passes the test above.
    for (const notice of every) {
      expect(notice!.text.length, notice!.tone).toBeGreaterThan(40);
      expect(notice!.text, "it is Murage that stopped, not 'the server'").toContain("Murage");
    }
    expect(every[1]!.text, "and the stopped one points at the evidence").toMatch(/server\.log/);
  });

  it("keeps the house copy rules the release is gated on", () => {
    for (const notice of every) {
      expect(notice!.text, "no em or en dashes").not.toMatch(/[—–]/);
      expect(notice!.text.toLowerCase()).not.toContain("composio");
    }
  });
});
