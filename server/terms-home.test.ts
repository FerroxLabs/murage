// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A Cloud home reads the control plane's signed terms proof, so a customer who agreed at checkout never meets "Before you start".
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TERMS_VERSION } from "../shared/terms.ts";
import { createTermsHome, handleTermsApi, readTermsRecords, recordTermsAcceptance, termsStatus, type TermsHome } from "./terms.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import type { CpResult } from "./cloud-home/cp-client.ts";

const CP = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const OTHER = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = CP.publicKey.export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string; y?: string };
const ACCEPTED = Date.parse("2026-10-20T10:00:00.000Z");
const ISSUED = ACCEPTED + 60_000;
const NOW = ISSUED + 1000;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const envelope = (over: Record<string, unknown> = {}, key = CP.privateKey) => {
  const claims = {
    type: "murage-terms-v1", homeId: "home_1", generation: 3, account: "acct_1", homeTermsVersion: TERMS_VERSION,
    documents: { cloudTerms: "cloud-terms-aaaaaaaaaaaa", termsOfService: "terms-of-service-bbbbbbbbbbbb", privacyPolicy: "privacy-policy-cccccccccccc" },
    ageConfirmed: true, acceptedAt: ACCEPTED, source: "checkout", acceptanceId: "acc_1", consentId: "con_1", screenVersion: "s1", graceUntil: null, issuedAt: ISSUED, ...over,
  };
  const payload = b64(claims);
  return { payload, signature: sign("sha256", Buffer.from(payload), { key, dsaEncoding: "ieee-p1363" }).toString("base64url") };
};

let dir: string;
let owner: string | undefined;
let calls: { op: string; fields: Record<string, unknown>; timeoutMs?: number }[];
let answer: () => Promise<CpResult>;
let clock: number;
let home: TermsHome;
let generation: number;
const reset = () => {
  owner = "acct_1"; calls = []; clock = NOW; generation = 3;
  answer = async () => ({ ok: true, status: 200, body: { status: "proof", proof: envelope() } });
  home = createTermsHome({
    binding: () => ({ homeId: "home_1", generation, publicJwk: jwk }),
    owner: () => owner,
    call: async (op, fields, opts) => { calls.push({ op, fields, timeoutMs: opts.timeoutMs }); return answer(); },
    now: () => clock,
  });
};
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "murage-terms-home-")); reset(); });
afterEach(() => { removeTempDirSync(dir); });
const ENV = { MURAGE_CLOUD_ROLE: "home" } as NodeJS.ProcessEnv;
const get = async (fresh = false, env = ENV) => (await handleTermsApi({ method: "GET", path: "/api/terms", readBody: async () => ({}), fresh }, dir, env, home, () => Boolean(owner)))!;
const post = async () => (await handleTermsApi({ method: "POST", path: "/api/terms/accept", readBody: async () => ({ version: TERMS_VERSION, ageConfirmed: true }) }, dir, ENV, home, () => true))!;
const file = () => join(dir, "terms-acceptance.json");
const seed = async () => { await get(); expect(readTermsRecords(dir)).toHaveLength(1); };
const counted = () => (termsStatus(dir, ENV, home).accepted);

describe("home terms proof", () => {
  it("seeds the record from a good proof: no screen, acceptedAt is the checkout time", async () => {
    const answerNow = await get();
    expect(answerNow.status).toBe(200);
    expect(answerNow.body).toMatchObject({ accepted: true, acceptedAt: new Date(ACCEPTED).toISOString(), source: "record" });
    expect(calls).toEqual([{ op: "terms-proof", fields: { homeTermsVersion: TERMS_VERSION }, timeoutMs: 3000 }]);
    const row = JSON.parse(readFileSync(file(), "utf8")).accepted[0];
    expect(row).toMatchObject({ version: TERMS_VERSION, acceptedAt: new Date(ACCEPTED).toISOString(), source: "checkout" });
    expect(Object.keys(row.proof).sort()).toEqual(["payload", "signature"]);
  });

  it("a stored row is counted without asking again; a restart (new reader) still counts it", async () => {
    await seed();
    calls.length = 0;
    expect((await get()).body).toMatchObject({ accepted: true });
    expect(calls).toHaveLength(0);
    reset();
    expect(counted()).toBe(true);
  });

  const bad: [string, () => ReturnType<typeof envelope>][] = [
    ["a forged signature", () => envelope({}, OTHER.privateKey)],
    ["another home", () => envelope({ homeId: "home_2" })],
    ["another generation", () => envelope({ generation: 4 })],
    ["another account", () => envelope({ account: "acct_2" })],
    ["a different terms version", () => envelope({ homeTermsVersion: "2026-01-01" })],
    ["age not confirmed", () => envelope({ ageConfirmed: false })],
    ["accepted after it was issued", () => envelope({ acceptedAt: ISSUED + 5 })],
    ["an unknown extra field", () => envelope({ extra: 1 })],
  ];
  for (const [name, make] of bad) {
    it(`refuses ${name}: nothing written, screen shows (200, not accepted)`, async () => {
      answer = async () => ({ ok: true, status: 200, body: { status: "proof", proof: make() } });
      const res = await get();
      expect(res.status === 200 || res.status === 503).toBe(true);
      expect(readTermsRecords(dir)).toEqual([]);
      expect(counted()).toBe(false);
    });
  }

  it("a tampered payload (one byte changed) fails the signature", async () => {
    const good = envelope();
    const payload = b64({ ...JSON.parse(Buffer.from(good.payload, "base64url").toString()), account: "acct_9" });
    answer = async () => ({ ok: true, status: 200, body: { status: "proof", proof: { payload, signature: good.signature } } });
    await get();
    expect(counted()).toBe(false);
  });

  it("a stored row with its proof but a changed acceptedAt is not counted", async () => {
    await seed();
    const data = JSON.parse(readFileSync(file(), "utf8"));
    data.accepted[0].acceptedAt = new Date(ACCEPTED - 86_400_000).toISOString();
    writeFileSync(file(), JSON.stringify(data));
    expect(counted()).toBe(false);
  });

  it("a row written by anyone with no proof never counts on a home, whatever its source says", () => {
    const at = new Date(ACCEPTED).toISOString();
    for (const source of [undefined, "checkout", "reaccept"]) {
      writeFileSync(file(), JSON.stringify({ accepted: [{ version: TERMS_VERSION, acceptedAt: at, ...(source ? { source } : {}) }] }));
      expect(counted()).toBe(false);
    }
  });

  it("the source label can be removed or changed: the row still counts, because its proof verifies", async () => {
    await seed();
    const data = JSON.parse(readFileSync(file(), "utf8"));
    delete data.accepted[0].source;
    writeFileSync(file(), JSON.stringify(data));
    expect(counted()).toBe(true);
    data.accepted[0].source = "reaccept";
    writeFileSync(file(), JSON.stringify(data));
    expect(counted()).toBe(true);
  });

  it("the envelope survives a read and a rewrite by the record code", async () => {
    await seed();
    const before = readTermsRecords(dir)[0].proof;
    expect(before).toBeTruthy();
    // an older-version row beside it is rewritten by a desktop-style acceptance of another version
    const data = JSON.parse(readFileSync(file(), "utf8"));
    data.accepted.unshift({ version: "2025-01-01", acceptedAt: "2025-01-02T00:00:00.000Z" });
    writeFileSync(file(), JSON.stringify(data));
    expect(readTermsRecords(dir).find((r) => r.version === TERMS_VERSION)?.proof).toEqual(before);
    expect(readTermsRecords(dir).find((r) => r.version === TERMS_VERSION)?.source).toBe("checkout");
    expect(counted()).toBe(true);
  });

  it("an owner of a different generation: a restore into a new generation re-checks the proof and refuses the old one", async () => {
    await seed();
    generation = 4;
    expect(counted()).toBe(false);
  });

  it("POST accept on a home answers 409 accept_on_site and writes nothing", async () => {
    const res = await post();
    expect(res).toMatchObject({ status: 409, body: { code: "accept_on_site" } });
    expect(() => readFileSync(file())).toThrow();
    expect(calls).toHaveLength(0);
  });

  it("control plane unreachable answers 503 and writes nothing; a later answer works", async () => {
    answer = async () => ({ ok: false, status: 0 });
    expect((await get()).status).toBe(503);
    expect((await get()).status).toBe(503);
    expect(() => readFileSync(file())).toThrow();
    answer = async () => ({ ok: true, status: 200, body: { status: "proof", proof: envelope() } });
    expect((await get()).body).toMatchObject({ accepted: true });
  });

  it("makes no control-plane call before an owner exists", async () => {
    owner = undefined;
    const res = await get();
    expect(res).toMatchObject({ status: 200, body: { accepted: false } });
    expect(calls).toHaveLength(0);
  });

  it("two reads at once are one call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answer = async () => { await gate; return { ok: true, status: 200, body: { status: "proof", proof: envelope() } }; };
    const both = Promise.all([get(), get()]);
    await Promise.resolve();
    release();
    const [a, b] = await both;
    expect(calls).toHaveLength(1);
    expect(a.body).toMatchObject({ accepted: true });
    expect(b.body).toMatchObject({ accepted: true });
  });

  it("none shows the screen and is remembered for 30 s; fresh skips the memory after 5 s", async () => {
    answer = async () => ({ ok: true, status: 200, body: { status: "none" } });
    expect((await get()).body).toMatchObject({ accepted: false });
    expect((await get()).body).toMatchObject({ accepted: false });
    expect(calls).toHaveLength(1);
    clock += 6000;
    await get(true);
    expect(calls).toHaveLength(2);
    clock += 24_000;
    await get();
    expect(calls).toHaveLength(2);
    clock += 31_000;
    await get();
    expect(calls).toHaveLength(3);
  });

  it("a notice-period proof is held in memory only, never written, and ignored after graceUntil", async () => {
    const graceUntil = NOW + 3 * 86_400_000;
    answer = async () => ({ ok: true, status: 200, body: { status: "proof", proof: envelope({ source: "notice-period", graceUntil }) } });
    expect((await get()).body).toMatchObject({ accepted: true });
    expect(() => readFileSync(file())).toThrow();
    expect(readTermsRecords(dir)).toEqual([]);
    calls.length = 0;
    expect((await get()).body).toMatchObject({ accepted: true });
    expect(calls).toHaveLength(0);
    clock = graceUntil + 1;
    answer = async () => ({ ok: true, status: 200, body: { status: "none" } });
    expect((await get()).body).toMatchObject({ accepted: false });
    expect(calls).toHaveLength(1);
    // a notice-period proof already past its time is not held either
    reset();
    answer = async () => ({ ok: true, status: 200, body: { status: "proof", proof: envelope({ source: "notice-period", graceUntil: NOW - 1 }) } });
    expect((await get()).body).toMatchObject({ accepted: false });
  });

  it("a notice-period proof written into the file by someone never counts", async () => {
    const stored = envelope({ source: "notice-period", graceUntil: NOW + 86_400_000 });
    writeFileSync(file(), JSON.stringify({ accepted: [{ version: TERMS_VERSION, acceptedAt: new Date(ACCEPTED).toISOString(), source: "checkout", proof: stored }] }));
    expect(counted()).toBe(false);
  });

  it("MURAGE_TERMS_ACCEPTED is ignored on a home", async () => {
    owner = undefined;
    const res = await get(false, { ...ENV, MURAGE_TERMS_ACCEPTED: TERMS_VERSION });
    expect(res.body).toMatchObject({ accepted: false });
    expect(termsStatus(dir, { MURAGE_TERMS_ACCEPTED: TERMS_VERSION }).source).toBe("environment");
  });
});

describe("off a home nothing changes", () => {
  it("POST accept still records, with the same three-field shape and no source or proof", async () => {
    const res = await handleTermsApi({ method: "POST", path: "/api/terms/accept", readBody: async () => ({ version: TERMS_VERSION, ageConfirmed: true, appVersion: "1.0.2" }) }, dir, {});
    expect(res?.status).toBe(200);
    const row = JSON.parse(readFileSync(file(), "utf8")).accepted[0];
    expect(Object.keys(row).sort()).toEqual(["acceptedAt", "appVersion", "version"]);
    expect(termsStatus(dir, {}).accepted).toBe(true);
  });

  it("an unsigned row counts off a home, and the environment declaration still works", () => {
    recordTermsAcceptance({}, dir);
    expect(termsStatus(dir, {})).toMatchObject({ accepted: true, source: "record" });
    expect(termsStatus(mkdtempSync(join(tmpdir(), "murage-terms-x-")), { MURAGE_TERMS_ACCEPTED: TERMS_VERSION }).source).toBe("environment");
  });
});
