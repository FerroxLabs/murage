import { test } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import assert from "node:assert/strict";
import { CLOUD_HOME_CP, resolveCloudControlPlane } from "./cloud-control-plane.mjs";
import { CLOUD_HOME_CP as reexport, verifyHomeKey } from "./cloud-home-client.mjs";
import { createCloudLiveGate, evaluateCloudLive } from "./cloud-live.mjs";
import { resolveCompanionControlPlaneURL } from "./companion-account-service.mjs";

const jwk = { kty: "EC", crv: "P-256", x: "a", y: "b" };
const table = { staging: CLOUD_HOME_CP.staging, prod: { baseUrl: "https://accounts.murage.ai", jwk } };

test("one table: the client re-exports the resolver's pins", () => assert.equal(reexport, CLOUD_HOME_CP));

test("order: pinned env URL, then built-in prod", () => {
  assert.equal(resolveCloudControlPlane({ env: {}, table }).environment, "prod");
  assert.equal(resolveCloudControlPlane({ env: {}, table }).source, "builtin");
  const staging = resolveCloudControlPlane({ env: { MURAGE_CONTROL_PLANE_URL: CLOUD_HOME_CP.staging.baseUrl + "/" }, table });
  assert.equal(staging.environment, "staging");
  assert.equal(staging.source, "env");
  assert.equal(resolveCloudControlPlane({ env: { MURAGE_CONTROL_PLANE_URL: "https://accounts.murage.ai" }, table }).environment, "prod");
});

test("unpinned or malformed origin is refused, never trusted or replaced by prod", () => {
  for (const url of ["https://evil.example", "http://accounts.murage.ai", "https://accounts.murage.ai/x", "", "nonsense"]) {
    assert.equal(resolveCloudControlPlane({ env: { MURAGE_CONTROL_PLANE_URL: url }, table }), null, url);
  }
});

test("a pin without its JWK is refused", () => {
  const keyless = { staging: CLOUD_HOME_CP.staging, prod: { baseUrl: "https://accounts.murage.ai", jwk: null } };
  assert.equal(resolveCloudControlPlane({ env: {}, table: keyless }), null);
  assert.equal(resolveCloudControlPlane({ env: { MURAGE_CONTROL_PLANE_URL: "https://accounts.murage.ai" }, table: keyless }), null);
});

const HOME = "h".repeat(24);
const envelope = (privateKey) => {
  const now = Date.now();
  const claims = { type: "murage-home-key-v1", homeId: HOME, generation: 1, homeKey: "k", publicOrigin: "https://home.example", issuedAt: now - 1000, expiresAt: now + 600_000 };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { algorithm: "ES256", payload, signature: sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
};
const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" });

test("prod resolves from the built-in table with the pinned public key", () => {
  const cp = resolveCloudControlPlane({ env: {} });
  assert.equal(cp.environment, "prod");
  assert.equal(cp.source, "builtin");
  assert.equal(cp.baseUrl, "https://accounts.murage.ai");
  assert.equal(cp.jwk, CLOUD_HOME_CP.prod.jwk);
  assert.deepEqual(Object.keys(cp.jwk).sort(), ["crv", "kty", "x", "y"]);
  assert.equal(cp.jwk.d, undefined);
  assert.ok(Object.isFrozen(cp.jwk));
  const viaEnv = resolveCloudControlPlane({ env: { MURAGE_CONTROL_PLANE_URL: "https://accounts.murage.ai" } });
  assert.equal(viaEnv.environment, "prod");
  assert.equal(viaEnv.source, "env");
});

test("a home-key envelope signed by a different key is refused for prod", () => {
  assert.throws(() => verifyHomeKey(envelope(stranger.privateKey), CLOUD_HOME_CP.prod.jwk), { code: "pin-mismatch" });
});

test("the staging key is never accepted for prod, nor prod for staging", () => {
  assert.notDeepEqual({ ...CLOUD_HOME_CP.staging.jwk }, { ...CLOUD_HOME_CP.prod.jwk });
  // The same public key signing nothing here: a signature made by an unrelated key fails against BOTH pins.
  for (const env of ["staging", "prod"]) assert.throws(() => verifyHomeKey(envelope(stranger.privateKey), CLOUD_HOME_CP[env].jwk), { code: "pin-mismatch" }, env);
  // An envelope that verifies under key A does not verify under pin B.
  const a = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signed = envelope(a.privateKey);
  assert.equal(verifyHomeKey(signed, a.publicKey.export({ format: "jwk" })).homeId, HOME);
  assert.throws(() => verifyHomeKey(signed, CLOUD_HOME_CP.prod.jwk), { code: "pin-mismatch" });
  assert.throws(() => verifyHomeKey(signed, CLOUD_HOME_CP.staging.jwk), { code: "pin-mismatch" });
});

test("a JWK that carries d is refused", () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.throws(() => verifyHomeKey(envelope(pair.privateKey), pair.privateKey.export({ format: "jwk" })), { code: "pin-mismatch" });
  assert.throws(() => verifyHomeKey(envelope(pair.privateKey), { ...CLOUD_HOME_CP.prod.jwk, d: "x" }), { code: "pin-mismatch" });
});

test("the live gate still decides visibility, not the key", () => {
  const cp = resolveCloudControlPlane({ env: {} });
  assert.equal(evaluateCloudLive(cp, { live: false, origin: cp.baseUrl }), false);
  assert.equal(evaluateCloudLive(cp, { live: true, origin: "https://evil.example" }), false);
  assert.equal(evaluateCloudLive(cp, { live: true, origin: cp.baseUrl }), true);
  const staging = resolveCloudControlPlane({ env: {}, qualification: true });
  assert.equal(evaluateCloudLive(staging, { live: true, origin: staging.baseUrl }), false, "staging is never customer-facing");
  // Every process starts not live: the pinned key alone shows nothing until a verified live:true arrives.
  let answer = { live: true, origin: cp.baseUrl };
  const gate = createCloudLiveGate({ resolve: () => cp, cloudLiveStatus: async () => answer });
  assert.equal(gate.isLive(), false);
  return gate.refresh().then(async () => {
    assert.equal(gate.isLive(), true, "a verified live:true shows Cloud");
    answer = { live: false, origin: cp.baseUrl };
    await gate.refresh();
    assert.equal(gate.isLive(), false, "a verified live:false hides it again");
  });
});

test("staging only for qualification", () => {
  assert.equal(resolveCloudControlPlane({ env: {}, qualification: true }).environment, "staging");
  assert.equal(resolveCloudControlPlane({ env: { MURAGE_CLOUD_CP: "staging" }, qualification: false, table }).environment, "prod");
  assert.equal(resolveCloudControlPlane({ env: { MURAGE_CLOUD_CP: "prod" }, qualification: true, table }).environment, "prod");
});

test("companion service shares the same env parsing and default", () => {
  assert.equal(resolveCompanionControlPlaneURL({ isPackaged: true, environment: {} }), "https://accounts.murage.ai");
  assert.equal(resolveCompanionControlPlaneURL({ isPackaged: false, environment: { MURAGE_CONTROL_PLANE_URL: "http://accounts.murage.ai" } }), "");
});
