// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-L1A-1013, Fable r1 M1 (client side): bot-level "Always" is the
// computer's alone. A Cloud home's paired phone reads as the desktop surface,
// and /api/config says `computer: false` for it, so the card greys the
// bot-level rows and Settings lists bot-level grants read-only there.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const answer = vi.hoisted(() => ({ computer: undefined as boolean | undefined }));
vi.mock("./surface", async (importOriginal) => ({ ...(await importOriginal<object>()), knownComputer: () => answer.computer }));
vi.mock("@/lib/native-shell", () => ({ inNativeShell: () => true }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  const store = { state: { bots: [], instances: [], routines: [] }, dispatch: () => undefined };
  return { ...actual, useStore: () => store, useStoreIfAny: () => store };
});

import { computerHere, resolveComputer } from "./computer-surface";
import { RememberedApprovals } from "@/components/RememberedApprovals";

afterEach(() => {
  answer.computer = undefined;
  delete (globalThis as { muragebox?: unknown }).muragebox;
});

describe("which renderer is the computer", () => {
  it("follows the harness's computer answer on the desktop surface", () => {
    expect(resolveComputer(true, false)).toBe(false); // any Cloud surface
    expect(resolveComputer(true, true)).toBe(true); // the local computer
    expect(resolveComputer(true, undefined)).toBe(true); // an older harness without the field
  });
  it("never widens a remote or unknown surface", () => {
    expect(resolveComputer(false, true)).toBe(false);
    expect(resolveComputer(undefined, true)).toBe(undefined);
  });
  it("a desktop app signed in to a Cloud home has the bridge and is still not the computer (L1A-GRANT-AUTHORITY-1013 3)", () => {
    (globalThis as { muragebox?: unknown }).muragebox = {};
    answer.computer = false;
    expect(computerHere(true)).toBe(false);
  });
  it("reads the answer /api/config carried", () => {
    answer.computer = false;
    expect(computerHere(true)).toBe(false);
    answer.computer = true;
    expect(computerHere(true)).toBe(true);
    expect(computerHere(false)).toBe(false);
  });
});

describe("Settings on a Cloud home's phone lists bot-level grants read-only", () => {
  const BOT = { id: "b1", name: "Nova", taskAllowanceCount: 0, alwaysAllow: ["Bash:git"] };
  const html = (computer: boolean) => renderToStaticMarkup(createElement(RememberedApprovals, { bot: BOT, desktop: true, computer }));
  it("offers Take back on the computer and not on the phone", () => {
    expect(html(true)).toContain('aria-label="Take back: Any git command"');
    expect(html(false)).not.toContain('aria-label="Take back: Any git command"');
    expect(html(false)).toContain("Take back on your computer");
  });
});
