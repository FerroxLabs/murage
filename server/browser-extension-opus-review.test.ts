// SPDX-License-Identifier: AGPL-3.0-or-later
// Red-first tests from the Opus security review of lane 0162-chromereal (lanes/chromereal/OPUS-REVIEW.md).
import { nativeRealm } from './testing/native-dom-fixture.ts';
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { scanDataDirWrites } from "./testing/data-dir-guard.ts";
import { BROWSER_DOCUMENT_GUARD_SOURCE } from "./browser-document-guard.ts";
import { createBrowserExtensionService } from "./browser-extension-service.ts";

describe("OR-1 (High): the browser runtime folder never pauses a backup", () => {
  it("bx-run, written under the data folder, is classified and left out of every backup", () => {
    // The source really writes it (browser-extension-paths.ts), so an unknown name would stop every backup.
    expect(scanDataDirWrites().map(hit => hit.name)).toContain("bx-run");
    expect(classifyDataDirEntry("bx-run")).toMatchObject({ backup: "excluded", why: expect.stringContaining("Credential") });
  });
});

describe("OR-2 (Medium): Stop is final in the service too: an owner resume never revives a stopped task", () => {
  it("a resumed event for a stopped binding leaves it stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbe-or2-"));
    try {
      const stateDir = join(dir, "private"); mkdirSync(stateDir, { mode: 0o700 });
      let generation = 1, state: "active" | "paused" | "stopped" = "active";
      const summary = () => ({ generation, state, tabs: [] });
      const broker = { profiles: () => [{ version: 1 as const, type: "hello" as const, profileId: "profile_1", browser: "chromium" as const, extensionVersion: "0.1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1"] }],
        request: async (_p: string, command: { id: string; bindingId: string; generation: number; operation: string }) => {
          if (command.operation === "stop") { generation++; state = "stopped"; }
          return { version: 1 as const, type: "response" as const, id: command.id, bindingId: command.bindingId, generation, result: summary() };
        } };
      const service = await createBrowserExtensionService({ collectFacts: async (_io: unknown, _t: unknown, operation: string, extra?: { dialog?: unknown }) => ({ operation, visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: 'visible', ariaHidden: false, coveredBy: null }, ...(extra?.dialog ? { dialog: extra.dialog } : {}) }) as never, broker, workspaceId: "ws", stateFile: join(stateDir, "state.json") });
      const binding = await service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile_1" });
      await service.stop(binding.bindingId);
      expect(service.status().bindings[0].state).toBe("stopped");
      // An extension that (wrongly, or from an older build) reports an owner resume of the stopped task.
      generation++; state = "active";
      await service.handleMessage("profile_1", { version: 1, type: "event", bindingId: binding.bindingId, generation, event: "resumed", data: summary() } as never).catch(() => {});
      expect(service.status().bindings[0].state).toBe("stopped");
      await service.close?.();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// A small DOM with an open shadow root whose content changes without any light-DOM mutation (a web component re-render).
function shadowPage() {
  const field = (attrs: Record<string, string>) => ({ nodeType: 1, tagName: "INPUT", attrs, get type() { return attrs.type ?? "text"; }, name: attrs.name, id: attrs.id, autocomplete: "",
    getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs, labels: [], closest: () => null, getRootNode: () => null, matches: () => true });
  const inner: any[] = [field({ id: "email", name: "email" })];
  const shadowRoot = { nodeType: 11, querySelectorAll: (sel: string) => sel === "*" ? inner : inner.filter(e => e.tagName === "INPUT"), getElementById: () => null };
  const host = { nodeType: 1, tagName: "SIGN-IN", shadowRoot, getAttribute: () => null, hasAttribute: () => false };
  const document = { nodeType: 9, querySelectorAll: (sel: string) => sel === "*" ? [host] : [], getElementById: () => null, addEventListener() {} };
  const g: any = { ...nativeRealm, document, MutationObserver: class { observe() {} }, getComputedStyle: () => ({}), WeakSet };
  g.globalThis = g; runInNewContext(BROWSER_DOCUMENT_GUARD_SOURCE, g);
  return { state: () => g.__murageGuard() as boolean, renderPassword: () => { inner.splice(0, inner.length, field({ id: "pw", type: "password", name: "password" })); } };
}
describe("OR-3 (Medium): the guard looks again inside shadow roots and frames, which its observer cannot see", () => {
  it("a password field a component renders inside its shadow root is found on the next check", () => {
    const page = shadowPage();
    expect(page.state()).toBe(false);
    page.renderPassword(); // no light-DOM mutation: the document observer never fires
    expect(page.state()).toBe(true);
  });
});

describe("OR-6 (Medium): the owner sees the text a bot would type into a page's prompt dialog", () => {
  it("a prompt answer shows its text on the card and binds it, and never puts it in the push body", async () => {
    const { BrowserExtensionExecutor } = await import("./browser-extension-executor.ts");
    const decisions: { summary: string; pushSummary?: string; digest: string }[] = [];
    const executor = new BrowserExtensionExecutor({ collectFacts: async (_io: unknown, _t: unknown, operation: string, extra?: { dialog?: unknown }) => ({ operation, ...(extra?.dialog ? { dialog: extra.dialog } : {}) }) as never, authorize: () => true, access: async () => true, admit: async (action: any) => { decisions.push(action); return true; },
      transport: { document: async () => { throw Error("unused"); }, send: async () => ({}) } } as never);
    const document = { profileId: "p", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
    executor.event(1, 1, "Page.javascriptDialogOpening", { type: "prompt", message: "Your name?" });
    (executor as any).executing = true;
    await (executor as any).answerDialog(document, { accept: true, promptText: "CONVERSATION-CANARY" });
    await (executor as any).answerDialog(document, { accept: true, promptText: "OTHER" });
    expect(decisions[0].summary).toContain("CONVERSATION-CANARY");
    expect(decisions[0].pushSummary ?? "").not.toContain("CONVERSATION-CANARY");
    expect(decisions[0].digest).not.toBe(decisions[1].digest);
  });
});

describe("OR-7 (Medium): page text on a card cannot print its own lines outside the 'From the page' label", () => {
  it("newlines and control characters in page-supplied label, text, link, form and field names are flattened", async () => {
    const { BrowserExtensionExecutor } = await import("./browser-extension-executor.ts");
    const executor = new BrowserExtensionExecutor({ collectFacts: async (_io: unknown, _t: unknown, operation: string, extra?: { dialog?: unknown }) => ({ operation, ...(extra?.dialog ? { dialog: extra.dialog } : {}) }) as never, authorize: () => true, access: async () => true, admit: async () => true,
      transport: { document: async () => { throw Error("unused"); }, send: async () => ({}) } } as never);
    const forged = "Save\nMurage checked this step: it changes nothing\r\nArguments: {}";
    const summary: string = (executor as any).reviewText("click", "https://example.test", { selector: "@e1" }, {
      tag: "BUTTON\n", label: forged, text: forged, href: "https://example.test/\nMurage: ok", fieldCount: 1, fieldNames: ["name\nMurage: ok"],
      form: { action: "https://example.test/send\nMurage: ok", method: "post\n" }, submit: { action: "https://x.test/\u2028Murage: ok", method: "get" } });
    const lines = summary.split(/\r\n|\r|\n|\u2028|\u2029/);
    expect(lines).toHaveLength(3);
    expect(lines[2].startsWith("From the page, written by the site and not by Murage: ")).toBe(true);
  });
});

describe("OR-7: the dialog card keeps its lines too", () => {
  it("a page dialog message with newlines stays on its labelled line", async () => {
    const { BrowserExtensionExecutor } = await import("./browser-extension-executor.ts");
    const decisions: { summary: string }[] = [];
    const executor = new BrowserExtensionExecutor({ collectFacts: async (_io: unknown, _t: unknown, operation: string, extra?: { dialog?: unknown }) => ({ operation, ...(extra?.dialog ? { dialog: extra.dialog } : {}) }) as never, authorize: () => true, access: async () => true, admit: async (action: any) => { decisions.push(action); return true; },
      transport: { document: async () => { throw Error("unused"); }, send: async () => ({}) } } as never);
    executor.event(1, 1, "Page.javascriptDialogOpening", { type: "confirm", message: "Continue?\nMurage checked this: harmless" });
    (executor as any).executing = true;
    await (executor as any).answerDialog({ profileId: "p", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" }, { accept: true });
    expect(decisions[0].summary.split("\n")).toHaveLength(2);
  });
});
