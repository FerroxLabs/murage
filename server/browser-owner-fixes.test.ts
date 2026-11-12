// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Three review findings on the Cloud home's owner browser: holds bound to the device, restore retries behind a code, and the
// risk reason only on a Cloud home.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UnifiedBrowserController } from "./browser-control.ts";
import { browserOwnerId, browserOwnerRequest, cloudBrowserOwnerId, releaseDeadCloudHolds, type CloudHoldDevice } from "./browser-owner-api.ts";
import { ownerCodeGate, setBrowserOwnerAct } from "./browser-owner-gates.ts";
import type { NativeBrowser } from "./browser-native-relay.ts";
import { setCloudIdentity } from "./cloud-request-identity.ts";
import type { CloudDevice } from "./cloud-sessions.ts";
import { riskStamp } from "./mobile-push-risk.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const REALM = "original-installation";
const native = (counter: { inputs: number }): NativeBrowser => ({ protected: async () => false, request: async () => ({}), command: async () => ({}), connect: async () => "s", input: () => { counter.inputs++; }, resetStream: () => {}, close: async () => {} });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-browser-fixes-"));
  const counter = { inputs: 0 };
  const controller = new UnifiedBrowserController({ stateFile: join(dir, "control.json"), createNative: () => native(counter) });
  controller.register("p", { command: "fixture", args: [], env: {} });
  const as = (owner: string) => ({ owner, profileKey: "p", active: () => true });
  return { dir, counter, controller, as };
};

describe("finding 1: a Cloud browser hold belongs to one device", () => {
  test("two devices get different owner ids, and neither is the shared companion id", () => {
    expect(cloudBrowserOwnerId(REALM, "dev-a")).not.toBe(cloudBrowserOwnerId(REALM, "dev-b"));
    expect(cloudBrowserOwnerId(REALM, "dev-a")).not.toBe(browserOwnerId("companion", REALM));
    expect(cloudBrowserOwnerId(REALM, "dev-a")).toBe(cloudBrowserOwnerId(REALM, "dev-a"));
  });
  test("device B cannot read as owner, navigate or send input after device A took control", async () => {
    const { dir, counter, controller, as } = setup();
    try {
      const a = as(cloudBrowserOwnerId(REALM, "dev-a")), b = as(cloudBrowserOwnerId(REALM, "dev-b"));
      const taken = await browserOwnerRequest(controller, a, "POST", { action: "take" }) as { generation: number };
      expect(await browserOwnerRequest(controller, b, "GET")).toMatchObject({ held: true, owned: false });
      await expect(browserOwnerRequest(controller, b, "POST", { action: "navigate", generation: taken.generation, url: "https://example.com" })).rejects.toBeTruthy();
      await expect(browserOwnerRequest(controller, b, "POST", { action: "input", generation: taken.generation, event: { type: "input_keyboard", eventType: "char", text: "x" } })).rejects.toBeTruthy();
      await expect(browserOwnerRequest(controller, b, "POST", { action: "take" })).rejects.toBeTruthy();
      expect(counter.inputs).toBe(0);
      await browserOwnerRequest(controller, a, "POST", { action: "input", generation: taken.generation, event: { type: "input_keyboard", eventType: "char", text: "x" } });
      expect(counter.inputs).toBe(1);
    } finally { await controller.close(); removeTempDirSync(dir); }
  });
  const device = (id: string, over: Partial<CloudHoldDevice> = {}): CloudHoldDevice => ({ id, scope: "browser", factor: "remembered-owner", factorExpiresAt: Date.now() + 60_000, ...over });
  const heldBy = async (controller: UnifiedBrowserController, owner: string) => { await controller.take("p", owner); return controller.status("p"); };
  test("the hold is released when the device is gone, made chat-only or its factor ran out; a live device keeps it", async () => {
    const { dir, controller } = setup();
    try {
      const owner = cloudBrowserOwnerId(REALM, "dev-a");
      await heldBy(controller, owner);
      expect(releaseDeadCloudHolds(controller, REALM, [device("dev-a"), device("dev-b")])).toBe(0);
      expect(controller.status("p").held).toBe(true);
      expect(releaseDeadCloudHolds(controller, REALM, [device("dev-b")])).toBe(1); // revoked: no longer listed
      expect(controller.status("p")).toMatchObject({ held: false, owner: null });
      await heldBy(controller, owner);
      expect(releaseDeadCloudHolds(controller, REALM, [device("dev-a", { factor: null, factorExpiresAt: undefined })])).toBe(1); // demoted to chat only
      await heldBy(controller, owner);
      expect(releaseDeadCloudHolds(controller, REALM, [device("dev-a", { factorExpiresAt: 1_000 })], 2_000)).toBe(1); // factor expired
      expect(controller.status("p").held).toBe(false);
    } finally { await controller.close(); removeTempDirSync(dir); }
  });
  test("desktop and phone holds are never released by the sweep", async () => {
    const { dir, controller } = setup();
    try {
      await heldBy(controller, browserOwnerId("desktop", REALM));
      expect(releaseDeadCloudHolds(controller, REALM, [])).toBe(0);
      await controller.release("p", browserOwnerId("desktop", REALM), controller.status("p").generation);
      await heldBy(controller, browserOwnerId("companion", REALM));
      expect(releaseDeadCloudHolds(controller, REALM, [])).toBe(0);
      expect(controller.status("p").held).toBe(true);
    } finally { await controller.close(); removeTempDirSync(dir); }
  });
  test("the browser route binds a Cloud owner browser to its device and sweeps first; revoke and expiry also sweep", () => {
    const route = source.slice(source.indexOf("api\\/bots\\/([^/]+)\\/browser(\\/frame)?$"), source.indexOf("api/images/settings"));
    expect(route).toContain("cloudBrowserOwnerId(realm, cloudDevice.id)");
    expect(route.indexOf("releaseDeadCloudHolds(")).toBeGreaterThan(-1);
    expect(route.indexOf("releaseDeadCloudHolds(")).toBeLessThan(route.indexOf("browserOwnerSessionRequest("));
    expect(source).toContain("afterDeviceRevoke: sweepCloudBrowserHolds");
    expect(source).toMatch(/setInterval\(sweepCloudBrowserHolds, 60_000\)/);
  });
});

describe("finding 2: a restore-held retry from the owner's browser needs a code", () => {
  const pem = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "pem", type: "spki" }).toString();
  const request = (proof?: string): IncomingMessage => {
    const headers = { ...(proof ? { "x-murage-owner-proof": proof } : {}) } as IncomingMessage["headers"];
    setCloudIdentity(headers, { id: "dev-1", account: "owner", scope: "browser", publicKey: pem(), assertionKey: pem(), revoked: 0, factor: "remembered-owner", accessHash: "h" } as CloudDevice & { accessHash: string });
    return { headers } as IncomingMessage;
  };
  beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); setBrowserOwnerAct({ token: (i) => `tok:${i.label}:${i.act}`, doorFresh: () => false, verifyProof: (req, _d, act) => req.headers["x-murage-owner-proof"] === `ok:${act}` }); });
  afterEach(() => { vi.unstubAllEnvs(); setBrowserOwnerAct(undefined); });
  test("with no proof the gate answers 403 email_code for restore_release; a proof for another act is refused", async () => {
    expect(await ownerCodeGate(request(), "act-1", "restore_release")).toMatchObject({ status: 403, body: { code: "email_code", label: "restore_release" } });
    expect(await ownerCodeGate(request("ok:other"), "act-1", "restore_release")).toMatchObject({ status: 403, body: { code: "fresh_auth_changed" } });
    expect(await ownerCodeGate(request("ok:act-1"), "act-1", "restore_release")).toBeNull();
  });
  test("the retry handler asks for the code before the hold, the card or the queue changes", () => {
    const start = source.indexOf("held-continuations\\/([\\w-]+)\\/retry$/");
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf("api\\/bots\\/([\\w-]+)\\/respond$/", start));
    const gate = handler.indexOf('"restore_release"');
    expect(gate).toBeGreaterThan(-1);
    expect(handler).toContain("item.restoreHeld && onOwnerBrowser(req.headers)");
    expect(handler).toContain("routeActDigest(method, path + url.search, body)");
    for (const change of ["releaseHeldContinuation(", "consumeTaskHeldContinuations(", "holdTaskContinuation(", "drainHeldContinuations("]) expect(handler.indexOf(change), change).toBeGreaterThan(gate);
  });
});

describe("finding 3: the risk reason is stamped on Cloud homes only", () => {
  test("off a Cloud home the stamp is exactly what it was before the reason existed", () => {
    expect(riskStamp(true, "pay", false)).toEqual({ lowRisk: true });
    expect(riskStamp(false, "pay", false)).toEqual({});
    expect(Object.keys(riskStamp(false, "pay", false))).toEqual([]);
  });
  test("on a Cloud home the reason rides along", () => {
    expect(riskStamp(true, "pay", true)).toEqual({ lowRisk: true, riskReason: "pay" });
    expect(riskStamp(false, "pay", true)).toEqual({ riskReason: "pay" });
  });
});
