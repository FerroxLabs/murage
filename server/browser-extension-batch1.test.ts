// SPDX-License-Identifier: AGPL-3.0-or-later
// Red-first test (lane 0162-chromebatch1): the server's per-profile send queue must not hold a dialog answer behind
// the very command the dialog blocked.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createBrowserExtensionService } from "./browser-extension-service.ts";
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from "../shared/browser-extension-protocol.ts";
const cleanup: string[] = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

describe("a dialog answer is not queued behind the blocked command", () => {
  it("Page.handleJavaScriptDialog reaches the extension while an Input command is still pending", async () => {
    const directory = await fs.mkdtemp(path.resolve(".service-")); cleanup.push(directory); await fs.chmod(directory, 0o700);
    const seen: string[] = []; let releaseInput!: () => void; const inputBlocked = new Promise<void>(resolve => { releaseInput = resolve; });
    const tab = { tabId: 1, navigationEpoch: 1, origin: "https://fixture.test", url: "https://fixture.test/" }; const state = { generation: 1, state: "active" };
    const broker = {
      profiles: (): BrowserExtensionHello[] => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1"] }],
      async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
        let result: any = { ...state, tabs: [tab] };
        if (command.operation === "cdp") {
          const { method } = command.params as any; seen.push(method);
          if (method === "Input.dispatchMouseEvent") await inputBlocked;
          let value: any = {};
          if (method === "Page.getFrameTree") value = { frameTree: { frame: { id: "frame", loaderId: "L" } } };
          if (method === "Page.createIsolatedWorld") value = { executionContextId: 7 };
          if (method === 'DOM.getDocument') value = { root: { nodeType: 9, children: [] } };
          if (method === "Runtime.evaluate") value = { result: { value: String((command.params as any).params.expression).includes("__murageGuard()") ? false : "page" } };
          result = { result: value, ...tab };
        }
        return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) };
      },
    };
    let dialogAnswer: Promise<unknown> | undefined;
    const service = await createBrowserExtensionService({
      broker, workspaceId: "workspace", stateFile: path.join(directory, "state.json"), collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: 'visible', ariaHidden: false, coveredBy: null } }) as never,
      createEngine: (engine: import("./browser-extension-engine.ts").BrowserExtensionEngineOptions) => ({
        resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
        async call() {
          const document = await engine.transport.selected();
          const click = engine.transport.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 1 }, document);
          // The page's alert is now open: the engine answers it while the click is still waiting.
          dialogAnswer = engine.transport.send("Page.handleJavaScriptDialog", { accept: true }, document);
          await new Promise(resolve => setTimeout(resolve, 300));
          expect(seen).toContain("Page.handleJavaScriptDialog");
          releaseInput(); await click; await dialogAnswer;
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
      askSite: async () => "allow", askAction: async () => true,
    } as never);
    const binding = await service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
    const out = await service.dispatch(binding.bindingId, "agent_browser_snapshot", {}, () => true).catch(e => ({ error: String(e.message) }));
    expect(JSON.stringify(out)).toContain("ok");
    expect(seen.indexOf("Page.handleJavaScriptDialog")).toBeLessThan(seen.length);
  });
});
