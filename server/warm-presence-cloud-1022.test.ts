// Warm presence P-SIG 3a on a Cloud home (designs/WARM-W1-1022-presence.md r2; ASTRA High f47d347b39, OPUS/FABLE High 4ee774eaee):
// on a Cloud home the "desktop" surface also covers the owner's phone, so only the owner-desktop scope reports the machine's lock
// state. A booted Cloud-home fixture server, real device sessions, the real POST /api/presence route; the away edge is read from the
// presence clock's own content-free line (`presence warm state=away cause=locked`) in the server log.
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { CloudSessions } from "./cloud-sessions.ts";

const origin = "https://home.example.test";
let fixture: VerificationServer, db: DatabaseSync;
const credentials: Record<string, Record<string, string>> = {};

function call(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(fixture.info.url + path, { method, headers: {
      host: "home.example.test", origin, "content-type": "application/json", ...credentials[who],
      ...(encoded ? { "content-length": String(Buffer.byteLength(encoded)) } : {}),
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end(encoded);
  });
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (needle: string) => readFileSync(fixture.info.logPath, "utf8").split("\n").filter((l) => l.includes(needle)).length;
async function waitUntil(check: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}
let seq = 0;

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, {
    cloud: { publicOrigin: origin, bootstrapSecret: "fixture-presence-bootstrap-32-characters" },
    instrumentationSource: `process.env.NODE_ENV = "test";`,
  });
  db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  db.exec("PRAGMA busy_timeout=5000");
  const sessions = new CloudSessions(db, undefined, origin);
  db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','fixture-owner')").run();
  const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
  for (const scope of ["owner-desktop", "owner-phone"] as const) {
    const id = randomUUID(), now = Date.now();
    db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)")
      .run(id, "fixture-owner", scope, pem, pem, now, now);
    credentials[scope] = { authorization: `Bearer ${sessions.issue(id).accessToken}` };
  }
}, 120_000);

afterAll(async () => {
  db?.close();
  await fixture?.close();
});

it("W-PR7b-cloud (route): on a Cloud home an owner-desktop write makes him present; the owner's phone reporting `locked` is no away edge; the owner desktop's report is", async () => {
  // P-SIG 1a on a Cloud home: an owner write counts only once cloudAuth has bound the device identity (index.ts, after cloudAuth)
  const created = await call("owner-desktop", "POST", "/api/bots", { name: "presence-cloud", modelSelection: { instanceId: "verification", model: "claude-sonnet-5" } });
  expect(created.status, created.text).toBe(201);
  await waitUntil(() => lines("presence warm state=present") > 0, "the owner to be present").catch(() => {});
  expect(lines("presence warm state=present")).toBe(1); // W-PR7b-cloud:owner-write-present
  const phone = await call("owner-phone", "POST", "/api/presence", { clientId: "phone-fixture-01", seq: ++seq, visible: false, state: "locked" });
  expect(phone.status, phone.text).toBe(204); // the phone reaches the route (its visibility counts)
  await sleep(1_000);
  expect(lines("presence warm state=away cause=locked")).toBe(0); // W-PR7b-cloud:phone-no-edge
  const desk = await call("owner-desktop", "POST", "/api/presence", { clientId: "desk-fixture-01", seq: ++seq, visible: false, state: "locked" });
  expect(desk.status, desk.text).toBe(204);
  await waitUntil(() => lines("presence warm state=away cause=locked") > 0, "the desktop's lock edge").catch(() => {});
  expect(lines("presence warm state=away cause=locked")).toBe(1); // W-PR7b-cloud:desk-edge
}, 120_000);
