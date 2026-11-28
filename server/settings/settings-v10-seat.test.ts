// Settings v10 SEAT (owner: core). The extracted index.ts regions are reached once from index.ts, through their
// lane-owned modules, and every lane route module is mounted in the owner API chain.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { settingsV10Router } from "./v10-routes.ts";
import { assertRelayBot, assertRelayStored } from "../connector-relay.ts";
import { checkArchiveRevision } from "./archive-guard.ts";

const deps = { dataDir: "/nonexistent", folderTrust: { list: () => [] } } as never;
const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const count = (needle: string) => index.split(needle).length - 1;

describe("Settings v10 SEAT", () => {
  it("reaches each extracted handler once from index.ts", () => {
    expect(count("await handleBotAccessRoute(method, path, req, res,")).toBe(1);
    expect(count("await settingsV10Routes.handle({")).toBe(1);
    expect(count("const settingsV10Routes = settingsV10Router({ dataDir: DATA_DIR, folderTrust, noLimitsMove });")).toBe(1);
    expect(count("assertRelayBot(store.bot(internalClaim.botId), body,")).toBe(2);
    expect(count("assertRelayStored(store.bot(internalClaim.botId), used,")).toBe(1);
    expect(count("checkArchiveRevision(existingBot, body)")).toBe(1);
    // the old inline copies are gone, so nothing in index.ts answers those paths twice
    expect(index).not.toContain("/^\\/api\\/bots\\/([\\w-]+)\\/access$/");
    expect(index).not.toMatch(/\bassertConnectedAppCall\(|\bassertStoredConnectedAppAccess\(|\breviewBotAccess\(/);
  });

  it("mounts the lane route modules ahead of the bot access route", () => {
    const mount = index.indexOf("await settingsV10Routes.handle({");
    const access = index.indexOf("await handleBotAccessRoute(method, path, req, res,");
    expect(mount).toBeGreaterThan(0);
    expect(access).toBeGreaterThan(mount);
    expect(settingsV10Router(deps).owners()).toEqual(["access", "access", "tools", "tools", "skills", "core", "core", "core", "core", "core"]);
  });

  it("calls the archive guard before the PATCH handler's first write", () => {
    const start = index.indexOf("const patchBotInner = async (): Promise<void> => {");
    const hook = index.indexOf("checkArchiveRevision(existingBot, body)", start);
    const firstWrite = index.slice(start).search(/store\.(patchBot|setChiefOfStaff|setIndividual|updateBot)\(/);
    expect(start).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(start);
    expect(firstWrite).toBeGreaterThan(hook - start);
  });

  it("keeps the relay refusals: a missing bot is a 403 before any access check", () => {
    expect(() => assertRelayBot(undefined, {}, false)).toThrow(expect.objectContaining({ message: "Bot unavailable.", status: 403 }));
    expect(() => assertRelayStored(undefined, { requirements: [], complete: true }, true)).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("seats the archive guard as ok until roster fills it", () => {
    expect(checkArchiveRevision({ id: "b1" }, { hidden: true })).toEqual({ ok: true });
  });

  it("answers no route from the seated stubs", async () => {
    const ctx = { method: "GET", path: "/api/settings/none" } as never;
    await expect(settingsV10Router(deps).handle(ctx)).resolves.toBe(false);
  });
});

describe("Settings v10 wiring notes applied by core", () => {
  const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  it("the archive guard runs a second time right before the bot write (roster-1) and the roster strip hides the access level fields (access-1)", () => {
    expect(index.split("checkArchiveRevision(").length - 1).toBe(2);
    expect(index).toContain("const lateGuard = checkArchiveRevision(");
    expect(index).toContain("connectedAppLevels: _connectedAppLevels, connectedAppDecisions: _connectedAppDecisions");
  });
});
