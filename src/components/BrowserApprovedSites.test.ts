// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { BrowserApprovedSitesView } from "./BrowserApprovedSites";

function find(node: ReactNode, predicate: (props: Record<string, any>) => boolean): Record<string, any> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child, predicate); if (hit) return hit; } return; }
  if (!isValidElement(node)) return;
  const p = node.props as Record<string, any>;
  return predicate(p) ? p : find(p.children, predicate);
}
const props = (over: Record<string, unknown> = {}) => ({ botName: "Mira", sites: [{ origin: "https://www.chase.com", rule: "ask" as const }, { origin: "https://example.com", rule: "allow" as const }, { origin: "https://bitwarden.com", rule: "ask" as const }], phone: false, pending: false, error: "", lowering: null as string | null, onSet: vi.fn(), onLowerAsk: vi.fn(), onLowerKeep: vi.fn(), ...over } as any);

describe("lifting a Never site and the end-of-task offer (T34 follow-up)", () => {
  const never = () => props({ sites: [{ origin: "https://bad.example", rule: "never" as const }], liftTarget: null as null | { origin: string; rule: "ask" | "allow" }, onLiftAsk: vi.fn(), onLiftKeep: vi.fn() });
  it("asking to move a Never site opens a warning first and saves nothing", () => {
    const p = never(); find(BrowserApprovedSitesView(p), i => i["data-origin"] === "https://bad.example" && i["data-action"] === "ask")!.onClick();
    expect(p.onSet).not.toHaveBeenCalled(); expect(p.onLiftAsk).toHaveBeenCalledWith("https://bad.example", "ask");
    find(BrowserApprovedSitesView(p), i => i["data-origin"] === "https://bad.example" && i["data-action"] === "allow")!.onClick(); expect(p.onLiftAsk).toHaveBeenLastCalledWith("https://bad.example", "allow"); expect(p.onSet).not.toHaveBeenCalled();
  });
  it("the warning says what lifting means; Lift Never saves the chosen rule, Keep Never saves nothing", () => {
    const p = { ...never(), liftTarget: { origin: "https://bad.example", rule: "allow" as const } };
    const html = renderToStaticMarkup(createElement(BrowserApprovedSitesView, p)); expect(html).toContain("Let Mira use https://bad.example?"); expect(html).toContain("Never list");
    const tree = BrowserApprovedSitesView(p); find(tree, i => i["data-confirm"] === "lift")!.onClick(); expect(p.onSet).toHaveBeenCalledWith("https://bad.example", "allow");
    find(tree, i => i["data-confirm"] === "keepNever")!.onClick(); expect(p.onLiftKeep).toHaveBeenCalled();
  });
  it("the phone cannot lift a Never site", () => {
    expect(find(BrowserApprovedSitesView({ ...never(), phone: true }), i => i["data-action"] === "ask" || i["data-action"] === "allow")).toBeUndefined();
  });
  it("end-of-task offer: Allow always for a normal site used in the task, and No thanks dismisses; none for a bank or a site already allowed", () => {
    const offers = ["https://shop.example", "https://www.chase.com", "https://example.com"];
    const p = props({ offers, onOffer: vi.fn(), onDismissOffer: vi.fn() }); const html = renderToStaticMarkup(createElement(BrowserApprovedSitesView, p));
    expect(html).toContain("Mira used https://shop.example in this task. Allow it always?"); expect(html).not.toContain("used https://www.chase.com"); expect(html).not.toContain("used https://example.com");
    const tree = BrowserApprovedSitesView(p);
    find(tree, i => i["data-offer"] === "allow" && i["data-origin"] === "https://shop.example")!.onClick(); expect(p.onSet).toHaveBeenCalledWith("https://shop.example", "allow");
    find(tree, i => i["data-offer"] === "no" && i["data-origin"] === "https://shop.example")!.onClick(); expect(p.onDismissOffer).toHaveBeenCalledWith("https://shop.example");
  });
  it("no offer on the phone", () => { expect(renderToStaticMarkup(createElement(BrowserApprovedSitesView, props({ phone: true, offers: ["https://shop.example"] })))).not.toContain("Allow it always?"); });
});

describe("approved sites", () => {
  it("badges a bank as Asks each step and a password manager as a site you use yourself", () => {
    const html = renderToStaticMarkup(createElement(BrowserApprovedSitesView, props()));
    expect(html).toContain("Approved sites"); expect(html).toContain("Asks each step"); expect(html).toContain("You use this site yourself"); expect(html).toContain("These lists cannot cover every site.");
  });
  it("Always allow, Ask, Never and Revoke send the exact origin and rule", () => {
    const p = props(); const tree = BrowserApprovedSitesView(p);
    const row = (origin: string, label: string) => find(tree, i => i["data-origin"] === origin && i["data-action"] === label)!;
    row("https://example.com", "never").onClick(); expect(p.onSet).toHaveBeenLastCalledWith("https://example.com", "never");
    row("https://example.com", "revoke").onClick(); expect(p.onSet).toHaveBeenLastCalledWith("https://example.com", "ask");
    row("https://www.chase.com", "allow").onClick(); expect(p.onSet).toHaveBeenLastCalledWith("https://www.chase.com", "allow");
  });
  it("a handover site offers no actions", () => {
    const tree = BrowserApprovedSitesView(props()); expect(find(tree, i => i["data-origin"] === "https://bitwarden.com" && i["data-action"])).toBeUndefined();
  });
  it("lowering an ask-every-step site opens the confirm first; Work normally here lowers, Keep asking does not", () => {
    const p = props(); find(BrowserApprovedSitesView(p), i => i["data-origin"] === "https://www.chase.com" && i["data-action"] === "lower")!.onClick(); expect(p.onSet).not.toHaveBeenCalled(); expect(p.onLowerAsk).toHaveBeenCalledWith("https://www.chase.com");
    const open = props({ lowering: "https://www.chase.com" }); const tree = BrowserApprovedSitesView(open);
    expect(renderToStaticMarkup(createElement(BrowserApprovedSitesView, open))).toContain("Let Mira work normally on https://www.chase.com?");
    find(tree, i => i["data-confirm"] === "work")!.onClick(); expect(open.onSet).toHaveBeenCalledWith("https://www.chase.com", "ask", true);
    find(tree, i => i["data-confirm"] === "keep")!.onClick(); expect(open.onLowerKeep).toHaveBeenCalled();
  });
  it("the phone can only Revoke", () => {
    const tree = BrowserApprovedSitesView(props({ phone: true }));
    expect(find(tree, i => i["data-origin"] === "https://example.com" && i["data-action"] === "revoke")).toBeTruthy();
    for (const a of ["allow", "never", "lower"]) expect(find(tree, i => i["data-action"] === a)).toBeUndefined();
  });
});

describe("the lowered-sites note (revoke-site follow-up)", () => {
  it("says in plain words that the Allow always sites went back to Ask, and dismisses", () => {
    const onDismissLowered = vi.fn();
    const p = props({ loweredNote: true, onDismissLowered });
    const html = renderToStaticMarkup(createElement(BrowserApprovedSitesView, p));
    expect(html).toContain("A save did not finish, so Murage set your Always allow sites back to Ask.");
    find(BrowserApprovedSitesView(p), i => i["data-action"] === "dismiss-lowered")!.onClick(); expect(onDismissLowered).toHaveBeenCalled();
  });
  it("shows nothing by default", () => { expect(renderToStaticMarkup(createElement(BrowserApprovedSitesView, props()))).not.toContain("A save did not finish"); });
});
