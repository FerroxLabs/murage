import test from "node:test";
import assert from "node:assert/strict";
import { createAttentionActions } from "./attention-actions.mjs";

const DIGEST = "d".repeat(64);
function rig({ lockedNow = false } = {}) {
  let locked = lockedNow, identity = "id-1";
  const posts = [], guards = [], refusals = [];
  const actions = createAttentionActions({ lock: { locked: () => locked }, onRefuse: (_e, reason) => refusals.push(reason) });
  const card = { open: true, requestId: "r1", outsideOk: { "banner-win": true }, digest: DIGEST };
  const mint = transport => actions.mint({ home: "cloud-a", epoch: "e1", threadId: "t1", messageId: "m1", requestId: "r1", digest: DIGEST, surfaceId: "s", surface: "banner-win", identity: "id-1", transport });
  return { actions, mint, card, posts, guards, refusals, setLocked: v => { locked = v; }, setIdentity: v => { identity = v; }, current: () => identity };
}

test("the transport receives a guard on the read and on the post (the Cloud beforeSend hook)", async () => {
  const r = rig();
  const transport = { current: r.current, readCard: async (_e, guard) => { r.guards.push(typeof guard); guard(); return r.card; }, post: async (body, guard) => { r.guards.push(typeof guard); guard(); r.posts.push(body); return { ok: true }; } };
  assert.deepEqual(await r.actions.act(r.mint(transport), "allow"), { ok: true });
  assert.deepEqual(r.guards, ["function", "function"]);
});

test("an invalidation between two sends of one read (a 401 retry) stops the second send and refuses", async () => {
  const r = rig();
  const transport = { current: r.current, readCard: async (_e, guard) => { guard(); r.actions.invalidateAll("window"); guard(); return r.card; }, post: async () => { r.posts.push(1); return { ok: true }; } };
  assert.deepEqual(await r.actions.act(r.mint(transport), "deny"), { ok: false, reason: "invalidated" });
  assert.equal(r.posts.length, 0);
});

test("a lock between the read's sends stops Allow and Reply but not Deny", async () => {
  for (const [action, text, expectOk] of [["allow", undefined, false], ["reply", "hi", false], ["deny", undefined, true]]) {
    const r = rig();
    const transport = { current: r.current, readCard: async (_e, guard) => { guard(); r.setLocked(true); guard(); return r.card; }, post: async (_b, guard) => { guard(); r.posts.push(1); return { ok: true }; } };
    const result = await r.actions.act(r.mint(transport), action, text);
    assert.equal(result.ok, expectOk, action);
    if (!expectOk) assert.equal(result.reason, "locked");
  }
});

test("a live identity change (profile switch, swapped window) between sends stops the send", async () => {
  const r = rig();
  const transport = { current: r.current, readCard: async (_e, guard) => { guard(); r.setIdentity("id-2"); return r.card; }, post: async (_b, guard) => { guard(); r.posts.push(1); return { ok: true }; } };
  const result = await r.actions.act(r.mint(transport), "allow");
  assert.equal(result.ok, false); assert.equal(r.posts.length, 0);
});

test("a step-up retry that follows a lock is stopped at the post guard", async () => {
  const r = rig();
  const transport = { current: r.current, readCard: async () => r.card, post: async (_b, guard) => { guard(); r.setLocked(true); guard(); r.posts.push(1); return { ok: true }; } };
  assert.deepEqual(await r.actions.act(r.mint(transport), "allow"), { ok: false, reason: "locked" });
  assert.equal(r.posts.length, 0);
});
