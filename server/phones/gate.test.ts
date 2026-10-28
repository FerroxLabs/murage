// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { IncomingHttpHeaders } from "node:http";
import { ensurePhonesTables, phoneAskCaller, phoneCaller } from "./gate.ts";
import { routeAdmits, routeClass, routePolicy } from "../route-policy.ts";

const DOOR = "d".repeat(64);
const door = (h: IncomingHttpHeaders) => h["x-murage-door-token"] === DOOR;
const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'phone_%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);

describe("phoneCaller", () => {
  it("admits the door envelope: token, scope jobs, a device id", () => {
    expect(phoneCaller({ "x-murage-door-token": DOOR, "x-murage-phone-scope": "jobs", "x-murage-phone-device": "dev-1_A" }, door)).toEqual({ deviceId: "dev-1_A" });
  });
  it("refuses everyone else", () => {
    const base = { "x-murage-door-token": DOOR, "x-murage-phone-scope": "jobs", "x-murage-phone-device": "dev-1" };
    expect(phoneCaller({ "x-murage-desktop-secret": "x" }, door)).toBeNull();
    expect(phoneCaller({ "x-murage-phone-scope": "jobs", "x-murage-phone-device": "dev-1" }, door)).toBeNull();
    expect(phoneCaller({ "x-murage-door-token": DOOR }, door)).toBeNull();
    expect(phoneCaller({ "x-murage-door-token": DOOR, "x-murage-phone-scope": "jobs" }, door)).toBeNull();
    expect(phoneCaller({ "x-murage-door-token": DOOR, "x-murage-phone-device": "dev-1" }, door)).toBeNull();
    expect(phoneCaller({ ...base, "x-murage-phone-scope": "owner" }, door)).toBeNull();
    expect(phoneCaller({ ...base, "x-murage-door-token": "bad" }, door)).toBeNull();
    expect(phoneCaller({ ...base, "x-murage-phone-device": "a b" }, door)).toBeNull();
    expect(phoneCaller({ ...base, "x-murage-phone-device": "" }, door)).toBeNull();
    expect(phoneCaller({ ...base, "x-murage-phone-device": "x".repeat(129) }, door)).toBeNull();
    expect(phoneCaller({ ...base, "x-murage-phone-device": ["a", "b"] }, door)).toBeNull();
  });
});

describe("phone route class", () => {
  it("classifies the phone routes", () => {
    expect(routeClass("GET", "/api/phones/self/jobs")).toBe("phone");
    expect(routeClass("POST", "/api/phones/self")).toBe("phone");
    expect(routeClass("POST", "/api/phones/revoke")).toBe("companion");
    expect(routeClass("POST", "/api/phones/minted")).toBe("companion");
    expect(routeClass("GET", "/api/phones")).toBe("desktop");
    expect(routeClass("GET", "/api/phones/selfish")).toBe("desktop");
    expect(routePolicy("GET", "/api/phones/self/jobs")?.why.length).toBeGreaterThan(10);
  });
  it("admits at the gate; the route proves the caller", () => {
    expect(routeAdmits("phone", { desktop: false, companion: false, door: false, bot: false })).toBe(true);
  });
});

describe("ensurePhonesTables", () => {
  it("creates nothing with the flag off or missing", () => {
    const db = new DatabaseSync(":memory:");
    let opened = 0;
    for (const features of [undefined, {}, { phoneTools: false }, { phoneTools: "true" }]) expect(ensurePhonesTables(() => { opened++; return db; }, features)).toBe(false);
    expect(opened).toBe(0);
    expect(tables(db)).toEqual([]);
  });
  it("creates both tables with the flag on, and is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    expect(ensurePhonesTables(() => db, { phoneTools: true })).toBe(true);
    expect(ensurePhonesTables(() => db, { phoneTools: true })).toBe(true);
    expect(tables(db)).toEqual(["phone_registrations", "phone_revocations"]);
  });
});

describe("phoneAskCaller", () => {
  const ask = { "x-murage-door-token": DOOR, "x-murage-phone-scope": "ask", "x-murage-phone-device": "dev-1", "x-murage-phone-ask-gen": "7" };
  it("admits the door's ask envelope with its generation", () => {
    expect(phoneAskCaller(ask, door)).toEqual({ deviceId: "dev-1", generation: 7 });
    expect(phoneAskCaller({ ...ask, "x-murage-phone-ask-gen": "0" }, door)).toEqual({ deviceId: "dev-1", generation: 0 });
    expect(phoneAskCaller({ ...ask, "x-murage-phone-ask-gen": String(Number.MAX_SAFE_INTEGER) }, door)?.generation).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("refuses a jobs-scope envelope, and phoneCaller refuses an ask-scope one", () => {
    expect(phoneAskCaller({ ...ask, "x-murage-phone-scope": "jobs" }, door)).toBeNull();
    expect(phoneCaller(ask, door)).toBeNull();
  });
  it("refuses a missing or malformed generation", () => {
    const { "x-murage-phone-ask-gen": _gone, ...missing } = ask;
    expect(phoneAskCaller(missing, door)).toBeNull();
    for (const bad of ["", "-1", "1.5", "01", "1e3", " 7", "7 ", "abc", "9007199254740992", "99999999999999999999", "0x10"]) {
      expect(phoneAskCaller({ ...ask, "x-murage-phone-ask-gen": bad }, door)).toBeNull();
    }
    expect(phoneAskCaller({ ...ask, "x-murage-phone-ask-gen": ["1", "2"] }, door)).toBeNull();
  });
  it("refuses a bad token, scope, or device id", () => {
    expect(phoneAskCaller({ ...ask, "x-murage-door-token": "bad" }, door)).toBeNull();
    expect(phoneAskCaller({ ...ask, "x-murage-phone-scope": "owner" }, door)).toBeNull();
    expect(phoneAskCaller({ ...ask, "x-murage-phone-device": "a b" }, door)).toBeNull();
    expect(phoneAskCaller({ ...ask, "x-murage-phone-device": undefined }, door)).toBeNull();
  });
});
