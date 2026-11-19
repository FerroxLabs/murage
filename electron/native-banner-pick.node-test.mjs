// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { pickNativeBanner } from "./native-banner-pick.mjs";

test("selects only the matching platform adapter without probing or opening it", () => {
  const mac = { available() { assert.fail("picker must not probe"); } };
  const linux = { available() { assert.fail("picker must not probe"); } };
  assert.equal(pickNativeBanner({ platform: "darwin", mac, linux }), mac);
  assert.equal(pickNativeBanner({ platform: "linux", mac, linux }), linux);
  for (const platform of ["win32", "unknown", undefined, null]) {
    assert.equal(pickNativeBanner({ platform, mac, linux }), null);
  }
  assert.equal(pickNativeBanner({ platform: "linux", mac }), null);
  assert.equal(pickNativeBanner({ platform: "darwin", linux }), null);
});
