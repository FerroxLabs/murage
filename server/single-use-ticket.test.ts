import { describe, expect, it } from "vitest";

import { createTicketStore } from "./single-use-ticket.ts";

describe("single-use tickets", () => {
  it("redeem once, for their principal, before they expire", () => {
    let now = 1_000;
    const store = createTicketStore({ ttlMs: 10, now: () => now });
    const a = store.mint("desktop GET /api/x");
    expect(store.redeem(a, "desktop GET /api/y")).toBe(false);
    expect(store.redeem(a, "desktop GET /api/x")).toBe(false); // spent by the wrong attempt
    const b = store.mint("desktop GET /api/x");
    expect(store.redeem(b, "desktop GET /api/x")).toBe(true);
    expect(store.redeem(b, "desktop GET /api/x")).toBe(false);
    const c = store.mint("p");
    now += 11;
    expect(store.redeem(c, "p")).toBe(false);
  });

  it("keeps at most maxOutstanding unredeemed, dropping the oldest", () => {
    const store = createTicketStore({ ttlMs: 60_000, maxOutstanding: 2 });
    const first = store.mint("p");
    const second = store.mint("p");
    const third = store.mint("p");
    expect(store.size()).toBe(2);
    expect(store.redeem(first, "p")).toBe(false);
    expect(store.redeem(second, "p")).toBe(true);
    expect(store.redeem(third, "p")).toBe(true);
  });
});
