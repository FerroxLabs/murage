// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022-idlerest W-MOUNTS-IDLE (HIDDEN-COST-opus section 1, wipe/mounts.ts:105): the mount inventory was refreshed every 60 s from import,
// forever (on darwin one /sbin/mount spawn each time), with no wipe guard ever started. It is now read at start and at a guard's admission.
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetModules(); });

it("ten idle minutes: 0 mount inventory refreshes; a wipe guard admission refreshes a stale inventory once", async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const mounts = await import("./mounts.ts");
  const refresh = vi.spyOn(mounts.mountedRoots, "refresh").mockImplementation(() => undefined);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(refresh, "mount refreshes in ten idle minutes").toHaveBeenCalledTimes(0);
  // the effect is kept: a wipe guard's admission (the real turn entry, its guard start stood in for) reads a stale inventory first, so a
  // mount that appeared while idle is in the roots the guard protects
  refresh.mockImplementation(() => { mounts.mountedRoots.add("/fixture-mount-1022"); });
  const { wipeGuardTurnEnvironment } = await import("../drivers/murage-exec-wipe.ts");
  const admit = async () => {
    let roots: readonly string[] = [];
    const turn = { threadId: "t", text: "fixture", cwd: "/work/fixture", noLimits: true as const,
      warmIdentity: { botId: "b", audience: "owner" as const, decidedOwner: true }, permissionNow: () => ({ noLimits: true as const }) };
    await wipeGuardTurnEnvironment({ turn: turn as never, turnId: `turn-${Math.random()}`, env: { PATH: "/usr/bin" }, signal: new AbortController().signal,
      isLive: () => true, subscribe: () => () => {}, posixShell: true, installShim: () => "/work/fixture-shim",
      start: (async (options: { roots: readonly string[] }) => { roots = options.roots; return { file: "/work/fixture-guard", end: async () => {} }; }) as never });
    return roots;
  };
  expect(await admit()).toContain("/fixture-mount-1022");
  expect(refresh).toHaveBeenCalledTimes(1);
  // a second admission inside the minute reuses it
  await admit();
  expect(refresh).toHaveBeenCalledTimes(1);
});
