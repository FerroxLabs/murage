// SPDX-License-Identifier: AGPL-3.0-or-later
// APPROVE-ALL-1016 7.1 (and U7 C19 after it): one owner-app check. It passes the desktop app and the paired phone APP
// with an attested key, and refuses every browser (paired, passkey, remembered), a keyless app, a Cloud phone, a bot's
// shell and a loopback script. On a Cloud home it reads only the server-set identity; off a home it reads the approval
// device headers only beside the companion marker, the door token and the launch proof, which only the door writes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";

const TOKEN = vi.hoisted(() => {
  const token = "c".repeat(64);
  process.env.MURAGE_COMPANION_TOKEN = token;
  return token;
});

import { ownerAppSurface } from "./owner-app.ts";
import { setCloudIdentity } from "./cloud-request-identity.ts";
import { desktopSurfaceSecret } from "./sse-visibility.ts";
import { isDesktopApp } from "./cloud-owner-surface.ts";

afterEach(() => vi.unstubAllEnvs());

const DEVICE = "4b7a3f6c-1a52-4d1e-9c2e-5a0d7e41b9f3";
const KEY = "B".repeat(87);
const P256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
const desktop = () => ({ "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSurfaceSecret() });
const door = (extra: Record<string, string> = {}): Record<string, string> => ({ "x-murage-companion": "1", "x-murage-door-token": TOKEN, "x-murage-companion-token": TOKEN, ...extra });
const phoneApp = (extra: Record<string, string> = {}): Record<string, string> => door({ "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app", "x-murage-approval-key": KEY, ...extra });
const cloud = (scope: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
  const h = { ...headers }; setCloudIdentity(h, { id: "d1", account: "owner", scope, revoked: false, ...extra } as never); return h;
};

describe("ownerAppSurface off a Cloud home", () => {
  it("passes the desktop app with its renderer secret", () => {
    expect(ownerAppSurface(desktop())).toEqual({ ok: true, app: { kind: "desktop" } });
  });
  it("passes the paired phone app with an attested key, read from the door's headers", () => {
    expect(ownerAppSurface(phoneApp())).toEqual({ ok: true, app: { kind: "phone", device: { id: DEVICE, cls: "app", key: KEY } } });
  });
  it("refuses a paired browser the door forwarded with the launch proof", () => {
    expect(ownerAppSurface(phoneApp({ "x-murage-approval-class": "browser" }))).toEqual({ ok: false, refusal: "on_computer" });
  });
  it("refuses a phone app with no key, and a door request naming no device", () => {
    const { "x-murage-approval-key": _key, ...keyless } = phoneApp();
    expect(ownerAppSurface(keyless)).toEqual({ ok: false, refusal: "unattested" });
    expect(ownerAppSurface(door())).toEqual({ ok: false, refusal: "on_computer" });
  });
  it("never trusts client-sent device headers alone: each companion proof missing or wrong refuses", () => {
    const bare = { "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app", "x-murage-approval-key": KEY };
    expect(ownerAppSurface(bare)).toEqual({ ok: false, refusal: "needs_owner" });
    expect(ownerAppSurface(phoneApp({ "x-murage-companion-token": "d".repeat(64) }))).toEqual({ ok: false, refusal: "needs_owner" });
    expect(ownerAppSurface(phoneApp({ "x-murage-door-token": "d".repeat(64) }))).toEqual({ ok: false, refusal: "needs_owner" });
    const { "x-murage-companion": _marker, ...unmarked } = phoneApp();
    expect(ownerAppSurface(unmarked)).toEqual({ ok: false, refusal: "needs_owner" });
    const { "x-murage-door-token": _door, ...noDoor } = phoneApp();
    expect(ownerAppSurface(noDoor)).toEqual({ ok: false, refusal: "needs_owner" });
  });
  it("refuses a loopback script: the desktop marker without the secret, or with a wrong one", () => {
    expect(ownerAppSurface({ "x-murage-surface": "desktop" })).toEqual({ ok: false, refusal: "needs_owner" });
    expect(ownerAppSurface({ "x-murage-surface": "desktop", "x-murage-surface-secret": "x".repeat(64) })).toEqual({ ok: false, refusal: "needs_owner" });
    expect(ownerAppSurface({})).toEqual({ ok: false, refusal: "needs_owner" });
  });
  it("a door request is never the desktop app, even carrying the desktop marker and secret", () => {
    expect(ownerAppSurface({ ...door(), ...desktop() })).toEqual({ ok: false, refusal: "on_computer" });
  });
});

describe("ownerAppSurface on a Cloud home", () => {
  const home = () => vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  it("passes the owner desktop", () => {
    home();
    expect(ownerAppSurface(cloud("owner-desktop"))).toEqual({ ok: true, app: { kind: "desktop" } });
  });
  it("refuses the passkey browser, which isDesktopApp lets through", () => {
    home();
    const passkey = cloud("browser", { factor: "passkey", publicKey: P256, assertionKey: P256 });
    expect(isDesktopApp(passkey, null)).toBe(true);
    expect(ownerAppSurface(passkey)).toEqual({ ok: false, refusal: "on_computer" });
    expect(ownerAppSurface(cloud("browser", { factor: "remembered-owner", publicKey: P256, assertionKey: P256 }))).toEqual({ ok: false, refusal: "on_computer" });
    expect(ownerAppSurface(cloud("browser", { settingsRead: true }))).toEqual({ ok: false, refusal: "on_computer" });
  });
  it("refuses the owner phone even with device headers it sent itself", () => {
    home();
    expect(ownerAppSurface(cloud("owner-phone", {}, phoneApp()))).toEqual({ ok: false, refusal: "on_computer" });
  });
  it("refuses a revoked device, a service and no identity at all, whatever headers came with them", () => {
    home();
    expect(ownerAppSurface(cloud("owner-desktop", { revoked: true }))).toEqual({ ok: false, refusal: "needs_owner" });
    expect(ownerAppSurface(cloud("service"))).toEqual({ ok: false, refusal: "needs_owner" });
    expect(ownerAppSurface({ ...desktop(), ...phoneApp() })).toEqual({ ok: false, refusal: "needs_owner" });
  });
});

describe("Approve all is gated by the shared check", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const body = (name: string) => {
    const start = src.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n}\n", start));
  };
  it("approveAllSurface decides only through ownerAppSurface, never isDesktopApp, ownerActs or the raw device headers", () => {
    const fn = body("approveAllSurface");
    expect(fn).toContain("ownerAppSurface(req.headers, url.searchParams)");
    for (const name of ["isDesktopApp(", "ownerActs(", "approvalDeviceFrom(", "skipsFreshAuth(", "companionAuthorized("]) expect(fn, name).not.toContain(name);
  });
  it("the bulk fresh-auth skip is the shared desktop answer, not skipsFreshAuth", () => {
    const fn = body("freshAuthRefusalBulk");
    expect(fn).toContain("ownerAppSurface(req.headers, url.searchParams)");
    expect(fn).not.toContain("skipsFreshAuth(");
  });
});
