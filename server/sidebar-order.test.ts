// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The sidebar's section order, kept on the computer so every device shows the
// same one. The HTTP route is covered in sidebar-order-api.test.ts.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SIDEBAR_ORDER_MAX_ENTRIES } from "../shared/sidebar-order.ts";
import { SidebarOrderStore, parseSidebarOrderRequest, sidebarOrderForSurface } from "./sidebar-order.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murage-sidebar-order-"));
});
const file = () => join(dir, "sidebar-order.json");

describe("SidebarOrderStore", () => {
  it("has no order until one is saved", () => {
    expect(new SidebarOrderStore(dir).current()).toBeNull();
  });

  it("persists a saved order across a restart, owner-only", () => {
    const first = new SidebarOrderStore(dir);
    expect(first.save(["section:Sean's Office", "builtin:pinned"], { initial: false })).toEqual({
      order: ["section:Sean's Office", "builtin:pinned"],
      changed: true,
    });
    const restarted = new SidebarOrderStore(dir);
    expect(restarted.current()).toEqual(["section:Sean's Office", "builtin:pinned"]);
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("an initial upload lands only when the computer has no order yet", () => {
    const store = new SidebarOrderStore(dir);
    expect(store.save(["b", "a"], { initial: true })).toEqual({ order: ["b", "a"], changed: true });
    // A second first-load (another desktop window) never replaces it.
    expect(store.save(["a", "b"], { initial: true })).toEqual({ order: ["b", "a"], changed: false });
    expect(new SidebarOrderStore(dir).current()).toEqual(["b", "a"]);
  });

  it("an explicit save replaces the order and keeps ids the saver did not mention", () => {
    const store = new SidebarOrderStore(dir);
    store.save(["a", "hidden", "b"], { initial: false });
    expect(store.save(["b", "a"], { initial: false })).toEqual({ order: ["b", "a", "hidden"], changed: true });
    expect(store.save(["b", "a"], { initial: false }).changed).toBe(false);
  });

  it("treats a damaged or oversized file as no order, and repairs it on the next save", () => {
    writeFileSync(file(), "{not json");
    expect(new SidebarOrderStore(dir).current()).toBeNull();
    writeFileSync(file(), JSON.stringify({ order: Array.from({ length: SIDEBAR_ORDER_MAX_ENTRIES + 1 }, (_, i) => `s${i}`) }));
    const store = new SidebarOrderStore(dir);
    expect(store.current()).toBeNull();
    store.save(["a"], { initial: true });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ order: ["a"] });
  });

  it("stays bounded however many teams come and go", () => {
    const store = new SidebarOrderStore(dir);
    for (let round = 0; round < 5; round += 1) {
      store.save(Array.from({ length: 60 }, (_, i) => `section:r${round}-${i}`), { initial: false });
    }
    expect(store.current()!.length).toBeLessThanOrEqual(SIDEBAR_ORDER_MAX_ENTRIES);
  });
});

describe("parseSidebarOrderRequest", () => {
  it("reads { order } and { order, initial: true }", () => {
    expect(parseSidebarOrderRequest({ order: ["section:Ops"] })).toEqual({ ok: true, order: ["section:Ops"], initial: false });
    expect(parseSidebarOrderRequest({ order: ["builtin:pinned"], initial: true })).toEqual({ ok: true, order: ["builtin:pinned"], initial: true });
  });

  it("does not store ids the sidebar could never produce, without refusing the rest", () => {
    // A device's older local copy may carry an id this build does not know;
    // refusing the whole save would leave that device unable to save at all.
    expect(parseSidebarOrderRequest({ order: ["builtin:made-up", "section:Ops", "Ops", "section: "], initial: true }))
      .toEqual({ ok: true, order: ["section:Ops"], initial: true });
  });

  it("refuses other shapes and unknown fields", () => {
    for (const body of [
      { order: "a" },
      { order: [""] },
      { order: ["section:a"], initial: "yes" },
      { order: ["section:a"], botIds: ["x"] },
      { order: Array.from({ length: SIDEBAR_ORDER_MAX_ENTRIES + 1 }, (_, i) => `section:${i}`) },
    ]) {
      expect(parseSidebarOrderRequest(body).ok, JSON.stringify(body).slice(0, 60)).toBe(false);
    }
  });
});

describe("sidebarOrderForSurface", () => {
  const roster = {
    bots: [
      { section: "Ops" },
      { section: "Vault", hidden: true },
      { section: "Vault", hidden: true },
      {},
    ],
    groups: [
      { section: "Studio" },
      { section: "Machine Room", dm: true },
    ],
  };
  const full = ["section:Vault", "section:Ops", "builtin:pinned", "section:Machine Room", "section:Studio", "section:Empty"];

  it("gives the desktop the whole order", () => {
    expect(sidebarOrderForSurface(full, "desktop", roster)).toEqual(full);
  });

  it("gives a phone or browser only the fixed sections and the teams it can see", () => {
    expect(sidebarOrderForSurface(full, "remote", roster)).toEqual(["section:Ops", "builtin:pinned", "section:Studio"]);
    expect(sidebarOrderForSurface(null, "remote", roster)).toBeNull();
  });

  it("a filtered device's drag keeps the hidden teams where they were", () => {
    const store = new SidebarOrderStore(dir);
    store.save(full, { initial: false });
    const phoneView = sidebarOrderForSurface(store.current(), "remote", roster)!;
    const dragged = [phoneView[2]!, phoneView[0]!, phoneView[1]!];
    const saved = store.save(sidebarOrderForSurface(dragged, "remote", roster)!, { initial: false });
    // Each hidden team stays next to the neighbour it had: Vault before Ops,
    // Machine Room after Pinned, Empty after Studio.
    expect(saved.order).toEqual(["section:Studio", "section:Empty", "section:Vault", "section:Ops", "builtin:pinned", "section:Machine Room"]);
    for (const hidden of ["section:Vault", "section:Machine Room", "section:Empty"]) expect(saved.order).toContain(hidden);
  });
});
