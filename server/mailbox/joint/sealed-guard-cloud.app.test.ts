// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V (email design r9 3.4, I-1): the sealed routes' computer leg on a booted Cloud home. The owner's paired desktop app (owner-desktop)
// with a step-up assertion passes the Cloud auth layer and the route policy for these desktop-class writes, and its requests arrive over
// loopback here, so the only check left between it and a sealed conversation's real rows is isOwnersComputer in sealedReadAllowed:
// a Cloud home is never the owner's computer. The sealed ledger and its one held row are written at the storage boundary (C0 owns the
// seal itself; read-seal.app.test.ts drives it through a real turn on a desktop install).
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../../scripts/control-murage.ts";
import { CloudSessions } from "../../cloud-sessions.ts";
import { stepPurpose } from "../../cloud-request-auth.ts";

const origin = "https://home.example.test";
const SEALED_TEXT = "Zq7 cloud sealed original line";
const THREAD = "fixture-cloud-sealed-thread";
const desktopKey = generateKeyPairSync("ed25519");
let fixture: VerificationServer, db: DatabaseSync, desktopCookie: string, desktopId: string, environmentId: string;

function api(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(fixture.info.url + path, { method, headers: {
      host: "home.example.test", origin, cookie: desktopCookie, "content-type": "application/json",
      ...(encoded ? { "content-length": String(Buffer.byteLength(encoded)) } : {}), ...extra,
    } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* plain answer */ }
        resolve({ status: res.statusCode!, body: parsed, text });
      });
    });
    req.on("error", reject); req.end(encoded);
  });
}

/** The same request with the owner-desktop device's step-up assertion for exactly this method, path and body. */
async function steppedUp(method: string, path: string, body: unknown) {
  const purpose = stepPurpose(method, path, body);
  const challenge = await api("POST", "/api/cloud/challenge", { deviceId: desktopId, purpose });
  expect(challenge.status, challenge.text).toBe(200);
  const at = Date.now();
  const signature = sign(null, Buffer.from(`murage:${environmentId}:${desktopId}:${purpose}:${challenge.body.challenge}:${at}`), desktopKey.privateKey).toString("base64url");
  return api(method, path, body, { "x-murage-step-up": Buffer.from(JSON.stringify({ challenge: challenge.body.challenge, at, signature })).toString("base64url") });
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, {
    cloud: { publicOrigin: origin, bootstrapSecret: "fixture-sealed-guard-bootstrap-32-characters" },
    instrumentationSource: `const {pathToFileURL}=await import('node:url'); const {join}=await import('node:path'); const control=await import(pathToFileURL(join(process.cwd(),'server/cloud-home/control-state-verification.fixture.mjs')).href); control.installVerificationControl(${JSON.stringify(origin)});`,
    readyTimeoutMs: 60_000,
  });
  db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  db.exec("PRAGMA busy_timeout=5000");
  const sessions = new CloudSessions(db, undefined, origin);
  environmentId = sessions.environmentId;
  db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','fixture-owner')").run();
  desktopId = randomUUID();
  const publicKey = desktopKey.publicKey.export({ type: "spki", format: "pem" }).toString();
  db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)")
    .run(desktopId, "fixture-owner", "owner-desktop", publicKey, publicKey, Date.now(), Date.now());
  desktopCookie = `__Host-murage=${sessions.issue(desktopId).accessToken}`;
  // a completed seal with one held original row and one held picture name (what C0's seal leaves behind)
  db.prepare("INSERT INTO mailbox_sealed_threads(thread_id, generation, state, cursor) VALUES (?, (SELECT COALESCE(MAX(generation), 0) + 1 FROM mailbox_sealed_threads), 'complete', 0)").run(THREAD);
  db.prepare("INSERT INTO mailbox_sealed_rows(thread_id, message_id, json) VALUES (?, 'fixture-held', ?)").run(THREAD, JSON.stringify({ id: "fixture-held", at: 1, role: "user", kind: "text", text: SEALED_TEXT }));
}, 90_000);

afterAll(async () => { db?.close(); await fixture?.close(); });

it("a stepped-up owner-desktop session on a Cloud home is not the owner's computer: the sealed rows answer the guard's 404", async () => {
  const body = { threadId: THREAD, ids: ["fixture-held"] };
  // control: without the step-up the Cloud auth layer stops this write before any handler (so the stepped-up call below passed it)
  const plain = await api("POST", "/api/mailbox/sealed/read", body);
  expect(plain.status, `control: the auth layer asks for a step-up first (${plain.text})`).not.toBe(404);
  expect(plain.text).not.toContain(SEALED_TEXT);
  const stepped = await steppedUp("POST", "/api/mailbox/sealed/read", body);
  // the sealed guard's own answer ({error:"not found"}), not the route policy's unknown-route answer ({error:"no such route"})
  expect([stepped.status, stepped.body?.error], "the sealed guard refuses a Cloud home's owner-desktop").toEqual([404, "not found"]);
  expect(stepped.text, "the sealed original never reaches a Cloud identity").not.toContain(SEALED_TEXT);
}, 60_000);
