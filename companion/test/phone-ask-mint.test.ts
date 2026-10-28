import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../src/state.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { handlePhoneBootstrap, PhoneChallenges, type PhoneDoorDevices } from "../src/phone-door.ts";
import { approvalKeyId, phoneJobsMessage } from "../src/phone-jobs-shape.ts";
import { PHONE_ASK_TOKEN, phoneAskMessage } from "../src/phone-ask-shape.ts";
import { KEYS, NOW, statement } from "./support-statement.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const ORIGIN = "https://desk.example.test";
const PROOF = "d".repeat(64);
const CLOCK = 1_700_000_000_000;
const fixture = JSON.parse(readFileSync(join(__dirname, "../../apps/mobile/contract/phone-ask.json"), "utf8"));
const file = () => join(DATA_DIR, "devices.json");
const registry = () => new DeviceRegistry({ statementKeys: KEYS, now: () => NOW });

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { point, keyId: approvalKeyId(point)!, signMessage: (m: string) => sign("sha256", Buffer.from(m), { key: privateKey, dsaEncoding: "der" }).toString("base64url") };
}
const pair = (r: DeviceRegistry, point: string, installId = "install-0123456789abcdef") => {
  const { code } = r.openPairing();
  const res = r.redeem(code, "iPhone", undefined, installId, point, statement(installId, point));
  if ("error" in res) throw new Error(res.error);
  return res.device;
};

function door(r: DeviceRegistry): PhoneDoorDevices {
  return {
    deviceByApprovalKeyId: (id) => r.deviceByApprovalKeyId(id),
    issuePhoneJobsToken: (id) => r.issuePhoneJobsToken(id),
    authenticatePhoneJobs: (t) => r.authenticatePhoneJobs(t),
    clearPhoneJobsToken: (id, only) => r.clearPhoneJobsToken(id, only),
    issuePhoneAskToken: (id) => r.issuePhoneAskToken(id),
    authenticatePhoneAsk: (t) => r.authenticatePhoneAsk(t),
    clearPhoneAskToken: (id, only) => r.clearPhoneAskToken(id, only),
  };
}
const q = (s: string) => new URLSearchParams(s);
let counter = 0;
const challenges = () => new PhoneChallenges({ now: () => CLOCK, random: () => createHash("sha256").update(`ask${counter++}`).digest("base64url") });
const okHarness = async () => ({ status: 200, body: { ok: true } });

async function run(r: DeviceRegistry, c: PhoneChallenges, k: ReturnType<typeof makeKey>, o: { tag: "ask" | "jobs"; scope?: unknown; offeredJobs?: boolean; offeredAsk?: boolean; reuse?: { nonce: string; expiresAt: number } }) {
  const opts = { devices: door(r), challenges: c, offered: async () => o.offeredJobs ?? true, offeredAsk: async () => o.offeredAsk ?? true, harness: okHarness, doorToken: PROOF };
  let nonce: string, expiresAt: number;
  if (o.reuse) ({ nonce, expiresAt } = o.reuse);
  else {
    const ch = await handlePhoneBootstrap({ method: "GET", path: "/api/phones/self/challenge", query: q(`key=${k.keyId}`), body: null, source: "s", origin: ORIGIN }, opts);
    expect(ch.status).toBe(200);
    ({ nonce, expiresAt } = ch.body as { nonce: string; expiresAt: number });
  }
  const fields = { origin: ORIGIN, keyId: k.keyId, nonce, expiresAt };
  const signature = k.signMessage(o.tag === "ask" ? phoneAskMessage(fields) : phoneJobsMessage(fields));
  const body: Record<string, unknown> = { keyId: k.keyId, nonce, expiresAt, signature };
  if (o.scope !== undefined) body.scope = o.scope;
  const answer = await handlePhoneBootstrap({ method: "POST", path: "/api/phones/self/token", query: q(""), body: Buffer.from(JSON.stringify(body)), source: "s", origin: ORIGIN }, opts);
  return { answer, nonce, expiresAt, signature };
}

const raw = () => JSON.parse(readFileSync(file(), "utf8")).devices as Array<Record<string, unknown>>;
beforeEach(() => removeTempDirSync(DATA_DIR));

describe("S26 ask mint at the door", () => {
  it("mints murage_pa_ for an ask signature, bumps askGeneration and stores only a hash", async () => {
    const r = registry(); const k = makeKey(); const d = pair(r, k.point); const c = challenges();
    const { answer } = await run(r, c, k, { tag: "ask", scope: "ask" });
    expect(answer.status).toBe(200);
    const token = (answer.body as { token: string }).token;
    expect(token).toMatch(PHONE_ASK_TOKEN);
    expect(token.startsWith("murage_pa_")).toBe(true);
    expect(r.authenticatePhoneAsk(token)).toEqual({ deviceId: d.id, generation: 1 });
    expect(readFileSync(file(), "utf8")).not.toContain("murage_pa_");
    expect(raw()[0].askGeneration).toBe(1);
  });

  it("verifies the fixture's signed mint vector", async () => {
    const v = fixture.mint.vector;
    const r = registry(); pair(r, v.point);
    const c = new PhoneChallenges({ now: () => CLOCK, random: () => v.nonce });
    const opts = { devices: door(r), challenges: c, offered: async () => true, offeredAsk: async () => true, harness: okHarness, doorToken: PROOF };
    const ch = await handlePhoneBootstrap({ method: "GET", path: "/api/phones/self/challenge", query: q(`key=${v.keyId}`), body: null, source: "s", origin: v.origin }, opts);
    expect((ch.body as { expiresAt: number }).expiresAt).toBe(v.expiresAt);
    const a = await handlePhoneBootstrap({ method: "POST", path: "/api/phones/self/token", query: q(""), body: Buffer.from(JSON.stringify(fixture.tokenRequest.valid)), source: "s", origin: v.origin }, opts);
    expect(a.status).toBe(200);
  });

  it("a jobs-tag signature with scope ask is 403 and the nonce is spent", async () => {
    const r = registry(); const k = makeKey(); pair(r, k.point); const c = challenges();
    const first = await run(r, c, k, { tag: "jobs", scope: "ask" });
    expect(first.answer.status).toBe(403);
    const again = await run(r, c, k, { tag: "ask", scope: "ask", reuse: { nonce: first.nonce, expiresAt: first.expiresAt } });
    expect(again.answer.status).toBe(403);
    expect(raw()[0].askGeneration).toBeUndefined();
  });

  it("an ask-tag signature with scope jobs (or no scope) is 403", async () => {
    const r = registry(); const k = makeKey(); pair(r, k.point); const c = challenges();
    expect((await run(r, c, k, { tag: "ask", scope: "jobs" })).answer.status).toBe(403);
    expect((await run(r, c, k, { tag: "ask" })).answer.status).toBe(403);
    expect(raw()[0].phoneJobs).toBeUndefined();
  });

  it("an unknown scope is a bad request", async () => {
    const r = registry(); const k = makeKey(); pair(r, k.point); const c = challenges();
    expect((await run(r, c, k, { tag: "ask", scope: "admin" })).answer.status).toBe(400);
  });

  it("a device with the switch off gets the bad-signature 403", async () => {
    const r = registry(); const k = makeKey(); const d = pair(r, k.point); const c = challenges();
    expect(r.setShareAskAllowed(d.id, false)).toBe(true);
    const off = await run(r, c, k, { tag: "ask", scope: "ask" });
    expect(off.answer.status).toBe(403);
    const bad = await handlePhoneBootstrap({ method: "POST", path: "/api/phones/self/token", query: q(""), body: Buffer.from(JSON.stringify({ keyId: k.keyId, nonce: "n", expiresAt: 1, signature: "A".repeat(96), scope: "ask" })), source: "s", origin: ORIGIN }, { devices: door(r), challenges: c, offered: async () => true, offeredAsk: async () => true });
    expect(off.answer.body).toEqual(bad.body);
    expect(r.setShareAskAllowed(d.id, true)).toBe(true);
    expect((await run(r, c, k, { tag: "ask", scope: "ask" })).answer.status).toBe(200);
  });

  it("a second mint invalidates the first token", async () => {
    const r = registry(); const k = makeKey(); pair(r, k.point); const c = challenges();
    const a = (await run(r, c, k, { tag: "ask", scope: "ask" })).answer.body as { token: string };
    const b = (await run(r, c, k, { tag: "ask", scope: "ask" })).answer.body as { token: string };
    expect(r.authenticatePhoneAsk(a.token)).toBeNull();
    expect(r.authenticatePhoneAsk(b.token)?.generation).toBe(2);
  });

  it("mints for jobs and ask independently", async () => {
    const r = registry(); const k = makeKey(); const d = pair(r, k.point); const c = challenges();
    const j = (await run(r, c, k, { tag: "jobs", scope: "jobs" })).answer.body as { token: string };
    const a = (await run(r, c, k, { tag: "ask", scope: "ask" })).answer.body as { token: string };
    expect(r.authenticatePhoneJobs(j.token)).toEqual({ deviceId: d.id });
    expect(r.authenticatePhoneAsk(j.token)).toBeNull();
    expect(r.authenticatePhoneJobs(a.token)).toBeNull();
    expect(r.authenticatePhoneAsk(a.token)?.deviceId).toBe(d.id);
  });

  it("a failed harness barrier clears only the ask token", async () => {
    const r = registry(); const k = makeKey(); pair(r, k.point); const c = challenges();
    const opts = { devices: door(r), challenges: c, offered: async () => true, offeredAsk: async () => true, harness: async () => ({ status: 500, body: null }), doorToken: PROOF };
    const ch = await handlePhoneBootstrap({ method: "GET", path: "/api/phones/self/challenge", query: q(`key=${k.keyId}`), body: null, source: "s", origin: ORIGIN }, opts);
    const { nonce, expiresAt } = ch.body as { nonce: string; expiresAt: number };
    const signature = k.signMessage(phoneAskMessage({ origin: ORIGIN, keyId: k.keyId, nonce, expiresAt }));
    const a = await handlePhoneBootstrap({ method: "POST", path: "/api/phones/self/token", query: q(""), body: Buffer.from(JSON.stringify({ keyId: k.keyId, nonce, expiresAt, signature, scope: "ask" })), source: "s", origin: ORIGIN }, opts);
    expect(a.status).toBe(503);
    expect(raw()[0].ask).toBeUndefined();
  });

  it("ask not offered while phone tools are: scope ask is 404 and scope jobs still mints", async () => {
    const r = registry(); const k = makeKey(); pair(r, k.point); const c = challenges();
    const ask = await run(r, c, k, { tag: "ask", scope: "ask", offeredAsk: false });
    expect(ask.answer.status).toBe(404);
    const jobs = await run(r, c, k, { tag: "jobs", scope: "jobs", offeredAsk: false });
    expect(jobs.answer.status).toBe(200);
  });

  it("ask offered alone: the challenge answers and jobs is 404", async () => {
    const r = registry(); const k = makeKey(); pair(r, k.point); const c = challenges();
    expect((await run(r, c, k, { tag: "ask", scope: "ask", offeredJobs: false })).answer.status).toBe(200);
    expect((await run(r, c, k, { tag: "jobs", scope: "jobs", offeredJobs: false })).answer.status).toBe(404);
  });
});

describe("S26 ask registry", () => {
  it("revokePhoneAsk returns the old generation, drops the hash and the old token stops authenticating", () => {
    const r = registry(); const k = makeKey(); const d = pair(r, k.point);
    const t1 = r.issuePhoneAskToken(d.id)!;
    const t2 = r.issuePhoneAskToken(d.id)!;
    expect(t1.generation).toBe(1);
    expect(r.revokePhoneAsk(d.id)).toEqual({ through: 2 });
    expect(r.authenticatePhoneAsk(t2.token)).toBeNull();
    expect(raw()[0].ask).toBeUndefined();
    expect(raw()[0].askGeneration).toBe(3);
    expect(r.revokePhoneAsk("nope")).toBeNull();
  });

  it("setShareAskAllowed(false) revokes, and refuses to issue until allowed again", () => {
    const r = registry(); const k = makeKey(); const d = pair(r, k.point);
    const t = r.issuePhoneAskToken(d.id)!;
    expect(r.setShareAskAllowed(d.id, false)).toBe(true);
    expect(r.authenticatePhoneAsk(t.token)).toBeNull();
    expect(r.issuePhoneAskToken(d.id)).toBeNull();
    expect(raw()[0].shareAskOff).toBe(true);
    expect(r.setShareAskAllowed(d.id, true)).toBe(true);
    expect(raw()[0].shareAskOff).toBeUndefined();
    expect(r.issuePhoneAskToken(d.id)).not.toBeNull();
    expect(r.setShareAskAllowed("nope", true)).toBe(false);
  });

  it("askGeneration survives a reload and never decreases", () => {
    const r = registry(); const k = makeKey(); const d = pair(r, k.point);
    r.issuePhoneAskToken(d.id); r.issuePhoneAskToken(d.id);
    expect(new DeviceRegistry({ statementKeys: KEYS }).issuePhoneAskToken(d.id)?.generation).toBe(3);
    // A hand-edited lower value on disk is ignored by a live registry when it re-reads the file.
    const list = raw();
    list[0].askGeneration = 0;
    writeFileSync(file(), JSON.stringify({ devices: list }));
    (r as unknown as { load(): boolean }).load();
    expect(r.issuePhoneAskToken(d.id)?.generation).toBe(3);
  });

  it("drops a malformed ask record and a junk generation on load", () => {
    const r = registry(); const k = makeKey(); const d = pair(r, k.point);
    r.issuePhoneAskToken(d.id);
    const list = raw();
    list[0].ask = { tokenHash: "zz", issuedAt: "x" };
    list[0].askGeneration = -5;
    list[0].shareAskOff = "yes";
    writeFileSync(file(), JSON.stringify({ devices: list }));
    const fresh = new DeviceRegistry({ statementKeys: KEYS });
    expect(fresh.list()[0].shareAsk).toBe("not-set-up");
    expect(fresh.issuePhoneAskToken(d.id)?.generation).toBeGreaterThanOrEqual(1);
  });

  it("PublicDevice carries shareAsk and none of the ask bookkeeping", () => {
    const r = registry(); const k = makeKey(); const d = pair(r, k.point);
    expect(r.list()[0].shareAsk).toBe("not-set-up");
    r.issuePhoneAskToken(d.id);
    expect(r.list()[0].shareAsk).toBe("on");
    r.setShareAskAllowed(d.id, false);
    const pub = r.list()[0] as unknown as Record<string, unknown>;
    expect(pub.shareAsk).toBe("off");
    for (const key of ["ask", "askGeneration", "shareAskOff", "tokenHash"]) expect(key in pub).toBe(false);
  });
});
