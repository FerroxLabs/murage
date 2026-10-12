// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.2 desktop-side fixes for Murage for Chrome (found in the real 1.0.0 side panel audit): the name and colour the
// panel draws, the card heading, the access names, how long a card waits, and what the bot is told when a call fails.
import { describe, expect, it } from "vitest";
import { botColorHex, EMBER_COLOR_HEX } from "../shared/ember-colors.ts";
import { HUMAN_DECISION_MS, BROWSER_EXTENSION_CALL_TIMEOUT_MS } from "../shared/browser-extension-protocol.ts";
import { browserActionCardTitle, BrowserExtensionApprovals, type BrowserExtensionApprovalRequest } from "./browser-extension-approvals.ts";
import { extensionActivityText, extensionBindName } from "./browser-extension-integration.ts";
import { extensionBrowserSystemPrompt } from "./browser-extension-prompt.ts";
import { EXTENSION_CALL_FAILED_TEXT } from "./browser-extension-refusals.ts";

describe("D1: the bind name is the bot's name alone", () => {
  it("never carries the conversation title", () => {
    expect(extensionBindName({ name: "Ember" }, "bot_1")).toBe("Ember");
    expect(extensionBindName(undefined, "bot_1")).toBe("bot_1");
  });
});

describe("D2: the panel gets a #rrggbb for every colour name the app has", () => {
  it("maps each name to the hex the app paints it with, and passes a valid hex through", () => {
    expect(botColorHex("orange")).toBe("#FF6B35");
    expect(botColorHex("Orange")).toBe("#FF6B35");
    for (const [name, hex] of Object.entries(EMBER_COLOR_HEX)) { expect(botColorHex(name)).toBe(hex); expect(botColorHex(name)).toMatch(/^#[0-9a-f]{6}$/i); }
    expect(botColorHex("#aa33cc")).toBe("#aa33cc");
  });
  it("sends nothing for a value it does not know", () => {
    for (const bad of [undefined, null, 5, "", "chartreuse", "#fff", "rgb(1,2,3)"]) expect(botColorHex(bad)).toBeUndefined();
  });
});

describe("D3: the action card heading", () => {
  it("says what the bot wants to do and where", () => {
    const doc = { url: "https://example.com/a", origin: "https://example.com" };
    expect(browserActionCardTitle("Ember", { name: "agent_browser_click", arguments: {}, document: doc })).toBe("Ember wants to click on example.com");
    expect(browserActionCardTitle("Ember", { name: "agent_browser_fill", arguments: {}, document: doc })).toBe("Ember wants to type into example.com");
    expect(browserActionCardTitle("Ember", { name: "agent_browser_open", arguments: { url: "https://shop.example.org/cart" }, document: doc })).toBe("Ember wants to open shop.example.org");
    expect(browserActionCardTitle("Ember", { name: "agent_browser_get_text", arguments: {}, document: doc })).toBe("Ember wants to use your browser on example.com");
  });
  it("still reads well without a page, and never shows the tool name", () => {
    const text = browserActionCardTitle("Ember", { name: "agent_browser_mystery", arguments: {} });
    expect(text).toBe("Ember wants to use your browser");
    for (const name of ["click", "type", "open", "select", "check", "press", "back", "mystery"]) {
      const title = browserActionCardTitle("Ember", { name: `agent_browser_${name}`, arguments: {}, document: { url: "https://example.com/" } });
      expect(title).not.toMatch(/agent_browser|browser extension action|—|\bsafe|unsafe|Composio/i);
    }
  });
  it("the card carries the heading it was given", () => {
    const messages: { card?: { title?: string } }[] = [];
    const store = { bots: [], groups: [], messagesFor: () => messages, appendMessage: (_t: string, m: { card?: { title?: string } }) => { messages.push(m); return { id: "m1", ...m }; }, patchMessage: () => true };
    const approvals = new BrowserExtensionApprovals({ store, broadcast() {} } as never);
    const input = { bot: { id: "bot", name: "Ember", color: "orange" }, threadId: "t", bindingId: "b", generation: 1, digest: "a".repeat(64), summary: "click", waitMs: 1 } as BrowserExtensionApprovalRequest;
    void approvals.ask({ ...input, title: "Ember wants to click on example.com" });
    void approvals.ask({ ...input, digest: "b".repeat(64) });
    expect(messages[0].card?.title).toBe("Ember wants to click on example.com");
    expect(messages[1].card?.title).toBe("Ember needs your approval");
  });
});

describe("D4: one set of access names", () => {
  it("the side panel's activity lines say Full access, as the app's settings do", () => {
    expect(extensionActivityText({ action: "click", site: "example.com", decision: "Full permissive" })).toBe("click on example.com: Full access");
    expect(extensionActivityText({ action: "fill", target: "Email", site: "example.com", decision: "you allowed" })).toBe("fill Email on example.com: you allowed");
  });
  it("the bot is told Full access, never Full permissive", () => {
    const text = extensionBrowserSystemPrompt({ mode: "full", checker: "on" });
    expect(text).toContain("Full access");
    expect(text).not.toContain("permissive");
  });
});

describe("D5: how long a card waits, and what the bot reads when a call fails", () => {
  it("waits as long as every other approval card (15 minutes), and the call outlives two waits", () => {
    expect(HUMAN_DECISION_MS).toBe(15 * 60_000);
    expect(BROWSER_EXTENSION_CALL_TIMEOUT_MS).toBe(HUMAN_DECISION_MS * 2 + 60_000);
  });
  it("the bot is told about the real wait", () => {
    const text = extensionBrowserSystemPrompt({ mode: "task", checker: "on" });
    expect(text).toContain("A card waits about fifteen minutes.");
    expect(text).not.toContain("two minutes");
  });
  it("a failed call with no stated reason never tells the bot to have the owner open the panel as the fix", () => {
    expect(EXTENSION_CALL_FAILED_TEXT).not.toMatch(/open the browser panel/i);
    expect(EXTENSION_CALL_FAILED_TEXT).toContain("card waiting");
    expect(EXTENSION_CALL_FAILED_TEXT).toContain("connected");
  });
});
