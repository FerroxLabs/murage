// SPDX-License-Identifier: AGPL-3.0-or-later
import { domFunction } from "./testing/native-dom-fixture.ts";
// H3 (Opus security review): the I2 recipients scan must read chips, contenteditable, hidden inputs and open shadow roots, and a scan
// that is incomplete (a cap, an oversized value, a frame, a closed root or unknown widget, or no recipient field) is UNKNOWN, never none.
import { describe, expect, it } from "vitest";
import { COLLECT_RECIPIENTS_SOURCE } from "./browser-floor-facts.ts";

class Node_ {
  nodeType = 1;
  parentNode: Node_ | null = null; host: Node_ | null = null; children: Node_[] = []; shadowRoot: Node_ | null = null; childNodes: { nodeType: number; textContent: string }[] = [];
  id = ""; name = ""; value = ""; type = ""; labels: { textContent: string }[] = []; ownerDocument: unknown = {}; form: Node_ | null = null; textContent = "";
  constructor(public localName: string, public attrs: Record<string, string> = {}, text = "") {
    this.id = attrs.id ?? ""; this.name = attrs.name ?? ""; this.type = attrs.type ?? ""; this.value = attrs.value ?? "";
    if (text) { this.childNodes.push({ nodeType: 3, textContent: text }); this.textContent = text; }
  }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  add(...kids: Node_[]) { for (const k of kids) { k.parentNode = this; this.children.push(k); this.textContent += k.textContent; } return this; }
  attach(root: Node_) { root.nodeType = 11; root.host = this; this.shadowRoot = root; return this; }
}
const el = (tag: string, attrs: Record<string, string> = {}, text = "") => new Node_(tag, attrs, text);
const send = () => el("button", { "aria-label": "Send" });
const scan = (build: (button: Node_) => Node_ | null) => {
  const button = send(); const root = build(button) ?? button; button.ownerDocument = { body: root, documentElement: root };
  const g = globalThis as any; const before = g.getComputedStyle; g.getComputedStyle = () => ({ webkitTextSecurity: "none" });
  try { return (domFunction(`return (${COLLECT_RECIPIENTS_SOURCE});`)() as () => { recipients: string[]; incomplete: boolean }).call(button); } finally { g.getComputedStyle = before; void root; }
};
const form = (...kids: Node_[]) => { const f = el("form"); f.add(...kids); return f; };

describe("H3: the recipients scan", () => {
  it("reads recipient chips whose input is empty", () => {
    const result = scan(button => form(el("div", { "aria-label": "To" }).add(el("input", { "aria-label": "To recipients", value: "" }), el("span", { email: "attacker@evil.example" })), button));
    expect(result.recipients).toContain("attacker@evil.example");
  });
  it("reads a contenteditable recipient line", () => {
    const result = scan(button => form(el("div", { contenteditable: "true", "aria-label": "Recipients" }, "attacker@evil.example"), button));
    expect(result.recipients).toContain("attacker@evil.example");
  });
  it("reads a hidden input with a recipient name", () => {
    const result = scan(button => form(el("input", { type: "hidden", name: "to", value: "attacker@evil.example" }), button));
    expect(result.recipients).toContain("attacker@evil.example");
  });
  it("reads fields inside an open shadow root", () => {
    const shadow = el("#shadow-root").add(el("input", { name: "to", value: "attacker@evil.example" }));
    const result = scan(button => form(el("x-composer").attach(shadow), button));
    expect(result.recipients).toContain("attacker@evil.example");
  });
  it("a send button with no form or dialog ancestor still sees the page's recipient field", () => {
    const body = el("body").add(el("input", { name: "to", value: "attacker@evil.example" }));
    const result = scan(button => { body.add(button); return body; });
    expect(result.recipients).toContain("attacker@evil.example");
  });
  it("no recipient field anywhere in scope is unknown, not none", () => {
    expect(scan(button => form(el("input", { name: "subject", value: "hello" }), button)).incomplete).toBe(true);
  });
  it("a complete scan says so", () => {
    const result = scan(button => form(el("input", { name: "to", value: "ana@example.com" }), button));
    expect(result).toMatchObject({ recipients: ["ana@example.com"], incomplete: false });
  });
  it("overflow is unknown: twenty known addresses cannot push a Bcc off the list", () => {
    const many = Array.from({ length: 25 }, (_, i) => `u${i}@example.com`).join(",");
    expect(scan(button => form(el("input", { name: "to", value: many }), button)).incomplete).toBe(true);
  });
  it("an oversized value or token is unknown, not skipped", () => {
    expect(scan(button => form(el("input", { name: "to", value: "a@b.co " + "x".repeat(2100) }), button)).incomplete).toBe(true);
    expect(scan(button => form(el("input", { name: "to", value: "y".repeat(300) + "@evil.example" }), button)).incomplete).toBe(true);
  });
  it("closed roots stay with the inspector; frames remain unknown", () => {
    expect(scan(button => form(el("input", { name: "to", value: "ana@example.com" }), el("x-picker"), button)).incomplete).toBe(false);
    expect(scan(button => form(el("input", { name: "to", value: "ana@example.com" }), el("iframe"), button)).incomplete).toBe(true);
  });
  it("reads addresses and numbers from recipient-like fields, as typed, and nothing from a subject", () => {
    const result = scan(button => form(el("input", { name: "to", value: "ana@example.com, bo@example.org" }), el("input", { type: "email", id: "x", value: "cy@example.net" }), el("input", { name: "subject", value: "hi there friend@home" }), el("input", { "aria-label": "Phone number", value: "555 123 4567" }), button));
    expect(result.recipients).toEqual(["ana@example.com", "bo@example.org", "cy@example.net", "555 123 4567"]);
  });
  it("keeps a hidden or look-alike character exactly as typed, which is what I2 looks for", () => {
    const sneaky = "ana\u200B@example.com";
    expect(scan(button => form(el("input", { name: "cc", value: sneaky }), button)).recipients).toEqual([sneaky]);
  });
  it("never reads a password, code or card field, even if its name looks like a recipient", () => {
    const result = scan(button => form(el("input", { type: "password", name: "to", value: "a@b.co" }), el("input", { name: "email-otp", value: "x@y.zz" }), el("input", { autocomplete: "cc-number", name: "to", value: "4111@1111" }), button));
    expect(result.recipients).toEqual([]);
  });

  describe("re-review: a spurious word match is not a recipient field, and name-only chips are unknown", () => {
    it("a Back to inbox link, a Share button and a Reply to thread link do not make the scan complete", () => {
      const result = scan(button => form(el("input", { name: "subject", value: "hello" }), el("a", { "aria-label": "Back to inbox" }, "Back to inbox"), el("button", { "aria-label": "Share" }, "Share"), el("a", { id: "reply-to-thread" }, "Reply to thread"), button));
      expect(result.incomplete).toBe(true);
    });
    it("a To region of name-only chips next to a Back to inbox link is unknown", () => {
      const result = scan(button => form(el("textarea", { name: "message" }), el("div", { role: "group", "aria-label": "To" }).add(el("span", {}, "Ana Silva"), el("span", {}, "Bo Chen")), el("a", { "aria-label": "Back to inbox" }, "Back to inbox"), button));
      expect(result.incomplete).toBe(true);
    });
    it("a region whose chips carry the address only in an aria-label has it read", () => {
      const result = scan(button => form(el("textarea", { name: "message" }), el("div", { role: "group", "aria-label": "To" }).add(el("span", { "aria-label": "attacker@evil.example" }, "Ana Silva")), button));
      expect(result.recipients).toContain("attacker@evil.example");
      expect(result.incomplete).toBe(false);
    });
    it("a To region with address chips and a Back to inbox link is complete", () => {
      const result = scan(button => form(el("textarea", { name: "message" }), el("div", { role: "group", "aria-label": "To" }).add(el("span", { email: "ana@example.com" }, "Ana Silva")), el("a", { "aria-label": "Back to inbox" }, "Back to inbox"), button));
      expect(result).toMatchObject({ recipients: ["ana@example.com"], incomplete: false });
    });
    it("an empty To region with only its input is still complete and nobody", () => {
      const result = scan(button => form(el("div", { role: "group", "aria-label": "To" }).add(el("input", { "aria-label": "To recipients", value: "" })), button));
      expect(result).toMatchObject({ recipients: [], incomplete: false });
    });
    it("a chip with a display name and no address, outside any labelled region, is unknown", () => {
      const result = scan(button => form(el("input", { name: "to", value: "" }), el("span", { "data-recipient": "Ana Silva" }, "Ana Silva"), button));
      expect(result.incomplete).toBe(true);
    });
  });
  describe("chat composers: positive classification", () => {
    const flag = (build: (button: Node_) => Node_ | null) => (scan(build) as { composerOnly?: boolean }).composerOnly;
    it("is set only for positively classified composers after a complete scan", () => {
      expect(flag(button => form(el("textarea", { name: "message", value: "hello" }), button))).toBe(true);
    });
    it("is not set when a recipient-like label exists without a recognised field (unknown recipients, not a chat), but a Back to inbox link is still a chat", () => {
      expect(flag(button => form(el("textarea", { name: "message", value: "hi" }), el("div", { "aria-label": "To recipients" }, "Ana"), button))).toBe(false);
      expect(flag(button => form(el("textarea", { name: "message", value: "hi" }), el("a", { "aria-label": "Back to inbox" }, "Back to inbox"), button))).toBe(true);
    });
    it("is not set when any recipient field exists, a frame was seen, or a chip had no address", () => {
      expect(flag(button => form(el("input", { name: "to", value: "" }), button))).toBe(false);
      expect(flag(button => form(el("textarea", { name: "message" }), el("iframe"), button))).toBe(false);
      expect(flag(button => form(el("span", { "data-recipient": "Ana Silva" }, "Ana Silva"), button))).toBe(false);
    });
  });
});
