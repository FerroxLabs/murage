// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.MURAGE_COMPANION_TOKEN = "c".repeat(64);
});

import { readOwnerPrefs, todayViewRoute, writeOwnerPrefs } from "./owner-prefs.ts";
import { ownerAppSurface } from "./owner-app.ts";
import { setCloudIdentity } from "./cloud-request-identity.ts";
import { desktopSurfaceSecret } from "./sse-visibility.ts";
import { routeAdmits, routePolicy } from "./route-policy.ts";

describe("owner prefs (APPROVE-ALL-1016 section 4)", () => {
  it("the caution shows until the owner dismisses it, and shows again once reset", () => {
    const dir = mkdtempSync(join(tmpdir(), "aab-owner-prefs-"));
    expect(readOwnerPrefs(dir).approveAllCautionDismissed).toBe(false);
    expect(writeOwnerPrefs(dir, { approveAllCautionDismissed: true }).approveAllCautionDismissed).toBe(true);
    expect(readOwnerPrefs(dir).approveAllCautionDismissed).toBe(true);
    expect(writeOwnerPrefs(dir, { approveAllCautionDismissed: false }).approveAllCautionDismissed).toBe(false);
  });
  it("a malformed file reads as the defaults, and a write keeps other keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "aab-owner-prefs-"));
    writeFileSync(join(dir, "owner-prefs.json"), "not json");
    expect(readOwnerPrefs(dir).approveAllCautionDismissed).toBe(false);
    writeFileSync(join(dir, "owner-prefs.json"), JSON.stringify({ approveAllCautionDismissed: "yes", other: 1 }));
    expect(readOwnerPrefs(dir).approveAllCautionDismissed).toBe(false);
    writeOwnerPrefs(dir, { approveAllCautionDismissed: true });
    expect(JSON.parse(readFileSync(join(dir, "owner-prefs.json"), "utf8"))).toEqual({ approveAllCautionDismissed: true, other: 1 });
  });
});

// Today design 2b and test 5: the Calm | Detailed choice. Saved only where the one owner-app check admits (the desktop
// app, a keyed paired phone app), the same check the Approve all caution route uses; every other surface reads it,
// gets canSave false and flips its own visit.
describe("Today view pref (Today design 2b)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const TOKEN = "c".repeat(64);
  const DEVICE = "4b7a3f6c-1a52-4d1e-9c2e-5a0d7e41b9f3";
  const desktop = () => ({ "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSurfaceSecret() });
  const door = (extra: Record<string, string> = {}): Record<string, string> => ({ "x-murage-companion": "1", "x-murage-door-token": TOKEN, "x-murage-companion-token": TOKEN, ...extra });
  const keyedApp = () => door({ "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app", "x-murage-approval-key": "B".repeat(87) });
  const keylessApp = () => door({ "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app" });
  const browserDoor = () => door({ "x-murage-approval-device": DEVICE, "x-murage-approval-class": "browser" });
  const botShell = () => ({ authorization: `Bearer ${"b".repeat(64)}` });
  const cloudPhone = () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const h: Record<string, string> = { ...keyedApp() };
    setCloudIdentity(h, { id: "d1", account: "owner", scope: "owner-phone", revoked: false } as never);
    return h;
  };
  const dir = () => mkdtempSync(join(tmpdir(), "today-view-prefs-"));
  const call = (d: string, method: "GET" | "POST", headers: Record<string, string>, body?: unknown) =>
    todayViewRoute(d, method, ownerAppSurface(headers), body);

  it("reads Calm by default and for anything but the exact string detailed", () => {
    const d = dir();
    expect(readOwnerPrefs(d).todayView).toBe("calm");
    for (const junk of ["Detailed", "DETAILED", " detailed", true, 1, null, ["detailed"], { view: "detailed" }]) {
      writeFileSync(join(d, "owner-prefs.json"), JSON.stringify({ todayView: junk }));
      expect(readOwnerPrefs(d).todayView, JSON.stringify(junk)).toBe("calm");
    }
    writeFileSync(join(d, "owner-prefs.json"), JSON.stringify({ todayView: "detailed" }));
    expect(readOwnerPrefs(d).todayView).toBe("detailed");
  });

  it("a view write keeps approveAllCautionDismissed and every other disk key, and a caution write keeps the view", () => {
    const d = dir();
    writeFileSync(join(d, "owner-prefs.json"), JSON.stringify({ approveAllCautionDismissed: true, other: 1 }));
    expect(writeOwnerPrefs(d, { todayView: "detailed" })).toEqual({ approveAllCautionDismissed: true, todayView: "detailed", firstRunJobs: { pending: [] } });
    writeOwnerPrefs(d, { approveAllCautionDismissed: false });
    expect(JSON.parse(readFileSync(join(d, "owner-prefs.json"), "utf8"))).toEqual({ approveAllCautionDismissed: false, other: 1, todayView: "detailed" });
    writeOwnerPrefs(d, { todayView: "junk" as never });
    expect(readOwnerPrefs(d).todayView).toBe("detailed");
  });

  it("the desktop app and a keyed phone app save, and both read the same view with canSave true", () => {
    const d = dir();
    expect(call(d, "GET", desktop())).toEqual({ status: 200, body: { view: "calm", canSave: true } });
    expect(call(d, "POST", keyedApp(), { view: "detailed" })).toEqual({ status: 200, body: { view: "detailed", canSave: true } });
    expect(call(d, "GET", desktop())).toEqual({ status: 200, body: { view: "detailed", canSave: true } });
    expect(call(d, "POST", desktop(), { view: "calm" })).toEqual({ status: 200, body: { view: "calm", canSave: true } });
    expect(call(d, "GET", keyedApp())).toEqual({ status: 200, body: { view: "calm", canSave: true } });
  });

  it("POST answers 400 on anything but calm or detailed, and writes nothing", () => {
    const d = dir();
    for (const body of [{ view: "Detailed" }, { view: "" }, { view: true }, {}, null, "detailed", ["detailed"]]) {
      expect(call(d, "POST", desktop(), body).status, JSON.stringify(body)).toBe(400);
    }
    expect(readOwnerPrefs(d).todayView).toBe("calm");
  });

  it("the browser door, a Cloud phone, a keyless app and a bot's capability are refused, and GET says canSave false", () => {
    const d = dir();
    writeOwnerPrefs(d, { todayView: "detailed" });
    for (const [name, headers] of [["browser door", browserDoor], ["Cloud phone", cloudPhone], ["keyless app", keylessApp], ["bot capability", botShell], ["no proof", () => ({})]] as const) {
      expect(call(d, "POST", headers(), { view: "calm" }).status, name).toBe(403);
      expect(call(d, "GET", headers()), name).toEqual({ status: 200, body: { view: "detailed", canSave: false } });
      vi.unstubAllEnvs();
    }
    expect(readOwnerPrefs(d).todayView).toBe("detailed");
  });

  it("both routes are conversation routes with an ordinary Cloud write, and a bot's capability never reaches them", () => {
    for (const method of ["GET", "POST"]) {
      const row = routePolicy(method, "/api/owner-prefs/today-view");
      expect(row?.class, method).toBe("conversation");
      expect(row?.cloudWrite, method).toBe("ordinary");
    }
    expect(routeAdmits("conversation", { desktop: false, companion: false, door: false, bot: true })).toBe(false);
  });

  it("index.ts decides the caller only through ownerAppSurface, as the caution route does", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = src.indexOf('path === "/api/owner-prefs/today-view"');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("\n    }\n", start));
    expect(block).toContain("ownerAppSurface(req.headers, url.searchParams)");
    for (const name of ["isDesktopApp(", "ownerActs(", "approvalDeviceFrom(", "localStorage"]) expect(block, name).not.toContain(name);
  });
});
