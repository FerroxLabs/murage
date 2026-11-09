import test from "node:test";
import assert from "node:assert/strict";
import { createLocalTransport, createCloudTransport } from "./attention-transport.mjs";
import { createAttentionActions } from "./attention-actions.mjs";

const DIGEST = "d".repeat(64);
const entry = { threadId: "t 1", messageId: "m/1", requestId: "r1" };
const open = { threadId: "t 1", messageId: "m/1", requestId: "r1", outsideOk: { "banner-win": true }, digest: DIGEST };
const respond = status => new Response(JSON.stringify(status === 403 ? { code: "previews_off" } : {}), { status });

test("local: reads the card with the surface headers, posts the exact body, secret only in headers", async () => {
  const calls = [];
  const t = createLocalTransport({ origin: "http://127.0.0.1:8799", secret: "s3cret", identity: () => "id", fetchImpl: async (url, init) => { calls.push([url, init]); return url.includes("/card") ? Response.json(open) : respond(200); } });
  const card = await t.readCard(entry, () => {});
  assert.equal(card.open, true); assert.equal(card.digest, DIGEST);
  assert.equal(calls[0][0], "http://127.0.0.1:8799/api/desktop/attention/card?threadId=t%201&messageId=m%2F1");
  assert.equal(calls[0][1].headers["x-murage-surface"], "desktop"); assert.equal(calls[0][1].headers["x-murage-surface-secret"], "s3cret");
  const body = { requestId: "r1", behavior: "allow", outside: { digest: DIGEST, surface: "banner-win" } };
  assert.deepEqual(await t.post(body, () => {}, entry), { ok: true });
  assert.equal(calls[1][0], "http://127.0.0.1:8799/api/threads/t%201/respond");
  assert.deepEqual(JSON.parse(calls[1][1].body), body);
  assert.ok(!calls[1][0].includes("s3cret") && !calls[1][1].body.includes("s3cret"));
});

test("local: 404 is a settled card, other statuses fail the read, a server refusal carries its code", async () => {
  const make = status => createLocalTransport({ origin: "http://x", secret: "s", identity: () => "i", fetchImpl: async () => respond(status) });
  assert.deepEqual(await make(404).readCard(entry, () => {}), { open: false });
  await assert.rejects(make(500).readCard(entry, () => {}));
  assert.deepEqual(await make(403).post({}, () => {}, entry), { ok: false, status: 403, code: "previews_off" });
});

test("local: a guard that throws stops the send before fetch is called", async () => {
  let fetched = 0;
  const t = createLocalTransport({ origin: "http://x", secret: "s", identity: () => "i", fetchImpl: async () => { fetched += 1; return respond(200); } });
  const stop = () => { throw new Error("stop"); };
  await assert.rejects(t.readCard(entry, stop)); await assert.rejects(t.post({}, stop, entry));
  assert.equal(fetched, 0);
});

test("cloud: every send goes through fetchHome with beforeSend = the guard; identity is home|generation|window", async () => {
  let generation = 4, windowId = 11; const seen = [];
  const client = { sessionGeneration: () => generation, fetch: async (homeId, path, init) => { seen.push([homeId, path, init.method ?? "GET", init.beforeSend]); return path.includes("/card") ? Response.json(open) : respond(200); } };
  const t = createCloudTransport({ client, homeId: "home-1", windowId: () => windowId });
  assert.equal(t.current(), "home-1|4|11");
  const guard = () => {};
  await t.readCard(entry, guard); await t.post({ a: 1 }, guard, entry);
  assert.deepEqual(seen.map(s => [s[0], s[2]]), [["home-1", "GET"], ["home-1", "POST"]]);
  assert.ok(seen.every(s => s[3] === guard));
  generation = 5; assert.equal(t.current(), "home-1|5|11");
  windowId = 12; assert.equal(t.current(), "home-1|5|12");
});

test("end to end with act: a Cloud window swap between mint and act refuses with transport and nothing is sent", async () => {
  let windowId = 11, sends = 0;
  const client = { sessionGeneration: () => 1, fetch: async (_h, path, init) => { init.beforeSend(); sends += 1; return path.includes("/card") ? Response.json(open) : respond(200); } };
  const transport = createCloudTransport({ client, homeId: "home-1", windowId: () => windowId });
  const actions = createAttentionActions({ lock: { locked: () => false } });
  const token = actions.mint({ home: "home-1", epoch: "e", threadId: "t 1", messageId: "m/1", requestId: "r1", digest: DIGEST, surfaceId: "s", surface: "banner-win", identity: transport.current(), transport });
  windowId = 12;
  assert.deepEqual(await actions.act(token, "allow"), { ok: false, reason: "transport" });
  assert.equal(sends, 0);
});

test("end to end with act: success posts exactly the documented body through the captured transport", async () => {
  const bodies = [];
  const client = { sessionGeneration: () => 1, fetch: async (_h, path, init) => { init.beforeSend(); if (path.includes("/card")) return Response.json(open); bodies.push(JSON.parse(init.body)); return respond(200); } };
  const transport = createCloudTransport({ client, homeId: "home-1", windowId: () => 11 });
  const actions = createAttentionActions({ lock: { locked: () => false } });
  const mint = () => actions.mint({ home: "home-1", epoch: "e", threadId: "t 1", messageId: "m/1", requestId: "r1", digest: DIGEST, surfaceId: "s", surface: "banner-win", identity: transport.current(), transport });
  assert.deepEqual(await actions.act(mint(), "reply", "  not now  "), { ok: true });
  assert.deepEqual(bodies[0], { requestId: "r1", behavior: "deny", message: "not now", outside: { digest: DIGEST, surface: "banner-win" } });
});
