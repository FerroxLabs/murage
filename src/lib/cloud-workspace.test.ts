// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

import { checkReachable, cloudChoiceAction, isCloudOrigin, loadCloudWorkspace, type CloudHomeBridge } from "./cloud-workspace";

const bridge = (state: () => Promise<unknown>) => ({ state } as unknown as CloudHomeBridge);

describe("cloud workspace", () => {
  it("detects the Cloud window by protocol only", () => {
    expect(isCloudOrigin({ protocol: "murage-home:" })).toBe(true);
    expect(isCloudOrigin({ protocol: "http:" })).toBe(false);
    expect(isCloudOrigin({ protocol: "https:" })).toBe(false);
    expect(isCloudOrigin(undefined)).toBe(false);
  });

  it("flag off (no bridge, or every call rejects) means the switch stays hidden", async () => {
    expect(await loadCloudWorkspace(undefined)).toEqual({ enabled: false });
    expect(await loadCloudWorkspace(bridge(async () => { throw new Error("No handler registered"); }))).toEqual({ enabled: false });
    expect(await loadCloudWorkspace(bridge(async () => ({ enabled: false })))).toEqual({ enabled: false });
  });

  it("flag on reports sign-in and what is paired", async () => {
    const paired = [{ homeId: "home-1", origin: "https://h.example" }];
    expect(await loadCloudWorkspace(bridge(async () => ({ enabled: true, cpSignedIn: true, paired })))).toEqual({ enabled: true, cpSignedIn: true, paired });
  });

  it("'Cloud home' opens the one paired home, otherwise shows pairing", () => {
    expect(cloudChoiceAction({ enabled: true, cpSignedIn: true, paired: [{ homeId: "a", origin: "x" }] })).toEqual({ kind: "open", homeId: "a" });
    expect(cloudChoiceAction({ enabled: true, cpSignedIn: true, paired: [] })).toEqual({ kind: "pair" });
    expect(cloudChoiceAction({ enabled: true, cpSignedIn: true, paired: [{ homeId: "a", origin: "x" }, { homeId: "b", origin: "y" }] })).toEqual({ kind: "pair" });
  });

  it("reachability never throws; no bridge is fine", async () => {
    expect(await checkReachable(undefined)).toEqual({ ok: true });
    expect(await checkReachable({ reachable: async () => ({ ok: false, code: "unreachable", message: "m" }) } as never)).toEqual({ ok: false, message: "m", code: "unreachable" });
    expect(await checkReachable({ reachable: vi.fn(async () => { throw new Error("x"); }) } as never)).toEqual({ ok: false, message: "" });
  });
});
