// X1 (settings v10, C11): a paired phone renders no switch for a desktop-class route, the phone Overview request row has no app or account details,
// and the purchase predicate refuses on a Store build for every credit state.
import { describe, expect, it } from "vitest";
import { routeClass } from "./route-policy.ts";
import { mayShowPurchase, phoneMayRenderSwitch, phoneRequestRow, type CreditState } from "../shared/settings-v10/purchase.ts";

describe("X1 phone surface table", () => {
  it("a desktop-class route renders no switch on the phone, a companion-class route does (real route policy)", () => {
    expect(routeClass("PUT", "/api/bots/abc12345/access")).toBe("desktop");
    expect(phoneMayRenderSwitch(routeClass("PUT", "/api/bots/abc12345/access"))).toBe(false);
    expect(phoneMayRenderSwitch(routeClass("PUT", "/api/spend/limit"))).toBe(false);
    expect(routeClass("POST", "/api/bots/abc12345/task-allow/remove")).toBe("companion");
    expect(phoneMayRenderSwitch(routeClass("POST", "/api/bots/abc12345/task-allow/remove"))).toBe(true);
  });
  it("an unlisted route is desktop-only, so the phone renders nothing for it", () => {
    expect(phoneMayRenderSwitch(routeClass("POST", "/api/not-a-route-anyone-wrote"))).toBe(false);
  });
  it("the phone request row drops app and account details", () => {
    const row = phoneRequestRow({ id: "r1", botId: "b1", title: "Send a note", state: "waiting", appName: "Mail", account: "someone@example.test", scopes: ["read"] });
    expect(row).toEqual({ id: "r1", botId: "b1", title: "Send a note", state: "waiting" });
    expect(JSON.stringify(row)).not.toMatch(/Mail|example\.test|scopes/);
  });
  it("a Store build creates no purchase action for any credit state", () => {
    const states: CreditState[] = ["ok", "missing", "low", "zero", "unknown", "offline"];
    for (const credit of states) for (const cloud of [false, true]) expect(mayShowPurchase({ surface: "phone", storeBuild: true, credit, cloud }, "pause-card")).toBe(false);
    expect(mayShowPurchase({ surface: "desktop", storeBuild: false, credit: "zero", cloud: false }, "pause-card")).toBe(true);
    expect(mayShowPurchase({ surface: "desktop", storeBuild: false, credit: "ok", cloud: false }, "pause-card")).toBe(false);
  });
});
