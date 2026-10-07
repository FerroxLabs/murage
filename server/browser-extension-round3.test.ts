// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { h, page, runRecipientScan, realCollectFacts, type FakeNode } from "./testing/chat-dom-fixture.ts";
import { checkIntent } from "./browser-intent.ts";

function composer(fields: FakeNode[]) {
  const send = h("button", {}, "Send");
  const root = h("div", {}, ...fields, send);
  const host = h("div");
  const p = page(host);
  Object.assign(root, { nodeType: 11, host, getElementById: (id: string) => root.all().find(n => n.id === id) });
  Object.assign(host, { shadowRoot: root });
  for (const n of root.all()) Object.assign(n, { ownerDocument: p.doc, getRootNode: () => root });
  return send;
}

async function expectDecision(send: FakeNode) {
  const facts = await realCollectFacts(() => send)(null, null, "click");
  const input = { ownerWords: ["Send my message"], taskSites: new Set(["https://chat.example"]), readOrigins: new Map(), probeFlagged: false,
    mode: "full" as const, visibility: facts.visibility!, counters: { hits: 0 },
    action: { operation: "click", level: "L3" as const, origin: "https://chat.example", recipients: facts.recipients, recipientScanFailed: facts.recipientScanFailed, recipientNoField: facts.recipientNoField } };
  expect(checkIntent(input)).toMatchObject({ result: "card", rule: "I2" });
  expect(checkIntent({ ...input, counters: { hits: 2 } })).toMatchObject(facts.recipientScanFailed ? { result: "refuse", rule: "I7" } : { result: "card", rule: "I2" });
}

describe("Round 3: recipient applicability and accessible names", () => {
  it.each(["r", "a b c r"])("review page: plain inputs in an open root, labelledby=%s", async ids => {
    const send = composer([h("span", { id: "r" }, "To"), ...["a", "b", "c"].map(id => h("span", { id }, "Name")),
      h("input", { type: "text", "aria-labelledby": ids, value: "unrequested@example.com" }), h("input", { type: "text" })]);
    expect(runRecipientScan(send).recipients).toEqual(["unrequested@example.com"]);
    await expectDecision(send);
  });
  it.each(["for", "wrapping"])("resolves a %s label in the same root", async kind => {
    const field = h("input", { id: "r", value: "unrequested@example.com" });
    const label = kind === "for" ? h("label", { for: "r" }, "To") : h("label", {}, "To", field);
    Object.defineProperty(field, "labels", { get: () => [label] });
    const send = composer(kind === "for" ? [label, field] : [label]);
    expect(runRecipientScan(send).recipients).toEqual(["unrequested@example.com"]);
    await expectDecision(send);
  });
  it("resolves a recipient combobox through aria-labelledby", async () => {
    const send = composer([h("span", { id: "r" }, "To"), h("div", { role: "combobox", "aria-labelledby": "r" }, "unrequested@example.com")]);
    expect(runRecipientScan(send).recipients).toEqual(["unrequested@example.com"]);
    await expectDecision(send);
  });
  it.each(["aria-label", "placeholder", "title"])("matches a recipient through %s", async name => {
    const send = composer([h("input", { [name]: "To", value: "unrequested@example.com" })]);
    expect(runRecipientScan(send).recipients).toEqual(["unrequested@example.com"]);
    await expectDecision(send);
  });
  it("a missing accessible-name reference is unknown", async () => {
    const send = composer([h("input", { "aria-labelledby": "missing" })]);
    expect(runRecipientScan(send)).toMatchObject({ incomplete: true, noRecipientField: false });
    await expectDecision(send);
  });
  it("secret names after the third label reference still prevent value extraction", () => {
    const send = composer([...['a', 'b', 'c'].map(id => h('span', { id }, 'To')), h('span', { id: 'secret' }, 'Password'),
      h('input', { 'aria-labelledby': 'a b c secret', value: 'private@example.com' })]);
    expect(runRecipientScan(send).recipients).toEqual([]);
  });
  it.each([h("input"), ...["text", "email", "search", "tel", "url"].map(type => h("input", { type })), h("textarea"),
    h("div", { contenteditable: "true" }), h("div", { role: "textbox" }), h("div", { role: "textbox", contenteditable: "true", "aria-multiline": "true" }), h("div", { role: "combobox" })])("unclassified text entry cannot mean no field: %j", async field => {
    const send = composer([field]);
    // Email and tel are positively identified recipient controls, even when empty.
    if (["email", "tel"].includes(field.type)) {
      expect(runRecipientScan(send)).toMatchObject({ noRecipientField: false });
    } else {
      expect(runRecipientScan(send)).toMatchObject({ incomplete: true, noRecipientField: false });
      await expectDecision(send);
    }
  });
  it("an unclassified field stays incomplete beside an identified recipient", () => {
    const send = composer([h("input", { type: "email", value: "ana@example.com" }), h("input")]);
    expect(runRecipientScan(send)).toMatchObject({ recipients: ["ana@example.com"], incomplete: true, noRecipientField: false });
  });
  it.each([h("a", { href: "/next" }, "Next"), h("button", { "aria-haspopup": "dialog" }, "Open dialog"), h("a", { href: "/file", download: "receipt.txt" }, "Download")])("Round 2 plain action still has no recipient failure: %j", async target => {
    page(target);
    expect(runRecipientScan(target)).toMatchObject({ recipients: [], incomplete: false });
    if (target.localName === "a") expect(runRecipientScan(target)).toMatchObject({ sendCapable: false });
    else expect(runRecipientScan(target)).toMatchObject({ noRecipientField: true });
    expect((await realCollectFacts(() => target)(null, null, "click")).recipientScanFailed).toBeUndefined();
  });
});
