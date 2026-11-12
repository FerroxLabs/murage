import { createCompanionAuthority } from "./companion-authority.ts";
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedBrowserController } from "./browser-control.ts";
import { browserOwnerRequest, browserOwnerId, browserOwnerPrincipal } from "./browser-owner-api.ts";
import type { NativeBrowser } from "./browser-native-relay.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
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
    } finally { await controller.close(); await new Promise<void>(done => server.close(() => done())); removeTempDirSync(directory); }
  });

  // Fix round 2: server/index.ts's own door-level 401 ("!desktop && !paired",
  // ~11386, code "desktop_only") and this one are both status 401 but mean
  // completely different things — an authenticated desktop session mid-poll
  // whose bot's browser profile changed, was disabled, or was removed is not
  // a device-auth problem. Pinned separately so a client can never conflate
  // them, and so a wording or code change here fails this test directly.
  it("marks the 'authority went inactive' 401 with its own code, distinct from the door's device-auth 401", async () => {
    const directory = mkdtempSync(join(tmpdir(), "murage-browser-inactive-"));
    const native: NativeBrowser = { protected: async () => false, request: async () => ({}), command: async () => ({}), connect: async () => "test-stream", input: () => {}, resetStream: () => {}, close: async () => {} };
    const controller = new UnifiedBrowserController({ stateFile: join(directory, "control.json"), createNative: () => native });
    controller.register("inactive-profile", { command: "fixture", args: [], env: {} });
    try {
      const authority = { owner: "desktop-owner", profileKey: "inactive-profile", active: () => false };
      await expect(browserOwnerRequest(controller, authority, "GET")).rejects.toMatchObject({
        message: "Browser owner authentication required",
        status: 401,
        code: "browser_inactive",
      });
    } finally { await controller.close(); removeTempDirSync(directory); }
  });
});

describe("person-keyed browser owner", () => {
  it("uses the authenticated desktop or companion proof off-home and ignores request owner fields", async () => {
    const base = { realm: "fixture-realm", cloudHome: false, desktop: false, companion: false };
    expect(browserOwnerId(base.realm)).toBe("d5ffa202b19c137a23cddabe4f7aa3f6");
    const desktop = browserOwnerPrincipal({ ...base, desktop: true });
    const acceptsCompanion = createCompanionAuthority("a".repeat(64));
    const phone = browserOwnerPrincipal({ ...base, companion: acceptsCompanion({ "x-murage-companion-token": "a".repeat(64) }) });
    expect(browserOwnerPrincipal({ ...base, companion: acceptsCompanion({ "x-murage-companion": "1", "x-murage-companion-token": "b".repeat(64) }) })).toBeNull();
    expect(desktop).toEqual({ owner: browserOwnerId(base.realm), canReclaim: true });
    expect(phone).toEqual({ owner: desktop!.owner, canReclaim: false });
    expect(browserOwnerPrincipal(base)).toBeNull();
    const directory = mkdtempSync(join(tmpdir(), "murage-person-"));
    const controller = new UnifiedBrowserController({ stateFile: join(directory, "control.json") });
    controller.register("profile", {command:"fixture",args:[],env:{}});
    try {
      const authority = (person: NonNullable<typeof desktop>) => ({...person,profileKey:"profile",active:()=>true});
      const taken = await browserOwnerRequest(controller, authority(desktop!), "POST", {action:"take",owner:"forged"}) as {control:number};
      expect(controller.status("profile").owner).toBe(desktop!.owner);
      await browserOwnerRequest(controller, authority(phone!), "POST", {action:"release",control:taken.control,owner:"forged"});
      expect(controller.status("profile").held).toBe(false);
    } finally { await controller.close(); removeTempDirSync(directory); }
  });
  it("only admits owner-desktop and owner-phone on a Cloud home, even with other surface proofs", async () => {
    const base = {realm:"cloud",cloudHome:true,desktop:true,companion:true};
    expect(browserOwnerPrincipal({...base,scope:"owner-desktop"})).toEqual({owner:browserOwnerId("cloud"),canReclaim:true});
    expect(browserOwnerPrincipal({...base,scope:"owner-phone"})).toEqual({owner:browserOwnerId("cloud"),canReclaim:false});
    const directory = mkdtempSync(join(tmpdir(), "murage-cloud-owner-"));
    const controller = new UnifiedBrowserController({stateFile:join(directory,"control.json")});
    controller.register("profile", {command:"fixture",args:[],env:{}});
    try {
      for (const scope of [undefined,"browser","member","owner-browser"]) {
        const principal = browserOwnerPrincipal({...base,scope});
        expect(principal).toBeNull();
        await expect(browserOwnerRequest(controller, principal ? {...principal,profileKey:"profile",active:()=>true} : null, "POST", {action:"take",owner:browserOwnerId("cloud")})).rejects.toMatchObject({status:401});
        expect(controller.status("profile").held).toBe(false);
      }
    } finally { await controller.close(); removeTempDirSync(directory); }
  });
});
