// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The backups row loads on first use, and the backup step must not wait for
// it: setup ends verified, so anything that could keep the step from starting
// is the last thing to get wrong. This renders the closing card with a row
// chunk that never arrives, takes the card away at once, and checks that the
// step still asked the desktop for its backup status.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({ pending: [] as Array<() => void | (() => void)>, cleanups: [] as Array<() => void> }));
// A static render runs no effects, so they are queued and run right after it,
// the way a mount runs them after the commit; their cleanups are kept so the
// test can unmount the card by running them.
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useEffect: (effect: () => void | (() => void)) => { effects.pending.push(effect); },
  };
});
// The row's chunk never arrives.
vi.mock("./FirstRunBackupsRow", () => {
  return new Promise(() => {});
});
vi.mock("@/state/store", () => ({ api: async () => ({}), useStore: () => ({ state: {}, dispatch: () => {} }) }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => false }));

afterEach(() => { vi.unstubAllGlobals(); });

describe("the first-run backup step does not wait for the row's chunk", () => {
  it("starts on mount and keeps going after the card unmounts, before the chunk resolves", async () => {
    const calls: string[] = [];
    let answer: (status: unknown) => void = () => {};
    // On but with nothing checked behind it: the step goes on to take a
    // backup. The status answer is held until after the card has gone.
    const backupSchedule = {
      status: () => { calls.push("status"); return new Promise((resolve) => { answer = resolve; }); },
      runNow: async () => { calls.push("runNow"); throw new Error("held by the test"); },
    };
    vi.stubGlobal("window", { muragebox: { backupSchedule } });
    const { FirstRunNextCard } = await import("./FirstRunNextCard");
    const markup = renderToStaticMarkup(createElement(FirstRunNextCard, { bot: { id: "chief", threadId: undefined } as never }));
    // Mount: the effects run once, after the render.
    for (const effect of effects.pending.splice(0)) {
      const cleanup = effect();
      if (typeof cleanup === "function") effects.cleanups.push(cleanup);
    }
    expect(calls).toEqual(["status"]);
    // Unmount, with the row's chunk still not arrived.
    for (const cleanup of effects.cleanups.splice(0)) cleanup();
    answer({ supported: true, enabled: true, pending: false, revision: 1, firstRun: { eligible: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The step carried on without the card: it went on to take the backup.
    expect(calls).toEqual(["status", "runNow"]);
    expect(markup).not.toContain("Setting up your backups");
  });
});
