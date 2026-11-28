// W9 on a Cloud home (TEACH-ENTRY 1.0.23 D6): the Taught-by-you routes do not exist there. An owner-desktop session is
// "desktop" surface in a Cloud home, so it passes the surface check at server/index.ts and reaches the isCloudHome 404
// guard; the recording on disk must not be listed or changed. A booted Cloud-home server, paired like cloud-auth-api.test.ts.
import { request } from "node:http";
import { createHmac, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stepPurpose } from "./cloud-request-auth.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const origin = "https://home.example.test", secret = "fixture-bootstrap-secret-32-characters"; // secret-scan: fixture
const cpKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), cpKeyPem = cpKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
let fixture: VerificationServer, environmentId: string, ownerToken: string, ownerDeviceId: string, ownerFactor: KeyObject;
const api = (method: string, path: string, body?: unknown, token?: string, extra: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const req = request(fixture.info.url + path, { method, headers: { host: "home.example.test", origin, "content-type": "application/json", ...(encoded ? { "content-length": String(encoded.length) } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") }); } catch (error) { reject(error); } });
  });
  req.on("error", reject);
  req.end(encoded);
});
// A mutating owner request on a Cloud home carries a signed step-up for its own method, path and body (cloud-auth-api.test.ts step()).
const stepUp = async (method: string, path: string, body: unknown) => {
  const purpose = stepPurpose(method, path, body), challenge = await api("POST", "/api/cloud/challenge", { deviceId: ownerDeviceId, purpose }, ownerToken), at = Date.now();
  expect(challenge.status).toBe(200);
  const signature = sign(null, Buffer.from(`murage:${environmentId}:${ownerDeviceId}:${purpose}:${challenge.body.challenge}:${at}`), ownerFactor).toString("base64url");
  return Buffer.from(JSON.stringify({ challenge: challenge.body.challenge, at, signature })).toString("base64url");
};
const manifestPath = () => join(fixture.info.dataDir, "skills", "file-receipts", "manifest.json");

beforeAll(async () => {
  const instrumentationSource = "const path=await import('node:path'),url=await import('node:url');const controlFixture=await import(url.pathToFileURL(path.join(process.cwd(),'server/cloud-home/control-state-verification.fixture.mjs')).href);controlFixture.installVerificationControl(" + JSON.stringify(origin) + "," + JSON.stringify(cpKeyPem) + ");";
  fixture = await launchVerificationServer({}, undefined, { cloud: { publicOrigin: origin, bootstrapSecret: secret }, instrumentationSource, readyTimeoutMs: 60_000 });
  environmentId = (await api("GET", "/.well-known/murage/environment")).body.environmentId;
  const key = generateKeyPairSync("ed25519"), factor = generateKeyPairSync("ed25519");
  const device = { scope: "owner-desktop", publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), assertionKey: factor.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const pairBody = { account: "fixture-owner", ...device, timestamp: Date.now() / 1000, nonce: randomUUID() };
  const minted = await api("POST", "/api/cloud/pairing", pairBody, undefined, { "x-murage-signature": createHmac("sha256", secret).update(JSON.stringify(pairBody)).digest("hex") });
  expect(minted.status).toBe(200);
  const message = Buffer.from(`murage-pair:${environmentId}:${minted.body.code}:fixture-owner`);
  const redeemed = await api("POST", "/api/cloud/pair", { code: minted.body.code, account: "fixture-owner", signature: sign(null, message, key.privateKey).toString("base64url"), assertionSignature: sign(null, message, factor.privateKey).toString("base64url") });
  expect(redeemed.status).toBe(200);
  ownerToken = redeemed.body.accessToken;
  ownerDeviceId = redeemed.body.deviceId;
  ownerFactor = factor.privateKey;
  const dir = join(fixture.info.dataDir, "skills", "file-receipts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify({ id: "file-receipts", name: "File receipts", version: "1.0.0", description: "Files receipts.", defaultEnabled: true, triggerTerms: ["receipts"], requiredCapabilities: [], audience: "owner" }));
  writeFileSync(join(dir, "SKILL.md"), "---\nname: file-receipts\ndescription: Files receipts.\n---\nSteps.\n");
}, 120_000);
afterAll(async () => { await fixture?.close(); });

describe("W9 Taught by you on a Cloud home", () => {
  it("an owner-desktop session passes the surface check (the Cloud-home guard, not the surface guard, answers)", async () => {
    // A generic desktop-only route that exists on a Cloud home answers an owner-desktop session with something other than the
    // surface 404, so a 404 below cannot come from a request the server saw as "remote".
    const probe = await api("GET", "/api/skills", undefined, ownerToken);
    expect(probe.status).toBe(200);
  }, 60_000);

  it("GET /api/skills/taught is 404 with the route-not-found body", async () => {
    const listed = await api("GET", "/api/skills/taught", undefined, ownerToken);
    expect(listed).toEqual({ status: 404, body: { error: "no such route" } });
  }, 60_000);

  it("PATCH /api/skills/taught/:id is 404 with the route-not-found body, and the recording is left alone", async () => {
    // Its own test: a pre-fix run, whose GET answers with another 404 body, still reaches this assertion.
    const before = readFileSync(manifestPath(), "utf8");
    const change = { bots: ["any-bot"] };
    const patched = await api("PATCH", "/api/skills/taught/file-receipts", change, ownerToken, { "x-murage-step-up": await stepUp("PATCH", "/api/skills/taught/file-receipts", change) });
    expect(patched).toEqual({ status: 404, body: { error: "no such route" } });
    expect(readFileSync(manifestPath(), "utf8")).toBe(before);
  }, 60_000);

  it("a PUT under /api/skills/taught is 404 with the route-not-found body (the guard covers every method, not only GET)", async () => {
    // A pre-fix server reads "taught" as a skill id in PUT /api/skills/:ref/bots/:bot and answers "No such skill.", so this row is RED there.
    const change = { on: true };
    const put = await api("PUT", "/api/skills/taught/bots/any-bot", change, ownerToken, { "x-murage-step-up": await stepUp("PUT", "/api/skills/taught/bots/any-bot", change) });
    expect(put).toEqual({ status: 404, body: { error: "no such route" } });
  }, 60_000);
});
