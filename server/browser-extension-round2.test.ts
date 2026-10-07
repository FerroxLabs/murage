// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { h, page, runRecipientScan, realCollectFacts, gmailChat } from "./testing/chat-dom-fixture.ts";
import { collectFloorFacts } from "./browser-floor-facts.ts";
import { readWithBrowserAuthority } from "./browser-extension-engine-read.ts";
// @ts-ignore fixture HTML only; no browser is launched
import { PAGES } from "../scripts/browser-extension-fixture-site/pages.mjs";

describe("Round 2: recipient scan applicability", () => {
  it.each(["button", "a"])("a plain %s has no recipients and no failed scan", async tag => {
    const el = h(tag, tag === "a" ? { href: "/file", download: "receipt.txt" } : {}, "Continue");
    page(el);
    expect(runRecipientScan(el)).toMatchObject({ recipients: [], incomplete: false });
    const facts = await realCollectFacts(() => el)(null, null, "click");
    expect(facts.recipientScanFailed).toBeUndefined();
  });
  it("a dialog answer does not run a DOM recipient scan", async () => {
    for (const operation of ["dialog_accept", "dialog_dismiss"]) {
      const facts = await collectFloorFacts({ world: async () => { throw Error("no DOM"); }, send: async () => { throw Error("no DOM"); } }, undefined, operation, { dialog: { kind: "confirm", text: "Continue?" } });
      expect(facts.recipientScanFailed).toBeUndefined();
      expect(facts.factsFailed).toBeUndefined();
    }
  });
  it("a recipient widget outside a form is still scanned", async () => {
    const el = h("button", {}, "Send");
    page(h("input", { type: "email", value: "ana@example.com" }), el);
    expect(runRecipientScan(el)).toMatchObject({ recipients: ["ana@example.com"], incomplete: false });
  });
  it("a form with zero inventory controls adds no recipient decision", async () => {
    const el = h("button", { type: "submit" }, "Send");
    page(h("form", {}, el));
    expect((await realCollectFacts(() => el)(null, null, "click")).recipientScanFailed).toBeUndefined();
  });
  it("a real incomplete scan and a chat composer still need the recipient decision", async () => {
    const el = h("button", {}, "Send");
    page(h("form", {}, h("input"), h("iframe"), el));
    expect((await realCollectFacts(() => el)(null, null, "click")).recipientScanFailed).toBe(true);
    const chat = gmailChat();
    expect((await realCollectFacts(() => chat.send)(null, null, "click")).recipientScanFailed).toBe(true);
  });
});

describe("Round 2: bounded large-page read", () => {
  it("explains the bound and exposes the last fixture row through the advertised filter", async () => {
    const html = PAGES.find((p: any) => p.id === "t3-rows").html();
    const ctx = { currentUrl: "https://fixture.test/t3-rows", fenceOrigin: "https://fixture.test", activeHtml: async () => html, authorize: () => true, admitUrl: async () => {} };
    const first = await readWithBrowserAuthority({}, ctx);
    expect(first.structuredContent.truncated).toBe(true);
    expect(first.content[0].text).not.toContain("Product 5000");
    expect(first.content[0].text).toMatch(/read.*filter/);
    expect(first.content[0].text.length).toBeLessThan(20400);
    const last = await readWithBrowserAuthority({ filter: "Product 5000" }, ctx);
    expect(last.structuredContent.truncated).toBe(false);
    expect(last.content[0].text).toContain("Product 5000");
  });
});
