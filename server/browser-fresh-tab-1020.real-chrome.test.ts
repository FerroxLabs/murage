// SPDX-License-Identifier: AGPL-3.0-or-later
// FABLE-REVIEW fix/1020-browserhand 8cb4b8b6e5 (BLOCK, High): one real agent-browser + real Chrome witness that the first read
// after the bot is moved to a new blank tab returns that blank tab, never the protected page (Sean 1.0.20 ruling: the protected
// tab is left to the owner and the bot gets a new blank tab of its own, silently).
//
// Runs only with the pinned engine: MURAGE_REAL_AGENT_BROWSER (its path) and AGENT_BROWSER_EXECUTABLE_PATH (Chromium). The host
// sandbox checks are answered by the unpackaged test seam and the mock below, so it also runs in a --network none test container
// (the page is served on loopback).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedBrowserController } from "./browser-control.ts";
import { agentBrowserIntegration, BROWSER_HOST_TEST } from "./browser-engine.ts";
import { createNativeBrowser } from "./browser-native-relay.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// A test container restricts user namespaces, so Murage's Linux sandbox gate (never the subject here) is answered as passed; the
// engine, Chrome, the page check and the tab routing all run for real.
vi.mock("./browser-sandbox.ts", async (load) => ({ ...(await load<typeof import("./browser-sandbox.ts")>()), ensureBrowserSandboxAccess: async () => {} }));

const binary = process.env.MURAGE_REAL_AGENT_BROWSER;
const chrome = process.env.AGENT_BROWSER_EXECUTABLE_PATH;
const MARKER = "protected-page-marker-1020";

describe.skipIf(!binary || !chrome)("real agent-browser + Chrome: after the move the bot reads its new blank tab", () => {
  let server: Server; let port = 0;
  const dirs: string[] = [];
  beforeAll(async () => {
    (globalThis as Record<symbol, unknown>)[BROWSER_HOST_TEST] = { assertSandbox() {} };
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>${MARKER}</title><h1>${MARKER}</h1><form><label>Password <input type="password" name="pw" autocomplete="current-password"></label></form>`);
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    delete (globalThis as Record<symbol, unknown>)[BROWSER_HOST_TEST];
    await new Promise<void>(done => server.close(() => done()));
    for (const dir of dirs) removeTempDirSync(dir);
  });

  it("locks on the sign-in page, moves the bot to a new blank tab, and its first read is that blank tab", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "murage-fresh-tab-real-")); dirs.push(dataDir);
    const spec = agentBrowserIntegration({ binaryPath: binary!, session: "fresh-tab-real", encryptionKey: "d".repeat(64), dataDir, realmId: "fresh-tab-real", persistent: false, env: process.env });
    const native = createNativeBrowser(spec);
    const controller = new UnifiedBrowserController({ stateFile: join(dataDir, "control.json"), createNative: () => native });
    const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as Error & { code?: string }; } throw new Error("expected a refusal"); };
    const call = (name: string, args: Record<string, unknown> = {}) => controller.dispatch("bot-real", "tools/call", { name, arguments: args }, () => true, { readScope: "fresh-tab-real" });
    try {
      await controller.register("bot-real", spec);
      // The engine and Chrome start (a start-up failure shows its own error here, not as a refusal code).
      await native.command(["get", "url"]);
      // The bot opens a sign-in page: the real page check locks it and the bot is not given the page.
      const locked = await refusal(call("agent_browser_open", { url: `http://127.0.0.1:${port}/sign-in` }));
      expect(locked.code).toBe("browser_protected_sensitive_page");
      expect(JSON.stringify(locked)).not.toContain(MARKER);
      expect(controller.status("bot-real")).toMatchObject({ protectedDocument: true });

      // The next step moves the bot to a new blank tab (and does not run).
      expect((await refusal(call("agent_browser_snapshot"))).code).toBe("browser_fresh_tab");
      expect(controller.status("bot-real").protectedDocument).toBe(false);

      // The first read after the move: the engine acts on the new blank tab, not the protected page.
      const first = JSON.stringify(await call("agent_browser_snapshot"));
      expect(first).not.toContain(MARKER);
      expect(first).not.toMatch(/password/i);
      const where = JSON.stringify(await call("agent_browser_get_url"));
      expect(where).toContain("about:blank");
      expect(where).not.toContain(`127.0.0.1:${port}`);

      // The protected tab is still open, left to the owner.
      expect((await native.pages!()).some(p => p.url.includes(`127.0.0.1:${port}/sign-in`))).toBe(true);
    } finally {
      await controller.close().catch(() => {});
      await native.close().catch(() => {});
    }
  }, 120_000);
});
