// SPDX-License-Identifier: AGPL-3.0-or-later
// Red-first tests (lane 0162-chromereal): disclosure rule, protected list, free reads.
import { describe, it, expect } from "vitest";
import { BrowserExtensionPolicy, PROTECTED_DOMAINS, type BrowserAction } from "./browser-extension-policy.ts";
import { PROTECTED_DOMAINS as SHARED } from "../shared/browser-protected-domains.ts";
function fixture(url = "https://example.com/page?x=1") {
  const policy = new BrowserExtensionPolicy({ now: () => 1000 });
  const context = policy.bind({ bindingId: "binding", workspaceId: "workspace", botId: "bot", threadId: "thread", clientId: "client", profileId: "profile" });
  const document = { profileId: "profile", tabId: 1, frameId: 0, navigationEpoch: 1, origin: "https://example.com" };
  policy.share(context, document, url);
  policy.setSiteAccess(context, document.origin, "allow"); policy.setSiteAccess(context, "https://sink.test", "allow");
  const nav = (destination: string, extra: Partial<BrowserAction> = {}): BrowserAction => ({ operation: "navigate", document, targetDigest: "a".repeat(64), destination, ...extra });
  return { policy, context, document, nav };
}
describe("Astra 3: disclosure through a URL path", () => {
  it("a cross-origin navigation that carries a path, query or fragment needs approval", () => {
    const f = fixture();
    for (const destination of ["https://sink.test/collect/PRIVATE-CANARY", "https://sink.test/?data=PRIVATE-CANARY", "https://sink.test/#PRIVATE-CANARY", "https://sink.test/a/b?c=d#e"]) expect(f.policy.check(f.context, f.nav(destination)).requiresApproval, destination).toBe(true);
  });
  it("a cross-origin navigation to the bare origin still does not", () => {
    const f = fixture(); expect(f.policy.check(f.context, f.nav("https://sink.test/")).requiresApproval).toBe(false); expect(f.policy.check(f.context, f.nav("https://sink.test")).requiresApproval).toBe(false);
  });
  it("same-origin navigation to another path needs approval once page data was read, unless the page itself presents the link", () => {
    const f = fixture(); const target = "https://example.com/send/PRIVATE-CANARY";
    expect(f.policy.check(f.context, f.nav(target)).requiresApproval).toBe(false); // nothing read yet: nothing page-derived to carry
    expect(f.policy.check(f.context, f.nav(target, { pageDataRead: true })).requiresApproval).toBe(true);
    expect(f.policy.check(f.context, f.nav(target, { pageDataRead: true, presentedLink: true })).requiresApproval).toBe(false);
    expect(f.policy.check(f.context, f.nav("https://example.com/other?q=PRIVATE", { pageDataRead: true })).requiresApproval).toBe(true);
  });
  it("reloading or moving within the same document (same path and query) is free", () => {
    const f = fixture();
    expect(f.policy.check(f.context, f.nav("https://example.com/page?x=1", { pageDataRead: true })).requiresApproval).toBe(false);
    expect(f.policy.check(f.context, f.nav("https://example.com/page?x=1#section", { pageDataRead: true })).requiresApproval).toBe(false);
  });
  it("the flags are part of the approval digest", () => {
    const f = fixture(); const a = f.policy.check(f.context, f.nav("https://example.com/z", { pageDataRead: true })).digest, b = f.policy.check(f.context, f.nav("https://example.com/z", { pageDataRead: true, presentedLink: true })).digest;
    expect(a).not.toBe(b);
  });
});
describe("Fable M3 (partial): scroll, focus and hover are free on an allowed site", () => {
  it("need no approval and take no write lease", () => {
    const f = fixture();
    for (const operation of ["scroll", "focus", "hover"]) { const checked = f.policy.check(f.context, { operation, document: f.document, targetDigest: "a".repeat(64) }); expect(checked.requiresApproval, operation).toBe(false); expect(checked.mutation, operation).toBe(false); }
    expect(f.policy.check(f.context, { operation: "click", document: f.document, targetDigest: "a".repeat(64) }).requiresApproval).toBe(true);
  });
});
describe("Fable M2: one protected-domain list", () => {
  it("the server list is the shared list, and includes what only the extension knew", () => {
    expect([...PROTECTED_DOMAINS]).toEqual([...SHARED]);
    const f = fixture();
    // T21: only the handover category (password managers, stores) is closed in the policy; banks are ask-every-step and reach the service.
    for (const host of ["my.dashlane.com", "vault.bitwarden.com", "chromewebstore.google.com"]) expect(() => f.policy.setSiteAccess(f.context, `https://${host}`, "allow"), host).toThrow("handover_required");
    for (const host of ["www.citibank.com", "login.citi.com", "x.capitalone.com"]) expect(() => f.policy.setSiteAccess(f.context, `https://${host}`, "allow"), host).not.toThrow();
  });
  it("carries the ported FoundryInChrome list: banks, brokers, crypto, health, government, payroll, e-signing, SSO", async () => {
    const { isProtectedHostname, PROTECTED_DOMAINS } = await import("../shared/browser-protected-domains.ts");
    expect(PROTECTED_DOMAINS.length).toBeGreaterThan(200);
    for (const host of ["www.coinbase.com", "login.fidelity.com", "my.mychart.com", "www.irs.gov", "secure.ssa.gov", "app.gusto.com", "app.docusign.com", "acme.okta.com", "link.plaid.com", "www.usbank.com", "online.hsbc.co.uk", "mybank.bank", "x.insurance", "base.mil", "service.gov.uk", "tax.gouv.fr", "www.proton.me", "dashboard.stripe.com", "chromewebstore.google.com"]) expect(isProtectedHostname(host), host).toBe(true);
    for (const host of ["example.com", "notchase.com", "chase.com.evil.test", "gov.example.com", "news.test", "localhost", "127.0.0.1", ""]) expect(isProtectedHostname(host), host).toBe(false);
  });
});
