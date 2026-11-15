// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real Cloud authentication, route policy, one-use CP proofs and dispatcher.
// Only the control plane and engine are fakes; all writes use an isolated home.
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { CloudSessions } from "./cloud-sessions.ts";
import { routeActDigest } from "./cloud-request-auth.ts";
import { skillActDigest } from "./cloud-home/owner-code.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const origin = "https://home.example.test";
const cp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const library = mkdtempSync(join(tmpdir(), "murage-library-cloud-"));
let fixture: VerificationServer, db: DatabaseSync, cookie: string, deviceId: string, chatCookie: string;

async function api(method: string, path: string, body?: unknown, proof?: string, auth = cookie) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(fixture.info.url + path, { method, headers: {
      host: "home.example.test", origin, cookie: auth, "content-type": "application/json",
      ...(encoded ? { "content-length": String(Buffer.byteLength(encoded)) } : {}),
      ...(proof ? { "x-murage-owner-proof": proof } : {}),
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.end(encoded);
  });
}

function proof(act: string) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ type: "murage-owner-act-v1", homeId: "fixture-home", generation: 1,
    account: "fixture-owner", deviceId, act, nonce: randomUUID().replace(/-/g, ""), issuedAt: now - 1000, expiresAt: now + 119_000 })).toString("base64url");
  const signature = sign("sha256", Buffer.from(payload), { key: cp.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return Buffer.from(JSON.stringify({ payload, signature })).toString("base64url");
}
function challengedAct(answer: { status: number; body: any }) {
  expect(answer).toMatchObject({ status: 403, body: { code: "email_code", label: "new_skill", actToken: expect.any(String) } });
  return JSON.parse(Buffer.from(answer.body.actToken.split(".")[0], "base64url").toString()).act as string;
}
async function copyAndBot() {
  const created = await api("POST", "/api/bots", { name: "Library browser fixture" });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  const path = "/api/skills/library:guide-one/duplicate";
  const copied = await api("POST", path, {}, proof(challengedAct(await api("POST", path, {}))));
  expect(copied.status).toBe(201);
  return { bot, copy: copied.body.skill.ref as string };
}

beforeAll(async () => {
  for (let i = 0; i < 12; i++) {
    const id = i === 0 ? "guide-one" : `guide-${i}`;
    mkdirSync(join(library, id));
    writeFileSync(join(library, id, "manifest.json"), JSON.stringify({ id, name: id === "guide-one" ? "Guide One" : id, version: "1.0.0", description: "A clear method.", triggerTerms: ["testing"], defaultEnabled: false, requiredCapabilities: [] }));
    writeFileSync(join(library, id, "SKILL.md"), `---\nname: ${id}\ndescription: A clear method.\n---\nDraft a clear response.\n`);
  }
  const pem = cp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const env = { MURAGE_SKILL_LIBRARY: library, MURAGE_COMPANION_TOKEN: process.env.MURAGE_TEST_DOOR_TOKEN };
  fixture = await launchVerificationServer(process.env, undefined, {
    env,
    cloud: { publicOrigin: origin, bootstrapSecret: "fixture-library-cloud-bootstrap-32-characters" },
    instrumentationSource: `const {pathToFileURL}=await import('node:url'); const {join}=await import('node:path'); const control=await import(pathToFileURL(join(process.cwd(),'server/cloud-home/control-state-verification.fixture.mjs')).href); control.installVerificationControl(${JSON.stringify(origin)},${JSON.stringify(pem)});`,
    readyTimeoutMs: 60_000,
  });
  console.info("Library Cloud fixture", JSON.stringify(fixture.info));
  db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  db.exec("PRAGMA busy_timeout=5000");
  const sessions = new CloudSessions(db, undefined, origin);
  db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','fixture-owner')").run();
  for (const owner of [true, false]) {
    const id = randomUUID(), key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
    db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)")
      .run(id, "fixture-owner", "browser", publicKey, publicKey, Date.now(), Date.now());
    if (owner) {
      deviceId = id;
      const hash = createHash("sha256").update(key.publicKey.export({ type: "spki", format: "der" })).digest("hex");
      db.prepare("INSERT INTO cloud_browser_factors (device,payload,kind,issuedAt,expiresAt,keyHash,stepUpAt) VALUES (?,?,'remembered-owner',?,?,?,?)")
        .run(id, "{}", Date.now(), Date.now() + 86_400_000, hash, Date.now());
    }
    const value = `__Host-murage=${sessions.issue(id).accessToken}`;
    if (owner) cookie = value; else chatCookie = value;
  }
}, 90_000);
afterAll(async () => { db?.close(); await fixture?.close(); await removeTempDir(library); });

it.each(["/api/library/topics", "/api/library/skills"])("admits an authenticated owner browser at %s", async (path) => {
  const answer = await api("GET", path);
  expect(answer.status).toBe(200);
  if (path.endsWith("topics")) expect(answer.body).toMatchObject({ totalSkills: 12, topics: [{ term: "testing", count: 12 }] });
  else expect(answer.body).toMatchObject({ total: 12, items: expect.arrayContaining([expect.objectContaining({ id: "library:guide-one" })]) });
  expect((await api("GET", path, undefined, undefined, chatCookie)).status).toBe(403);
});

it("admits revert and accepts one content-bound approval through Cloud auth", async () => {
  const { bot, copy } = await copyAndBot();
  const onPath = `/api/skills/${copy}/bots/${bot.id}`;
  const onBody = { on: true };
  expect((await api("PUT", onPath, onBody, proof(challengedAct(await api("PUT", onPath, onBody))))).status).toBe(200);
  const path = `/api/skills/${copy}/revert`;
  const detail = await api("GET", "/api/skills/library:guide-one?view=library");
  const act = challengedAct(await api("POST", path, {}));
  expect(act).toBe(skillActDigest(routeActDigest("POST", path, {}), detail.body.scan.contentHash));
  expect((await api("GET", `/api/skills/${copy}?view=library`)).body.bots).toHaveLength(1);
  const header = proof(act);
  expect(await api("POST", path, {}, header)).toMatchObject({ status: 200, body: { reverted: true, movedBots: [{ id: bot.id }] } });
  expect((await api("GET", `/api/skills/${copy}`)).status).toBe(404);
  expect((await api("GET", "/api/skills/library:guide-one?view=library")).body.bots).toContainEqual(expect.objectContaining({ id: bot.id, name: bot.name }));
  expect((await api("POST", path, {}, header)).status).not.toBe(200);
});

it("saves a copy after the existing route approval without consuming a second incompatible proof", async () => {
  const { bot, copy } = await copyAndBot();
  expect((await api("PUT", `/api/skills/library:guide-one/bots/${bot.id}`, { on: true })).status).toBe(200);
  const path = `/api/skills/collection/${copy.slice("collection:".length)}`;
  const body = { description: "My edited method.", body: "Draft a better response." };
  const act = challengedAct(await api("PUT", path, body));
  expect(act).toBe(routeActDigest("PUT", path, body));
  expect((await api("GET", `/api/skills/${copy}`)).body.updatedAt).toBeUndefined();
  const header = proof(act);
  expect((await api("PUT", path, { ...body, body: "Changed after approval." }, header)).status).toBe(403);
  expect(await api("PUT", path, body, header)).toMatchObject({ status: 200, body: { failed: [], needsLook: [] } });
  expect((await api("GET", `/api/skills/${copy}?view=library`)).body.bots).toContainEqual(expect.objectContaining({ id: bot.id, name: bot.name }));
  expect((await api("GET", "/api/skills/library:guide-one?view=library")).body.bots).not.toContainEqual(expect.objectContaining({ id: bot.id, name: bot.name }));
  expect((await api("PUT", path, body, header)).status).toBe(403);
});
