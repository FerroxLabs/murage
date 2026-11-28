// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vitest";
import {
  expireRingAccount, ringIsWarning, ringOf, type FluxAllowanceWindow, type RingAccount, type RingWindow,
} from "./usage-ring";

test("the ring shows what is left of the tightest account window", () => {
  const nativeWindow = (label: "five-hour" | "weekly", usedPercent: number): RingWindow => ({
    label,
    scope: "account",
    model: null,
    leftPercent: 100 - usedPercent,
    reached: false,
    resetsAt: null,
    expiresAt: null,
    source: "native-event",
    observedAt: 0,
  });
  const account: RingAccount = {
    who: { kind: "owner" },
    windows: [nativeWindow("five-hour", 62), nativeWindow("weekly", 85)],
    status: "current",
    freshUntil: null,
    note: null,
  };
  const ring = ringOf(account, 80, 0);

  expect(ring, "U10 tightest account window").toEqual({
    leftPercent: 15,
    reached: false,
    modelMark: false,
    stale: false,
  });
  expect([50, 80, 90].map(threshold => ringIsWarning(ring, threshold))).toEqual([true, true, false]);
  expect(account.windows.map(window => window.leftPercent)).toEqual([38, 15]);
});

test("nothing known is a placeholder, never full", () => {
  const waiting: RingAccount = { who: { kind: "owner" }, windows: [], status: "waiting", freshUntil: null, note: null };

  expect(ringOf(waiting, 80, 0), "U11 waiting account placeholder").toBeNull();
  expect(waiting.status).toBe("waiting");
});

const accountWindow = (leftPercent: number | null, reached = false): RingWindow => ({
  label: reached ? "other" : "weekly",
  scope: "account",
  model: null,
  leftPercent,
  reached,
  resetsAt: null,
  expiresAt: null,
  source: reached ? "refusal" : "native-event",
  observedAt: 0,
});

test("a live reached account limit beats any percentage", () => {
  const owner: RingAccount = {
    who: { kind: "owner" },
    windows: [accountWindow(null, true), accountWindow(70)],
    status: "current",
    freshUntil: null,
    note: { kind: "refusal", at: 0, resetsAt: null },
  };

  expect(ringOf(owner, 80, 0)?.reached, "U11b reached beats percentage").toBe(true);
});

test("an old reading is faded, never passed off as current", () => {
  const owner = (status: "current" | "stale"): RingAccount => ({
    who: { kind: "owner" },
    windows: [accountWindow(40)],
    status,
    freshUntil: null,
    note: { kind: "native", engine: "codex", observedAt: 0 },
  });

  expect(ringOf(owner("stale"), 80, 0), "U11c stale account faded").toEqual({
    leftPercent: 40,
    reached: false,
    modelMark: false,
    stale: true,
  });
  expect(ringOf(owner("current"), 80, 0)?.stale).toBe(false);
});

const modelLimit: RingWindow = {
  ...accountWindow(null, true),
  scope: "model",
  model: "Example",
  expiresAt: 100,
};

test("a live model limit marks an account with room without driving its fill", () => {
  const owner: RingAccount = {
    who: { kind: "owner" },
    windows: [modelLimit, accountWindow(40)],
    status: "current",
    freshUntil: null,
    note: null,
  };

  expect(ringOf(owner, 80, 99), "U4 model mark with room").toEqual({
    leftPercent: 40, reached: false, modelMark: true, stale: false,
  });
  expect(ringOf(owner, 80, 100)).toMatchObject({ leftPercent: 40, reached: false, modelMark: false });
  expect(ringOf({ ...owner, windows: [modelLimit, accountWindow(0)] }, 80, 99)?.modelMark).toBe(false);
  expect(ringOf({ ...owner, windows: [modelLimit, accountWindow(null)] }, 80, 99)?.modelMark).toBe(false);
  expect(ringOf({ ...owner, windows: [...owner.windows, accountWindow(null, true)] }, 80, 99))
    .toMatchObject({ reached: true, modelMark: false });
  expect(ringOf({ ...owner, windows: [modelLimit] }, 80, 99)).toBeNull();
});

test("a refusal stops striking exactly at expiresAt", () => {
  const refusal = { ...accountWindow(null, true), expiresAt: 100 };
  const owner: RingAccount = {
    who: { kind: "owner" },
    windows: [refusal, accountWindow(70)],
    status: "current",
    freshUntil: null,
    note: { kind: "refusal", at: 0, resetsAt: null },
  };

  expect(ringOf(owner, 80, 99)).toMatchObject({ leftPercent: 70, reached: true });
  expect(ringOf(owner, 80, 100), "expired refusal cannot strike")
    .toMatchObject({ leftPercent: 70, reached: false });
  expect(ringOf({ ...owner, windows: [refusal] }, 80, 100)).toBeNull();
});

test("a current native reading fades at freshUntil", () => {
  const owner: RingAccount = {
    who: { kind: "owner" },
    windows: [accountWindow(40)],
    status: "current",
    freshUntil: 100,
    note: { kind: "native", engine: "codex", observedAt: 0 },
  };

  expect(ringOf(owner, 80, 99)).toMatchObject({ leftPercent: 40, stale: false });
  expect(ringOf(owner, 80, 100), "native freshness boundary").toMatchObject({ leftPercent: 40, stale: true });
});

const fluxAccount = (accountFreshUntil: number, allowanceFreshUntil: number, expiresAt: number): RingAccount => {
  const window: FluxAllowanceWindow = {
    ...accountWindow(41),
    label: "key-allowance",
    model: null,
    scope: "account",
    reached: false,
    resetsAt: null,
    expiresAt,
    source: "flux-allowance",
  };
  return {
    who: { kind: "owner" },
    windows: [window],
    status: "current",
    freshUntil: accountFreshUntil,
    note: {
      kind: "flux",
      allowance: {
        version: 1, state: "ok", budgetUsd: 100, spentUsd: 59, remainingUsd: 41, observedAt: 0,
        freshUntil: allowanceFreshUntil,
      },
      month: { state: "ok", spentUsd: 12.5 },
      personalLimitUsd: 20,
    },
  };
};

test.each([
  ["account freshUntil", 100, 200, 300],
  ["allowance freshUntil", 200, 100, 300],
  ["window expiresAt", 300, 200, 100],
] as const)("Flux becomes spending-only at %s", (deadline, accountFreshUntil, allowanceFreshUntil, expiresAt) => {
  const owner = fluxAccount(accountFreshUntil, allowanceFreshUntil, expiresAt);
  const original = structuredClone(owner);

  expect(ringOf(owner, 80, 99)).toEqual({ leftPercent: 41, reached: false, modelMark: false, stale: false });
  expect(expireRingAccount(owner, 99)).toEqual(original);
  expect(ringOf(owner, 80, 100), `expired Flux fill at ${deadline}`).toBeNull();
  expect(ringOf(owner, 80, 301)).toBeNull();
  expect(expireRingAccount(owner, 100), "expired allowance note is spending-only").toMatchObject({
    windows: [],
    status: "waiting",
    note: {
      kind: "flux",
      allowance: { version: 1, state: "unavailable" },
      month: { state: "ok", spentUsd: 12.5 },
      personalLimitUsd: 20,
    },
  });
  expect(expireRingAccount(owner, 100).note).toEqual({
    kind: "flux",
    allowance: { version: 1, state: "unavailable" },
    month: { state: "ok", spentUsd: 12.5 },
    personalLimitUsd: 20,
  });
  expect(owner).toEqual(original);
});

test("Flux never fades and requires a current allowance note", () => {
  const owner = fluxAccount(100, 100, 100);

  expect(ringOf({ ...owner, status: "stale" }, 80, 99), "Flux never fades")
    .toMatchObject({ leftPercent: 41, stale: false });
  expect(ringOf({ ...owner, note: null }, 80, 99), "Flux window without an allowance note").toBeNull();
  expect(ringOf({
    ...owner,
    note: { kind: "flux", allowance: { version: 1, state: "unavailable" }, month: { state: "checking" }, personalLimitUsd: 20 },
  }, 80, 99)).toBeNull();
});
