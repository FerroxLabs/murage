// X1 (settings v10): one answer to "may this build show a purchase action", asked at create (pauseActions), draw (SpendPauseCard) and
// activate (the Billing click in PluginsPanel). On a Store build (the native phone shell) none of them offers or opens a purchase page.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPurchasePage, opensPurchasePages } from "./native-shell";
import { pauseActions } from "./spend-pause";
import { SpendPauseCard } from "@/components/SpendPauseCard";

// A stale action list (cached or built by an older producer) reaches the card: the draw step must still refuse.
const forced = vi.hoisted(() => ({ on: false }));
vi.mock("./spend-pause", async (original) => {
  const real = await original<typeof import("./spend-pause")>();
  return { ...real, pauseActions: (...args: Parameters<typeof real.pauseActions>) => (forced.on ? ["openFlux", "check"] : real.pauseActions(...args)) };
});
const asStoreBuild = () => vi.stubGlobal("navigator", { userAgent: "MurageApp/1.2 (iPhone)" });
afterEach(() => { vi.unstubAllGlobals(); forced.on = false; });

describe("purchase eligibility is one answer at every producer", () => {
  it("a Store build creates no openFlux action for any hold; a browser or desktop keeps it", () => {
    const holds = [{ kind: "flux", limit: "monthly_tokens" }, { kind: "unknown", noAccount: true }] as never;
    expect(opensPurchasePages()).toBe(true);
    expect(pauseActions(holds)).toContain("openFlux");
    asStoreBuild();
    expect(opensPurchasePages()).toBe(false);
    expect(pauseActions(holds)).not.toContain("openFlux");
    expect(pauseActions(holds)).toContain("check");
  });

  it("the click opens nothing on a Store build, even if a stale action reached the handler", async () => {
    const open = vi.fn(async () => {});
    expect(await openPurchasePage(open)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    asStoreBuild();
    expect(await openPurchasePage(open)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("the drawn card shows the purchase link on a desktop or browser and not on a Store build (draw agrees with create)", () => {
    const status = { limitUsd: 5, held: [{ credentialId: "account", botName: "Dax", emailOnly: false, holds: [{ kind: "flux", limit: "monthly_tokens" }] }] } as never;
    forced.on = true;
    const draw = () => renderToStaticMarkup(createElement(SpendPauseCard, { status, onOpenUsage: () => {}, onRefresh: () => {} }));
    expect(draw()).toContain("https://fluxrouter.ai");
    asStoreBuild();
    const html = draw();
    expect(html).not.toContain("fluxrouter.ai");
    expect(html).toContain("data-spend-pause");
  });

  it("the Billing click is wrapped by the predicate in the panel", () => {
    expect(readFileSync("src/components/PluginsPanel.tsx", "utf8")).toMatch(/openPurchasePage\(\(\) => openExternalPage\(FLUXROUTER_BILLING_URL/);
  });
});
