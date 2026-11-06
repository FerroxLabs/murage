// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The meter gate's ordering (designs/UX-L2C-METER-PULL-1019.md, r3): answers that overlap a key change never bring
// an old key's figure back, in this meter or another one; a failed read is the message, never $0.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { matchedSpend } from "@/lib/spend-meter";
import {
  createMeterGate, isRetired, joinRetirement, noteConfigFingerprint, noteConfigResponse, resetMeterGatesForTest,
  type HeldAnswer, type MeterGate,
} from "./MonthCard";

const total = (spentUsd: number) => ({ state: "ok" as const, spentUsd, asOf: "2026-11-04T10:00:00Z", resetsAt: "2026-12-01T00:00:00Z" });
const answer = (fingerprint: string | null, spentUsd: number) => ({ fingerprint, total: total(spentUsd) });

interface Meter { gate: MeterGate; shown: Array<HeldAnswer | null>; rereads: number; setFp(fp: string | null): void; fp(): string | null; screen(): unknown }

/** One mounted meter: the hook's fingerprint ref, its held answer and the render guard, without React. */
function meter(start: string | null): Meter {
  let fp = start;
  const m: Meter = {
    shown: [], rereads: 0,
    fp: () => fp,
    gate: createMeterGate({ fingerprint: () => fp, show: (a) => { m.shown.push(a); }, reread: () => { m.rereads += 1; } }),
    // The hook's fingerprint effect: note the move, void everything in flight.
    setFp(next) { fp = next; noteConfigFingerprint(next); m.gate.voidAll(); },
    screen() {
      const held = m.shown.at(-1) ?? null;
      return matchedSpend(held && held.asked === fp && !isRetired(fp) ? held.body : null, fp);
    },
  };
  joinRetirement(m.gate);
  return m;
}
const figures = (m: Meter) => m.shown.map((a) => (a?.body as { total?: { spentUsd?: number } } | undefined)?.total?.spentUsd ?? null);

beforeEach(() => { resetMeterGatesForTest(); });

describe("meter gate ordering (r3)", () => {
  it("two reads in flight, key changes between them, newest lands first: the old figure never shows", () => {
    const m = meter("F_old");
    const a = m.gate.issue(); // asked under the old key
    const b = m.gate.issue(); // the server's key moved before this one answered
    m.gate.settle(b, answer("F_new", 5));
    expect(isRetired("F_old")).toBe(true);
    expect(m.rereads).toBe(1);
    m.gate.settle(a, answer("F_old", 99));
    expect(figures(m)).not.toContain(99);
    expect(m.screen()).toEqual({ state: "pending" });
  });

  it("the same race in a second meter that only has the old read in flight: the retirement voids it", () => {
    const one = meter("F_old");
    const two = meter("F_old");
    const a2 = two.gate.issue();
    const b1 = one.gate.issue();
    one.gate.settle(b1, answer("F_new", 5));
    two.gate.settle(a2, answer("F_old", 99));
    expect(figures(two)).not.toContain(99);
    expect(two.screen()).toEqual({ state: "pending" });
    expect(one.screen()).toEqual({ state: "pending" });
  });

  it("the config frame lands while a read is in flight: that read is void and the new key's read shows", () => {
    const m = meter("F_old");
    const a = m.gate.issue();
    m.setFp("F_new");
    m.gate.settle(a, answer("F_old", 99));
    const b = m.gate.issue();
    m.gate.settle(b, answer("F_new", 7));
    expect(figures(m)).not.toContain(99);
    expect(m.screen()).toEqual(total(7));
  });

  it("an answer whose key differs after the config moved since asking is dropped and retires nothing", () => {
    let fp = "F_old";
    const shown: Array<HeldAnswer | null> = [];
    let rereads = 0;
    const gate = createMeterGate({ fingerprint: () => fp, show: (x) => { shown.push(x); }, reread: () => { rereads += 1; } });
    const a = gate.issue();
    fp = "F_new"; // the ref moved on render; the effect has not run yet
    gate.settle(a, answer("F_x", 3));
    expect(isRetired("F_new")).toBe(false);
    expect(isRetired("F_old")).toBe(false);
    expect(rereads).toBe(0);
    expect(shown).toEqual([null]);
  });

  it("404, 503, offline or malformed is the message, never $0, and clears a figure that was shown", () => {
    const m = meter("F");
    const ok = m.gate.issue();
    m.gate.settle(ok, answer("F", 12));
    expect(m.screen()).toEqual(total(12));
    for (const bad of [undefined, null, { error: "not found" }, "x", { fingerprint: 5 }]) {
      const t = m.gate.issue();
      m.gate.settle(t, bad);
      expect(m.screen()).toEqual({ state: "pending" });
    }
    expect(figures(m)).not.toContain(0);
  });

  it("a superseded failure does nothing", () => {
    const m = meter("F");
    const a = m.gate.issue();
    const b = m.gate.issue();
    m.gate.settle(b, answer("F", 12));
    m.gate.settle(a);
    expect(m.screen()).toEqual(total(12));
  });

  it("retirement recovery: a retired key that comes back (restart, same key) shows only on a read issued after a config response with it", () => {
    const m = meter("F_old");
    const b = m.gate.issue();
    m.gate.settle(b, answer("F_new", 5)); // retire F_old
    const early = m.gate.issue(); // issued before any config response
    m.gate.settle(early, answer("F_old", 9));
    expect(m.screen()).toEqual({ state: "pending" });
    expect(isRetired("F_old")).toBe(true);
    expect(m.rereads).toBe(2); // the retirement's config re-read, then again while still retired
    noteConfigResponse("F_old"); // the config re-read says the server is back on F_old
    const later = m.gate.issue();
    m.gate.settle(later, answer("F_old", 9));
    expect(isRetired("F_old")).toBe(false);
    expect(m.screen()).toEqual(total(9));
  });

  it("a config response with another fingerprint does not bring a retired one back", () => {
    const m = meter("F_old");
    m.gate.settle(m.gate.issue(), answer("F_new", 5));
    noteConfigResponse("F_other");
    m.gate.settle(m.gate.issue(), answer("F_old", 9));
    expect(isRetired("F_old")).toBe(true);
    expect(figures(m)).not.toContain(9);
  });

  it("null-fingerprint recovery: a cleared fingerprint shows the message, and the meter shows again once the config re-read lands", () => {
    const m = meter("F_old");
    m.setFp(null); // settings save
    m.gate.settle(m.gate.issue(), answer("F_old", 99));
    expect(figures(m)).not.toContain(99);
    expect(m.screen()).toEqual({ state: "pending" });
    noteConfigResponse("F_new");
    m.setFp("F_new");
    m.gate.settle(m.gate.issue(), answer("F_new", 4));
    expect(m.screen()).toEqual(total(4));
  });

  it("a late config rollback brings the old fingerprint back: never the old figure", () => {
    const m = meter("F_old");
    m.gate.settle(m.gate.issue(), answer("F_new", 5)); // retire F_old
    m.setFp("F_new"); // frame: clears the retirement
    expect(isRetired("F_old")).toBe(false);
    m.setFp("F_old"); // a late /api/config with the old fingerprint
    const t = m.gate.issue();
    m.gate.settle(t, answer("F_new", 5)); // the server answers its current key
    expect(m.screen()).toEqual({ state: "pending" });
    expect(isRetired("F_old")).toBe(true);
    expect(figures(m)).not.toContain(99);
  });

  it("the hook writes its held answer only through settle, and asks for the config while its fingerprint is cleared", () => {
    const src = readFileSync(fileURLToPath(new URL("./MonthCard.tsx", import.meta.url)), "utf8");
    expect(src.match(/\bsetAnswer\b/g)).toHaveLength(2);
    expect(src).toContain("show: setAnswer");
    expect(src.match(/\bdeps\.show\(/g)?.length).toBeGreaterThan(0);
    expect(src).toMatch(/: reread;/);
  });
});

// Flux's month figure leaves out speech, image, search and Composio spend until its caps land: the meter says chat spend.
describe("the meter is labelled as chat spend", () => {
  it("says so on the card and on Usage, in plain words, from en-ux copy", () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const copy = JSON.parse(read("../../locales/en-ux/l2c.json")) as Record<string, string>;
    expect(copy["ux.l2c.month.chatOnly"]).toBe("Counts chat use. Images, voice and search are added soon.");
    expect(copy["ux.l2c.month.billed"]).toMatch(/^Chat spend/);
    expect(copy["ux.l2c.month.ofLimit"]).toMatch(/^Chat spend/);
    expect(Object.values(copy).join("")).not.toContain("—");
    expect(read("./MonthCardView.tsx")).toContain("ux.l2c.month.chatOnly");
    expect(read("../SpendLimitCard.tsx")).toContain("ux.l2c.month.chatOnly");
  });
});
