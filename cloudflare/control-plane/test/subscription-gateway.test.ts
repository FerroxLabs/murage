// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra JOURNEY-BCORE-6 #1: ONE gateway for every Stripe subscription write (src/subscription-gateway.ts writeSubscription). This scans every
// source file (recursively): no file other than the gateway and the client names a raw StripeClient subscription mutation, so a new writer
// cannot bypass parking.
import { describe, expect, it } from "vitest";
import gateway from "../src/subscription-gateway.ts?raw";

// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const ALL_SOURCES = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
/** Every StripeClient method that writes a subscription (b5-stripe.ts: POST or DELETE /v1/subscriptions/:id). */
const RAW_WRITES = ["cancelSubscription", "setCancelAtPeriodEnd", "setCancelAt", "setTrialEnd", "setPauseCollection", "changeSubscriptionPrice"];
const GATEWAY = "src/subscription-gateway.ts";
/** The client itself (it defines them) and the gateway (the one caller). Matched by path under src/, so a nested file of the same name is not exempt. */
const EXEMPT = ["src/b5-stripe.ts", GATEWAY];
const rel = (p: string) => p.slice(p.indexOf("src/"));

describe("the subscription-write gateway is the only caller of a raw subscription mutation", () => {
  it("scans every source file of the control plane, nested ones included (not vacuous)", () => {
    expect(Object.keys(ALL_SOURCES).length).toBeGreaterThan(50);
    expect(Object.keys(ALL_SOURCES).some((p) => rel(p) === GATEWAY)).toBe(true);
  });
  it("no other file names cancelSubscription / setCancelAtPeriodEnd / setCancelAt / setTrialEnd / setPauseCollection / changeSubscriptionPrice", () => {
    // Astra JOURNEY-BCORE-7 #7: the raw names ANYWHERE in the text (a call, a destructured or renamed alias of the client, a type, a comment):
    // no position is excused. Computed names built from pieces are left to the entry-point tests (customer-journey-b, JOURNEY-BCORE-7 #7).
    const named = new RegExp(`\\b(${RAW_WRITES.join("|")})\\b`, "g");
    const stray: string[] = [];
    for (const [path, src] of Object.entries(ALL_SOURCES)) {
      if (EXEMPT.includes(rel(path))) continue;
      for (const m of src.matchAll(named)) stray.push(`${rel(path)}: ${m[0]}`);
    }
    expect(stray).toEqual([]);
  });
  it("the gateway fences the caller's lease and reads the parked predicate before it calls Stripe", () => {
    const body = gateway.slice(gateway.indexOf("export async function writeSubscription"), gateway.indexOf("export const unparkQs"));
    const fenceAt = body.indexOf("await fence(env, lease)");
    const parkedAt = body.indexOf("if (await scheduleParked(env, subscriptionId)) return { parked: true }");
    const firstCall = Math.min(...RAW_WRITES.filter((w) => body.includes(`stripe.${w}(`)).map((w) => body.indexOf(`stripe.${w}(`)));
    expect(fenceAt).toBeGreaterThan(-1);
    expect(parkedAt).toBeGreaterThan(fenceAt);
    expect(firstCall).toBeGreaterThan(parkedAt);
  });
});
