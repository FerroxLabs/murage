// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { canOpenSetupTerminal, checkAgainMessage } from "./engine-setup-check";

const doc = (homeId: string | null) => ({ querySelector: (q: string) => (q.includes("murage-home-id") && homeId ? { getAttribute: () => homeId } : null) }) as unknown as Pick<Document, "querySelector">;

describe("the setup Terminal button (item 167)", () => {
  it("shows on the desktop and hides on a Cloud home", () => {
    expect(canOpenSetupTerminal({ openEngineSetupTerminal: () => {} }, doc(null))).toBe(true);
    expect(canOpenSetupTerminal({ openEngineSetupTerminal: () => {} }, doc("home-1"))).toBe(false);
  });
  it("needs the desktop bridge", () => {
    expect(canOpenSetupTerminal(undefined, doc(null))).toBe(false);
    expect(canOpenSetupTerminal({}, doc(null))).toBe(false);
  });
});

describe("Check again after an install (item 167)", () => {
  const base = { signInOnly: false, installStarted: true, cloudIntent: true };
  it("confirms the installed CLI by name and version", () => {
    expect(checkAgainMessage({ displayName: "Kimi", snapshot: { state: "available", authenticated: true, version: "1.2.3" } }, base)).toBe("Kimi is installed (1.2.3). Select a model to test it with a task.");
  });
  it("says it is still not found, with the reason, after an install was started", () => {
    expect(checkAgainMessage({ displayName: "Kimi", snapshot: { state: "unavailable", reason: "`kimi` is not installed, or Murage cannot find it on this computer" } }, base))
      .toBe("Kimi is still not detected after the install. `kimi` is not installed, or Murage cannot find it on this computer");
  });
  it("without an install started, keeps the plain wording", () => {
    expect(checkAgainMessage({ displayName: "Kimi", snapshot: { state: "unavailable", reason: "r" } }, { ...base, installStarted: false })).toBe("r");
    expect(checkAgainMessage({ displayName: "Kimi", snapshot: { state: "available", authenticated: true } }, { ...base, installStarted: false })).toBe("Engine detected. Select a model to test it with a task.");
  });
  it("a found CLI that still needs sign-in asks for it", () => {
    expect(checkAgainMessage({ displayName: "Kimi", snapshot: { state: "available", authenticated: false } }, base)).toBe("Engine detected. Finish sign-in, then check again.");
  });
});
