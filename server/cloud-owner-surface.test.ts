// SPDX-License-Identifier: AGPL-3.0-or-later
// On a Cloud home the paired phone is an owner proof for approvals, but it is not the desktop app: the handlers that
// are reserved for the desktop app (browser approval mode, site grants, the action check) and the fresh-auth gate
// must tell the two apart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCloudIdentity } from "./cloud-request-identity.ts";
import { readFileSync } from "node:fs";
import { cloudPhoneHighRiskRefusal, isDesktopApp, ownerSurface, skipsFreshAuth } from "./cloud-owner-surface.ts";
import { companionAuthorized } from "./companion-authority.ts";

beforeEach(() => vi.stubEnv("MURAGE_CLOUD_ROLE", "home"));
afterEach(() => vi.unstubAllEnvs());
const as = (scope: string, extra: Record<string, unknown> = {}) => {
  const headers = {}; setCloudIdentity(headers, { id: "d1", account: "owner", scope, revoked: false, ...extra } as any); return headers;
};
const ownerBrowser = () => as("browser", { factor: "passkey", publicKey: P256, assertionKey: P256 });
import { generateKeyPairSync } from "node:crypto";
const P256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();

describe("cloud home desktop-app surface", () => {
  it("N1: the owner desktop is the desktop app and the owner phone is not", () => {
    expect(isDesktopApp(as("owner-desktop"), null)).toBe(true);
    expect(isDesktopApp(as("owner-phone"), null)).toBe(false);
  });
  it("B2: an owner-phone approval is held to fresh auth while the owner desktop is not", () => {
    expect(skipsFreshAuth(as("owner-desktop"), null)).toBe(true);
    expect(skipsFreshAuth(as("owner-phone"), null)).toBe(false);
  });
});

describe("cloud home companion authority", () => {
  it("B1: a bare door browser is not owner proof; desktop, phone and owner browser are", () => {
    expect(companionAuthorized(as("browser"))).toBe(false);
    expect(companionAuthorized(as("owner-desktop"))).toBe(true);
    expect(companionAuthorized(as("owner-phone"))).toBe(true);
    expect(companionAuthorized(ownerBrowser())).toBe(true);
  });
});

describe("browser extension owner actions on a cloud home", () => {
  it("N1: the owner phone acts as the phone and the owner desktop as the desktop", () => {
    expect(ownerSurface(as("owner-desktop"), null)).toBe("desktop");
    expect(ownerSurface(as("owner-phone"), null)).toBe("phone");
  });
  it("N1: no handler in the browser extension route group reads the raw surface", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.indexOf('path === "/api/browser-extension/clients"');
    const end = source.indexOf("const paired = companionAuthorized(req.headers);", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end).match(/requestSurface\(/g) ?? []).toEqual([]);
    const setup = source.indexOf('/browser-setup\\/([\\w-]+)$/');
    expect(source.slice(setup, start).match(/requestSurface\(/g) ?? []).toEqual([]);
  });
});

describe("cloud phone high-risk Allow", () => {
  it("B2: a phone supplying its own approval key is refused; the desktop and other scopes are not held by it", () => {
    const POINT = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
    const phone = as("owner-phone") as Record<string, unknown>;
    phone["x-murage-approval-device"] = "11111111-1111-4111-8111-111111111111"; phone["x-murage-approval-class"] = "app"; phone["x-murage-approval-key"] = POINT;
    expect(cloudPhoneHighRiskRefusal(phone as any)?.status).toBe(403);
    expect(cloudPhoneHighRiskRefusal(as("owner-desktop"))).toBeNull();
    expect(cloudPhoneHighRiskRefusal(ownerBrowser())).toBeNull();
  });
});
