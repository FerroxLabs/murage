// SPDX-License-Identifier: AGPL-3.0-or-later
import { domFunction } from "./testing/native-dom-fixture.ts";
import { privateTestDirectory, writePrivateTestFile } from "./testing/private-test-dir.ts";
// Round 9 (blind Astra re-review of round 8, R8-01 to R8-12). Each test reproduces the attack and fails on 4355d11d.
// Chrome-dependent proofs are in scripts/browser-corefix9.node-test.mjs.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanRecipients, looksLikeSecretValue } from "./browser-recipient-safety.ts";
import { COLLECT_RECIPIENTS_SOURCE } from "./browser-floor-facts.ts";
import { ReadLayer, type CdpSend } from "./browser-extension-snapshot.ts";
import { createBrowserExtensionService } from "./browser-extension-service.ts";
import { BrowserExtensionExecutor, type ExtensionDocument } from "./browser-extension-executor.ts";
import { DESCRIBE_TARGET_SOURCE } from "./browser-extension-page-scripts.ts";

describe("R8-03 phone and handle syntax is no exemption", () => {
  it.each(["+4111111111111111", "(078)05-1120", "@123⁠456", "@123‮456", "123​456", "4111⁠1111⁠1111⁠1111"])("%j is a secret", value => {
    expect(looksLikeSecretValue(value)).toBe(true);
    expect(cleanRecipients([value])).toEqual([]);
  });
  it.each(["+1 555 123 4567", "(555) 123-4567", "+442071234567"])("%j is still a phone number", value => {
    expect(cleanRecipients([value])).toEqual([value]);
  });
});

describe("R8-02 snapshot values go through the shared classifier", () => {
  it("a field called Notes holding a code is hidden in model-visible output", async () => {
    const send: CdpSend = async (method: string) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F", loaderId: "L" } } };
      if (method === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "1", backendDOMNodeId: 1, role: { value: "textbox" }, name: { value: "Notes" }, value: { value: "482913" } }] };
      if (method === "DOM.describeNode") return { node: { attributes: [] } };
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientHeight: 800 } };
      if (method === "DOM.getBoxModel") return { model: { border: [0, 0, 10, 0, 10, 20, 0, 20] } };
      throw new Error("unexpected " + method);
    };
    const shot = await new ReadLayer(send, { origin: () => "https://shop.test", url: () => "https://shop.test/" }).snapshot();
    expect(shot.text).not.toContain("482913");
  });
});

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
}
const el = (tag: string, attrs: Record<string, string> = {}, text = "") => new Node_(tag, attrs, text);
const scan = (build: (button: Node_) => Node_) => {
  const button = el("button", { "aria-label": "Send" }); const root = build(button); button.ownerDocument = { body: root };
  const g = globalThis as any; const before = g.getComputedStyle; g.getComputedStyle = () => ({ webkitTextSecurity: "none" });
  try { return (domFunction(`return (${COLLECT_RECIPIENTS_SOURCE});`)() as () => { recipients: string[]; incomplete: boolean }).call(button); } finally { g.getComputedStyle = before; }
};

describe("R8-04 a deep ancestor labelled Password still counts", () => {
  it("13 wrappers under a Password zone: not harvested", () => {
    let inner = el("div", { contenteditable: "true", "aria-label": "To" }, "ana@example.com");
    const zone = el("div", { "aria-label": "Password" }); zone.add(inner);
    let top: Node_ = zone;
    for (let i = 0; i < 0; i++) top = top;
    // push the editable 13 levels below the zone
    let cur = zone; inner.parentNode = null; zone.children = [];
    for (let i = 0; i < 13; i++) { const w = el("div"); cur.add(w); cur = w; }
    cur.add(inner);
    const result = scan(button => { const f = el("form"); f.add(zone, button); return f; });
    expect(result.recipients).toEqual([]);
  });
  it("ancestry too long to finish is not trusted either", () => {
    const inner = el("div", { contenteditable: "true", "aria-label": "To" }, "ana@example.com");
    let cur = el("div"); const top = cur;
    for (let i = 0; i < 450; i++) { const w = el("div"); cur.add(w); cur = w; }
    cur.add(inner);
    expect(scan(button => { const f = el("form"); f.add(top, button); return f; }).recipients).toEqual([]);
  });
});

// Executor harness (as in corefix8).
const DOC: ExtensionDocument = { profileId: "p", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
describe("R8-08 a key activation is bound to the payload and the recipients", () => {
  it("Space keydown that swaps a field value before keyup cancels the keyup", async () => {
    let describeValue: any = { display: { tag: "BUTTON", text: "Send" }, bound: { tag: "BUTTON", hidden: [] }, values: ["ana@example.com"], editable: false };
    const calls: string[] = [];
    const executor = new BrowserExtensionExecutor({
      collectFacts: async (_i: unknown, _t: unknown, operation: string) => ({ operation, tag: "button", role: "button", name: "Send" }) as never,
      authorize: () => true, access: async () => true, admit: async () => true,
      createEngine: hooks => ({
        resolveTarget: async () => ({ backendNodeId: 12, document: { ...DOC } }), resolveTab: async () => ({ ...DOC }), event() {}, async close() {},
        async call() {
          for (const type of ["keyDown", "keyUp"]) {
            await hooks.beforeCommand({ ...DOC }, "Input.dispatchKeyEvent", { type, key: " " }); calls.push(type);
            if (type === "keyDown") describeValue = { ...describeValue, values: ["mallory@evil.example"] };
          }
          return { content: [] };
        },
      }),
      transport: {
        document: async () => ({ ...DOC }),
        send: async (method, params) => {
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: "L" } } };
          if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
          if (method === "Runtime.evaluate") return String(params.expression).includes("__murageGuard()") ? { result: { type: "boolean", value: false } } : params.returnByValue === false ? { result: { objectId: "node" } } : { result: { value: 0 } };
          if (method === "DOM.getDocument") return { root: { nodeType: 9, children: [] } };
          if (method === "DOM.describeNode") return { node: { backendNodeId: 12, nodeName: "BUTTON" } };
          if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
          if (method === "Runtime.callFunctionOn") return { result: { value: params.functionDeclaration === DESCRIBE_TARGET_SOURCE ? JSON.stringify(describeValue) : true } };
          return {};
        },
      },
    });
    await expect(executor.call("agent_browser_press", { key: " " })).rejects.toThrow(/changed/);
    expect(calls).toEqual(["keyDown"]);
  });
});

describe("R8-01 a closed root on an ordinary element refuses the page", () => {
  it("a div with a closed root is found through the browser's own tree", async () => {
    const executor = new BrowserExtensionExecutor({
      authorize: () => true, access: async () => true, admit: async () => true,
      transport: {
        document: async () => ({ ...DOC }),
        send: async (method, params) => {
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: "L" } } };
          if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
          if (method === "Runtime.evaluate") return String(params.expression).includes("__murageGuard()") ? { result: { type: "boolean", value: false } } : { result: { value: 0 } };
          if (method === "DOM.getDocument") return { root: { nodeType: 9, children: [{ nodeType: 1, nodeName: "DIV", shadowRoots: [{ shadowRootType: "closed", nodeType: 11, children: [{ nodeType: 1, nodeName: "INPUT" }] }] }] } };
          return {};
        },
      },
    });
    expect(await executor.protectedDocument({ ...DOC })).toBe(true);
  });
});

// Service: R8-12 and R8-10.
const A = "https://fixture.test";
const cleanup: string[] = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
async function service() {
  const { root: directoryRoot, directory } = await privateTestDirectory(path.resolve(".corefix9-")); cleanup.push(directoryRoot);
  const bindings = new Map<string, any>();
  const broker = {
    profiles: () => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1", "lifecycle_v1"] }] as never,
    async request(_p: string, command: any) {
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: 1, navigationEpoch: 1, origin: A, url: A + "/" }] }; bindings.set(command.bindingId, b); }
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(b) } as never;
    },
  };
  const options = { broker, workspaceId: "workspace", stateFile: path.join(directory, "state.json"), askSite: async () => "ask" as const, askAction: async () => true, approvalMode: () => "task" as const };
  const created = await createBrowserExtensionService(options as never);
  const binding = await created.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
  return { created, binding, options, id: binding.bindingId };
}
describe("R8-12 a forged Allow always does not survive a restart", () => {
  it("sites[origin]=allow written into the state file loads as ask", async () => {
    const f = await service();
    await f.created.setSiteAccess(f.id, A, "ask");
    await f.created.close();
    const file = f.options.stateFile; const saved = JSON.parse(await fs.readFile(file, "utf8"));
    saved.bindings[0].sites[A] = "allow";
    writePrivateTestFile(file, JSON.stringify(saved));
    const restored = await createBrowserExtensionService(f.options as never);
    expect(restored.status().bindings[0].sites[A]).not.toBe("allow");
  });
});
