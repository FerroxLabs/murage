// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATE: the desktop ships the live production control-plane pin. Without CLOUD_HOME_CP.prod.jwk every production
// Cloud home is refused, and a stale copy once carried it as null.
import { describe, expect, it } from "vitest";
import { CLOUD_HOME_CP, resolveCloudControlPlane } from "./cloud-control-plane.mjs";

// The live pin is public. It MUST change together with the control plane's env-policy SIGNING_PINS[live].
// scripts/packaged-prod-pin.mjs (afterPack) proves the packaged module is byte-identical to this source.
const LIVE_PROD_PIN = { kty: "EC", crv: "P-256", x: "B3u5CZzfv4sBQKMvGYS-zblweYQNdEx_fBpOnpc8_KY", y: "bt8PYOR1VLwj1b-WbG6M81RHC_NJ4N1BX8OV0ai3gyU" };

describe("production control-plane pin", () => {
  const jwk = CLOUD_HOME_CP.prod.jwk;

  it("prod.jwk is present and is a public EC P-256 key", () => {
    expect(jwk).not.toBeNull();
    expect(typeof jwk).toBe("object");
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(typeof jwk.x === "string" && jwk.x.length > 0).toBe(true);
    expect(typeof jwk.y === "string" && jwk.y.length > 0).toBe(true);
    expect(Object.getPrototypeOf(jwk)).toBe(Object.prototype);
    expect(Reflect.ownKeys(jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect("d" in jwk).toBe(false);
    expect(Object.isFrozen(jwk) && Object.isFrozen(CLOUD_HOME_CP.prod) && Object.isFrozen(CLOUD_HOME_CP)).toBe(true);
  });

  it("prod.jwk equals the live pin", () => {
    expect({ ...jwk }).toEqual(LIVE_PROD_PIN);
  });

  it("staging and prod are different entries with different keys", () => {
    expect(CLOUD_HOME_CP.staging).not.toBe(CLOUD_HOME_CP.prod);
    expect(CLOUD_HOME_CP.staging.baseUrl).not.toBe(CLOUD_HOME_CP.prod.baseUrl);
    expect(CLOUD_HOME_CP.staging.jwk).toBeTruthy();
    expect(CLOUD_HOME_CP.staging.jwk.x).not.toBe(jwk.x);
    expect(CLOUD_HOME_CP.staging.jwk.y).not.toBe(jwk.y);
  });

  it("the built-in default resolves to prod with the live pin", () => {
    const resolved = resolveCloudControlPlane({ env: {} });
    expect(resolved?.environment).toBe("prod");
    expect({ ...resolved.jwk }).toEqual(LIVE_PROD_PIN);
  });
});
