// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra r2: a zone change whose routine write fails stays pending. It is tried
// again before routines dispatch and by a save of the same zone, and the save
// says routines have not moved yet.
import { describe, expect, it } from "vitest";
import { createOwnerZoneReconciler } from "./owner-zone-reconcile.ts";

function rig() {
  const calls: Array<{ offWallClockOnly?: boolean; since?: number }> = [];
  const warnings: string[] = [];
  let failing = false;
  let now = 0;
  const reconciler = createOwnerZoneReconciler(
    () => (options) => { calls.push(options); if (failing) throw new Error("disk full"); return []; },
    (message) => warnings.push(message),
    () => now,
  );
  return { reconciler, calls, warnings, fail: (value: boolean) => { failing = value; }, advance: (ms: number) => { now += ms; } };
}

describe("the owner zone reconciler", () => {
  it("starts with a boot pass that moves only routines off their wall-clock time, once", () => {
    const r = rig();
    expect(r.reconciler.pending()).toBe("boot");
    expect(r.reconciler.reconcile()).toBe(true);
    expect(r.reconciler.reconcile()).toBe(true);
    expect(r.calls).toEqual([{ offWallClockOnly: true, since: 0 }]);
    expect(r.reconciler.pending()).toBeNull();
  });

  it("keeps a failed change pending, holds dispatch until it lands, and answers the save with false", () => {
    const r = rig();
    r.reconciler.reconcile();
    r.fail(true);
    expect(r.reconciler.changed("UTC", "America/Chicago")).toBe(false);
    expect(r.reconciler.pending()).toBe("change");
    // before routines dispatch: tried again, still failing, so dispatch waits
    expect(r.reconciler.reconcile()).toBe(false);
    expect(r.warnings).toHaveLength(1);
    r.fail(false);
    expect(r.reconciler.reconcile()).toBe(true);
    expect(r.reconciler.pending()).toBeNull();
    expect(r.calls.slice(1)).toEqual([{ offWallClockOnly: false, since: 0 }, { offWallClockOnly: false, since: 0 }, { offWallClockOnly: false, since: 0 }]);
  });

  it("keeps the moment of the first boot pass across its retries", () => {
    const r = rig();
    r.advance(1_000);
    r.fail(true);
    expect(r.reconciler.reconcile()).toBe(false);
    r.advance(360_000);
    r.fail(false);
    expect(r.reconciler.reconcile()).toBe(true);
    expect(r.calls).toEqual([{ offWallClockOnly: true, since: 1_000 }, { offWallClockOnly: true, since: 1_000 }]);
  });

  it("keeps the moment of the change across retries, so a time that came due meanwhile still moves", () => {
    const r = rig();
    r.reconciler.reconcile();
    r.advance(5_000);
    r.fail(true);
    expect(r.reconciler.changed("UTC", "America/Chicago")).toBe(false);
    r.advance(360_000);
    r.fail(false);
    expect(r.reconciler.changed("America/Chicago", "America/New_York")).toBe(true);
    expect(r.calls.at(-1)).toEqual({ offWallClockOnly: false, since: 5_000 });
    // the next change starts from its own moment
    r.advance(1_000);
    r.reconciler.changed("America/New_York", "UTC");
    expect(r.calls.at(-1)).toEqual({ offWallClockOnly: false, since: 366_000 });
  });

  it("retries a pending change when the same zone is saved again, and does nothing for a same-zone save otherwise", () => {
    const r = rig();
    r.reconciler.reconcile();
    expect(r.reconciler.changed("America/Chicago", "America/Chicago")).toBe(true);
    expect(r.calls).toHaveLength(1);
    r.fail(true);
    expect(r.reconciler.changed("UTC", "America/Chicago")).toBe(false);
    r.fail(false);
    expect(r.reconciler.changed("America/Chicago", "America/Chicago")).toBe(true);
    expect(r.calls).toHaveLength(3);
    expect(r.reconciler.pending()).toBeNull();
  });

  it("writes one warning a minute while a write keeps failing", () => {
    const r = rig();
    r.fail(true);
    for (let i = 0; i < 5; i++) r.reconciler.reconcile();
    expect(r.warnings).toHaveLength(1);
    r.advance(60_000);
    r.reconciler.reconcile();
    expect(r.warnings).toHaveLength(2);
    expect(r.reconciler.pending()).toBe("boot");
  });
});
