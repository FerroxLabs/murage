import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedBrowserController } from "./browser-control.ts";
import { browserOwnerRequest } from "./browser-owner-api.ts";
import type { NativeBrowser } from "./browser-native-relay.ts";
describe("authenticated browser owner HTTP relay", () => {
  it("rejects anonymous, forged-owner and stale input while sharing the profile hold across bots", async () => {
    const directory = mkdtempSync(join(tmpdir(), "murage-browser-http-"));
    let inputs = 0;
    const native: NativeBrowser = { protected: async () => false, request: async () => ({}), command: async () => ({}), connect: async () => "test-stream", input: () => { inputs++; }, resetStream: () => {}, close: async () => {} };
    const controller = new UnifiedBrowserController({ stateFile: join(directory, "control.json"), createNative: () => native });
    controller.register("shared-profile", { command: "fixture", args: [], env: {} });
    const server = createServer(async (req, res) => {
      try {
        let raw = ""; for await (const chunk of req) raw += chunk;
        const owner = req.headers.authorization === "Bearer fixture-owner-a" ? "a" : req.headers.authorization === "Bearer fixture-owner-b" ? "b" : null;
        const result = await browserOwnerRequest(controller, owner ? { owner, profileKey: "shared-profile", active: () => true } : null, req.method!, raw ? JSON.parse(raw) : {});
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
      } catch (error) { res.statusCode = (error as { status?: number }).status ?? 409; res.end(JSON.stringify({ error: (error as Error).message })); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (token: string, body?: unknown) => fetch(url, { method: body ? "POST" : "GET", headers: { authorization: token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    try {
      expect((await call("")).status).toBe(401);
      const taken = await (await call("Bearer fixture-owner-a", { action: "take" })).json() as { generation: number };
      expect(taken).toMatchObject({ held: true, owned: true });
      expect((await call("Bearer fixture-owner-b", { action: "release", owner: "a", generation: taken.generation })).status).toBe(409);
      expect((await call("Bearer fixture-owner-b", { action: "take", profileKey: "other-bot" })).status).toBe(409);
      expect((await call("Bearer fixture-owner-a", { action: "input", generation: taken.generation - 1, event: { type: "input_keyboard", eventType: "char", text: "fake" } })).status).toBe(409);
      expect(inputs).toBe(0);
      expect((await call("Bearer fixture-owner-a", { action: "input", generation: taken.generation, event: { type: "input_keyboard", eventType: "char", text: "fake" } })).status).toBe(200);
      expect(inputs).toBe(1);
    } finally { await controller.close(); await new Promise<void>(done => server.close(() => done())); rmSync(directory, { recursive: true, force: true }); }
  });
});
