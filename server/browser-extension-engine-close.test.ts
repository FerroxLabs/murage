// SPDX-License-Identifier: AGPL-3.0-or-later
// Upstream 4a6a9c4e1's race in our engine: turning shared-browser control off
// (close()) while the engine is starting must not leave an engine process that
// nothing owns. close() runs dispose() at once, which sees no engine yet; the
// start must then stop at its next step instead of spawning one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const socketDir = mkdtempSync(join(tmpdir(), "murage-bee-close-"));
vi.mock("./browser-engine.ts", () => ({
  settledBrowserEngineStatus: async () => ({ kind: "ready", binaryPath: "/fixture/agent-browser" }),
  agentBrowserIntegration: () => ({ command: "/fixture/agent-browser", args: [], env: { AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_SESSION: "mbe-fixture" } }),
  browserEngineEncryptionKey: () => "fixture-key",
  verifyAgentBrowserBinary: async () => {},
}));

const { BrowserExtensionEngine } = await import("./browser-extension-engine.ts");

describe("close() during start", () => {
  it("spawns no engine once sharing was turned off mid-start", async () => {
    const doc = { profileId: "profile", tabId: 7, frameId: "main", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
    let release!: () => void;
    let reached!: () => void;
    const atSelected = new Promise<void>((r) => { reached = r; });
    const engineFactory = vi.fn();
    const engine = new BrowserExtensionEngine({
      dataDir: "/unused-fixture", realmId: "workspace", bindingId: "binding", authorize: () => true,
      beforeCommand: async () => {}, beforeDestination: async () => {}, engineFactory,
      transport: {
        documents: async () => [doc],
        selected: () => { reached(); return new Promise((r) => { release = () => r({ ...doc }); }); },
        send: async () => ({}), newTab: async () => doc, closeTab: async () => {}, selectTab: async () => doc,
      },
    });
    const call = engine.call("agent_browser_get_url", {});
    call.catch(() => {});
    await atSelected; // the start is waiting on the shared tab
    await engine.close(); // the owner turned sharing off
    release();
    await expect(call).rejects.toThrow();
    expect(engineFactory).not.toHaveBeenCalled();
  });
});
