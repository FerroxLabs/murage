/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The inverted default. Wayland ships `ALLOW_REMOTE=true` -> `0.0.0.0`; these
 * tests exist so that no future edit can make Murage do the same by accident.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BindRefused, LOOPBACK, isWildcard, resolveBindAddress, resolveBindFromEnv } from "../lib/bind.mjs";

const v4 = (address) => ({ address, family: "IPv4", internal: false });
const v6 = (address) => ({ address, family: "IPv6", internal: false });
const WITH_TAILNET = {
  interfaces: () => ({
    eth0: [v4("134.199.200.10")],
    tailscale0: [v4("100.81.158.63"), v6("fd7a:115c:a1e0::1234:5678")],
  }),
};
const NO_TAILNET = { interfaces: () => ({ eth0: [v4("134.199.200.10")] }) };

test("the default is loopback, with no configuration at all", () => {
  const r = resolveBindAddress({ probe: NO_TAILNET });
  assert.equal(r.address, LOOPBACK);
  assert.equal(r.mode, "loopback");
});

test("every spelling of the wildcard is refused", () => {
  for (const wild of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "*", "0", "::0", "  0.0.0.0  "]) {
    assert.equal(isWildcard(wild), true, wild);
    assert.throws(
      () => resolveBindAddress({ address: wild, probe: WITH_TAILNET }),
      (e) => e instanceof BindRefused && e.code === "WILDCARD_REFUSED",
      `expected a refusal for ${wild}`
    );
  }
});

test("HOST=0.0.0.0, the thing a copied tutorial tells you to set, is refused", () => {
  assert.throws(
    () => resolveBindFromEnv({ HOST: "0.0.0.0" }, WITH_TAILNET),
    (e) => e.code === "WILDCARD_REFUSED"
  );
  assert.throws(
    () => resolveBindFromEnv({ MURAGE_HOST: "0.0.0.0" }, WITH_TAILNET),
    (e) => e.code === "WILDCARD_REFUSED"
  );
});

test("a LAN or public address is refused even though it is not the wildcard", () => {
  for (const addr of ["134.199.200.10", "192.168.1.20", "10.0.0.4", "8.8.8.8"]) {
    assert.throws(
      () => resolveBindAddress({ address: addr, probe: WITH_TAILNET }),
      (e) => e instanceof BindRefused && e.code === "NOT_LOOPBACK_OR_TAILNET",
      addr
    );
  }
});

test("tailnet mode resolves to this host's own tailnet address", () => {
  const r = resolveBindAddress({ mode: "tailnet", probe: WITH_TAILNET });
  assert.equal(r.address, "100.81.158.63");
  assert.equal(r.mode, "tailnet");
});

test("tailnet mode REFUSES TO START when there is no tailnet address", () => {
  // This is the requirement in one line: a box whose enrolment failed does not
  // quietly fall back to something reachable.
  assert.throws(
    () => resolveBindAddress({ mode: "tailnet", probe: NO_TAILNET }),
    (e) => e instanceof BindRefused && e.code === "NO_TAILNET_ADDRESS"
  );
});

test("an explicit tailnet address is accepted; a stale one from another host is not", () => {
  assert.equal(resolveBindAddress({ address: "100.81.158.63", probe: WITH_TAILNET }).mode, "tailnet");
  assert.throws(
    () => resolveBindAddress({ address: "100.81.158.63", probe: NO_TAILNET }),
    (e) => e.code === "NOT_LOOPBACK_OR_TAILNET"
  );
});

test("an unknown mode is refused rather than defaulted", () => {
  assert.throws(
    () => resolveBindAddress({ mode: "public", probe: WITH_TAILNET }),
    (e) => e.code === "UNKNOWN_MODE"
  );
  assert.throws(
    () => resolveBindAddress({ mode: "all", probe: WITH_TAILNET }),
    (e) => e.code === "UNKNOWN_MODE"
  );
});

test("there is no input that yields a wildcard bind", () => {
  const attempts = [
    {}, { mode: "loopback" }, { mode: "tailnet" }, { mode: "LOOPBACK" }, { mode: " tailnet " },
    { address: "127.0.0.1" }, { address: "::1" }, { address: "100.81.158.63" },
  ];
  for (const attempt of attempts) {
    let out = null;
    try {
      out = resolveBindAddress({ ...attempt, probe: WITH_TAILNET });
    } catch (e) {
      assert.ok(e instanceof BindRefused, `unexpected error for ${JSON.stringify(attempt)}: ${e}`);
      continue;
    }
    assert.equal(isWildcard(out.address), false, `${JSON.stringify(attempt)} produced ${out.address}`);
  }
});
