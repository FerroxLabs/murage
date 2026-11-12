// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WHEN THE WELCOME SHOWS (C4, C5), and its words. The rule is a pure function of the setup view and one in-memory
// flag, so it is pinned with fixtures for every kind of install.

import { beforeEach, describe, expect, it } from "vitest";

import type { SetupStep, SetupView } from "../../shared/setup";
import { FIRST_RUN_WELCOME, forgetWelcomeSeen, markWelcomeSeen, welcomeFootLine, welcomeShouldShow } from "./first-run-welcome";

function step(id: SetupStep, status: "done" | "skipped" | "blocked" | "open") {
  return { id, status, skipped: status === "skipped" } as unknown as SetupView["steps"][number];
}

/** A view shaped like the server's. Defaults to a brand-new install that has not touched hello. */
function view(over: Partial<SetupView> & { hello?: "done" | "skipped" | "blocked" | "open" } = {}): SetupView {
  const { hello = "open", ...rest } = over;
  return {
    version: 3,
    startedAt: 1,
    ownerName: "",
    firstRun: true,
    conversationLive: true,
    next: "hello",
    steps: [step("hello", hello), step("detect", "open"), step("flux", "open"), step("chat", "open"), step("flow", "open")],
    ...rest,
  } as unknown as SetupView;
}

beforeEach(() => forgetWelcomeSeen());

describe("C4 welcome shows only when firstRun is true and hello is untouched", () => {
  it("shows on a brand-new install", () => {
    expect(welcomeShouldShow(view(), false)).toBe(true);
  });
  it("shows while hello is blocked or open, never once it is done or skipped", () => {
    expect(welcomeShouldShow(view({ hello: "blocked" }), false)).toBe(true);
    expect(welcomeShouldShow(view({ hello: "done" }), false)).toBe(false);
    expect(welcomeShouldShow(view({ hello: "skipped" }), false)).toBe(false);
  });
  it("does not show when firstRun is false", () => {
    expect(welcomeShouldShow(view({ firstRun: false }), false)).toBe(false);
  });
  it("does not show before the view has answered", () => {
    expect(welcomeShouldShow(null, false)).toBe(false);
    expect(welcomeShouldShow(undefined, false)).toBe(false);
  });
  it("does not show for a view with no hello step", () => {
    expect(welcomeShouldShow(view({ steps: [step("detect", "open")] }), false)).toBe(false);
  });
  it("once seen this session it stays gone, and a fresh session shows it again", () => {
    expect(welcomeShouldShow(view(), false)).toBe(true);
    markWelcomeSeen();
    expect(welcomeShouldShow(view(), true)).toBe(false);
    forgetWelcomeSeen();
    expect(welcomeShouldShow(view(), false)).toBe(true);
  });
});

describe("C5 welcome never shows for a restored backup, a saved name, or an existing transcript", () => {
  it("restored backup: the server says firstRun is false", () => {
    expect(welcomeShouldShow(view({ firstRun: false, hello: "done", ownerName: "Sean", conversationLive: false, next: null }), false)).toBe(false);
  });
  it("a saved name hides it even if every other signal says first run", () => {
    expect(welcomeShouldShow(view({ ownerName: "Sean" }), false)).toBe(false);
    expect(welcomeShouldShow(view({ ownerName: "   " }), false)).toBe(true);
  });
  it("an existing transcript where hello is already answered or skipped", () => {
    expect(welcomeShouldShow(view({ hello: "done", conversationLive: true }), false)).toBe(false);
    expect(welcomeShouldShow(view({ hello: "skipped", conversationLive: true }), false)).toBe(false);
  });
  it("a returning user with a finished setup", () => {
    expect(welcomeShouldShow(view({ firstRun: false, hello: "done", conversationLive: false, next: null, complete: true }), false)).toBe(false);
  });
});

describe("the words", () => {
  it("are the approved lines, plain, with the version on the foot", () => {
    expect(FIRST_RUN_WELCOME.lead).toBe("Your own team of bots,");
    expect(FIRST_RUN_WELCOME.line).toBe("doing real work on your computer.");
    expect(FIRST_RUN_WELCOME.start).toBe("Get started");
    expect(welcomeFootLine("1.0.19")).toBe("Murage 1.0.19");
  });
});
