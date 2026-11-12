import test from "node:test";
import assert from "node:assert/strict";
import { createAttentionActions, cleanReply, MAX_TOKENS } from "./attention-actions.mjs";
import { createLockState } from "./lock-state.mjs";

const DIGEST = "d".repeat(64);
function rig(over = {}) {
  const posts = [], refusals = [], logs = [];
  let locked = false, identity = "id-1", card = { open: true, requestId: "r1", outsideOk: { "banner-win": true }, digest: DIGEST };
  const transport = {
    current: () => identity,
    readCard: async () => over.readCard ? over.readCard() : card,
    post: async body => { posts.push(body); return over.postResult ?? { ok: true }; },
  };
  const actions = createAttentionActions({
    lock: { locked: () => locked }, onRefuse: (entry, reason) => refusals.push([entry.requestId, reason]), log: line => logs.push(line), ...over.deps,
  });
  const mint = (extra = {}) => actions.mint({ home: "local", epoch: "e1", threadId: "t1", messageId: "m1", requestId: "r1", digest: DIGEST, surfaceId: "toast", surface: "banner-win", identity: "id-1", transport, ...extra });
  return { actions, mint, posts, refusals, logs, setLocked: v => { locked = v; }, setIdentity: v => { identity = v; }, setCard: c => { card = c; } };
}

test("a token is 128-bit random hex; an unknown token does nothing", async () => {
  const r = rig(); const token = r.mint();
  assert.match(token, /^[0-9a-f]{32}$/); assert.notEqual(token, r.mint());
  assert.deepEqual(await r.actions.act("0".repeat(32), "allow"), { ok: false, reason: "unknown" });
  assert.equal(r.posts.length, 0); assert.equal(r.refusals.length, 0);
});
test("success posts exactly {requestId, behavior, outside:{digest, surface}} and the token is single use", async () => {
  const r = rig(); const token = r.mint();
  assert.deepEqual(await r.actions.act(token, "allow"), { ok: true });
  assert.deepEqual(r.posts, [{ requestId: "r1", behavior: "allow", outside: { digest: DIGEST, surface: "banner-win" } }]);
  assert.deepEqual(await r.actions.act(token, "allow"), { ok: false, reason: "unknown" });
  assert.equal(r.posts.length, 1);
});
test("deny posts deny; reply posts deny plus the cleaned message; an empty reply sends nothing", async () => {
  let r = rig(); await r.actions.act(r.mint(), "deny");
  assert.equal(r.posts[0].behavior, "deny"); assert.equal("message" in r.posts[0], false);
  r = rig(); await r.actions.act(r.mint(), "reply", "  use the staging\u0007 db\nplease  ");
  assert.deepEqual(r.posts[0], { requestId: "r1", behavior: "deny", message: "use the staging db\nplease", outside: { digest: DIGEST, surface: "banner-win" } });
  r = rig(); assert.deepEqual(await r.actions.act(r.mint(), "reply", "  \u0007 "), { ok: false, reason: "empty" }); assert.equal(r.posts.length, 0);
  assert.equal(cleanReply("x".repeat(2001)), null); assert.equal(cleanReply("x".repeat(2000)).length, 2000); assert.equal(cleanReply(42), null);
});
test("only allow, deny and reply exist: allow-for-task, skip, bulk and anything else are refused", async () => {
  for (const action of ["allowForTask", "skip", "batch", "undo", "answer", "ALLOW", undefined, 7]) {
    const r = rig(); assert.deepEqual(await r.actions.act(r.mint(), action), { ok: false, reason: "action" }); assert.equal(r.posts.length, 0);
  }
});
test("locked or unknown lock state refuses Allow and Reply and opens the card; the token is spent", async () => {
  const r = rig(); r.setLocked(true); const token = r.mint();
  assert.deepEqual(await r.actions.act(token, "allow"), { ok: false, reason: "locked" });
  assert.deepEqual(r.refusals, [["r1", "locked"]]); assert.equal(r.posts.length, 0);
  const r2 = rig(); r2.setLocked(true); assert.equal((await r2.actions.act(r2.mint(), "reply", "hi")).reason, "locked");
});
test("lock-state starts unknown on every OS and unknown counts as locked", () => {
  for (const platform of ["linux", "darwin", "win32"]) assert.equal(createLockState({ platform, powerMonitor: null }).locked(), true, platform);
});
test("lock-state follows lock-screen, unlock-screen and suspend events and tells listeners", () => {
  const handlers = {}; const powerMonitor = { on: (name, fn) => { handlers[name] = fn; } };
  const lock = createLockState({ powerMonitor }); const seen = [];
  lock.onChange(v => seen.push(v));
  handlers["unlock-screen"](); assert.equal(lock.locked(), false);
  handlers["lock-screen"](); assert.equal(lock.locked(), true);
  handlers["unlock-screen"](); assert.equal(lock.locked(), false);
  handlers["suspend"](); assert.equal(lock.locked(), true);
  assert.deepEqual(seen, [false, true, false, true]);
});
test("only an explicit boolean from the reader unlocks; anything else is unknown", async () => {
  for (const bad of [undefined, null, "false", 0, "unlocked", {}]) {
    const lock = createLockState({ readLocked: async () => bad }); await lock.refresh(); assert.equal(lock.locked(), true, String(bad));
  }
  const ok = createLockState({ readLocked: async () => false }); await ok.refresh(); assert.equal(ok.locked(), false);
  const threw = createLockState({ readLocked: async () => { throw new Error("no bus"); } }); await threw.refresh(); assert.equal(threw.locked(), true);
  const bad = createLockState({ readLocked: async () => true }); await bad.refresh(); assert.equal(bad.locked(), true);
});
test("a slow refresh never overwrites a newer lock event", async () => {
  let release; const gate = new Promise(res => { release = res; }); const handlers = {};
  const lock = createLockState({ powerMonitor: { on: (n, f) => { handlers[n] = f; } }, readLocked: async () => { await gate; return false; } });
  const pending = lock.refresh(); handlers["lock-screen"](); release(); await pending;
  assert.equal(lock.locked(), true);
});
test("a changed card, a settled card, a different request, a digest that is not the displayed one, or not outsideOk is refused", async () => {
  for (const card of [{ open: false, requestId: "r1", outsideOk: { "banner-win": true }, digest: DIGEST }, { open: true, requestId: "r2", outsideOk: { "banner-win": true }, digest: DIGEST },
    { open: true, requestId: "r1", outsideOk: { "banner-win": true }, digest: "e".repeat(64) }, { open: true, requestId: "r1", outsideOk: { "banner-win": false }, digest: DIGEST },
    { open: true, requestId: "r1", outsideOk: {}, digest: DIGEST }, null]) {
    const r = rig({ readCard: () => card }); assert.equal((await r.actions.act(r.mint(), "allow")).ok, false); assert.equal(r.posts.length, 0); assert.equal(r.refusals.length, 1);
  }
});
test("a failed or throwing card read refuses and posts nothing", async () => {
  const r = rig({ readCard: () => { throw new Error("down"); } }); assert.equal((await r.actions.act(r.mint(), "allow")).reason, "read"); assert.equal(r.posts.length, 0);
});
test("invalidation: lock, suspend, restart, owner change, Cloud window swap, previews change mid-action all spend the token", async () => {
  for (const reason of ["lock", "suspend", "restart", "owner-change", "cloud-window", "previews"]) {
    const r = rig(); const token = r.mint(); r.actions.invalidateAll(reason);
    assert.equal((await r.actions.act(token, "allow")).reason, "unknown"); assert.equal(r.posts.length, 0);
  }
});
test("invalidated DURING the card read: nothing is posted", async () => {
  let release; const gate = new Promise(res => { release = res; });
  const r = rig({ readCard: async () => { await gate; return { open: true, requestId: "r1", outsideOk: { "banner-win": true }, digest: DIGEST }; } });
  const pending = r.actions.act(r.mint(), "allow"); r.actions.invalidateAll("previews"); release();
  assert.equal((await pending).reason, "invalidated"); assert.equal(r.posts.length, 0);
});
test("lock arriving during the card read: nothing is posted", async () => {
  let release; const gate = new Promise(res => { release = res; });
  const r = rig({ readCard: async () => { await gate; return { open: true, requestId: "r1", outsideOk: { "banner-win": true }, digest: DIGEST }; } });
  const pending = r.actions.act(r.mint(), "allow"); r.setLocked(true); release();
  assert.equal((await pending).reason, "locked"); assert.equal(r.posts.length, 0);
});
test("transport identity changed after mint (old server run, profile switch, Cloud window swap): refused", async () => {
  const r = rig(); const token = r.mint(); r.setIdentity("id-2");
  assert.equal((await r.actions.act(token, "allow")).reason, "transport"); assert.equal(r.posts.length, 0);
  // swapped while the card read is in flight: the synchronous re-test right before the post catches it
  let swapIdentity;
  const gate = rig({ readCard: async () => { swapIdentity("id-3"); return { open: true, requestId: "r1", outsideOk: { "banner-win": true }, digest: DIGEST }; } });
  swapIdentity = gate.setIdentity;
  assert.equal((await gate.actions.act(gate.mint(), "allow")).reason, "transport"); assert.equal(gate.posts.length, 0);
});
test("one action in flight per home, thread and request: a second token for the same card is ignored", async () => {
  let release; const gate = new Promise(res => { release = res; });
  const r = rig({ readCard: async () => { await gate; return { open: true, requestId: "r1", outsideOk: { "banner-win": true }, digest: DIGEST }; } });
  const first = r.actions.act(r.mint(), "allow"); const second = await r.actions.act(r.mint(), "deny");
  assert.deepEqual(second, { ok: false, reason: "in-flight" }); release(); await first;
  assert.equal(r.posts.length, 1); assert.equal(r.posts[0].behavior, "allow");
});
test("the same ids on two homes are two cards", async () => {
  let release; const gate = new Promise(res => { release = res; });
  const r = rig({ readCard: async () => { await gate; return { open: true, requestId: "r1", outsideOk: { "banner-win": true }, digest: DIGEST }; } });
  const a = r.actions.act(r.mint({ home: "local" }), "allow"); const b = r.actions.act(r.mint({ home: "cloud-1" }), "allow"); release(); await a; await b;
  assert.equal(r.posts.length, 2);
});
test("a server refusal opens the card in Murage, never dismisses it, and logs ids only", async () => {
  const r = rig({ postResult: { ok: false, status: 409, code: "card_changed" } });
  const result = await r.actions.act(r.mint(), "allow");
  assert.equal(result.ok, false); assert.deepEqual(r.refusals, [["r1", "server-409"]]);
  assert.equal(r.logs.length, 1); assert.doesNotMatch(r.logs[0], /willRun|detail|message/i); assert.match(r.logs[0], /r1/);
});
test("a throwing post is a refusal, not a crash", async () => {
  const r = rig({ deps: {} }); const t = r.mint({ transport: { current: () => "id-1", readCard: async () => ({ open: true, requestId: "r1", outsideOk: { "banner-win": true }, digest: DIGEST }), post: async () => { throw new Error("net"); } } });
  assert.equal((await r.actions.act(t, "allow")).reason, "post"); assert.equal(r.refusals.length, 1);
});
test("the token map is bounded at 1024: the oldest is evicted", async () => {
  const r = rig(); const first = r.mint();
  for (let i = 0; i < MAX_TOKENS; i++) r.mint({ requestId: `x${i}` });
  assert.equal((await r.actions.act(first, "allow")).reason, "unknown");
});
test("setting a new tray menu spends the previous build's tokens", async () => {
  const r = rig(); const old = r.mint({ surfaceId: "menu" }); const other = r.mint({ surfaceId: "toast" });
  r.actions.invalidateSurface("menu");
  assert.equal((await r.actions.act(old, "allow")).reason, "unknown"); assert.equal((await r.actions.act(other, "allow")).ok, true);
});
test("invalidateSurface also stops an action already waiting on its card read", async () => {
  let release; const gate = new Promise(res => { release = res; });
  const r = rig({ readCard: async () => { await gate; return { open: true, requestId: "r1", outsideOk: { "banner-win": true }, digest: DIGEST }; } });
  const pending = r.actions.act(r.mint({ surfaceId: "menu" }), "allow"); r.actions.invalidateSurface("menu"); release();
  assert.equal((await pending).reason, "invalidated"); assert.equal(r.posts.length, 0);
});
test("a recognised token is consumed by its first call, even from the wrong window or with an empty reply, and both go through the refusal handler", async () => {
  const r = rig(); const t = r.mint({ windowId: 7 });
  assert.equal((await r.actions.act(t, "allow", undefined, { windowId: 9 })).reason, "window");
  assert.equal((await r.actions.act(t, "allow", undefined, { windowId: 7 })).reason, "unknown");
  assert.deepEqual(r.refusals, [["r1", "window"]]);
  const e = rig(); const t2 = e.mint(); assert.equal((await e.actions.act(t2, "reply", " ")).reason, "empty");
  assert.equal((await e.actions.act(t2, "reply", "hi")).reason, "unknown"); assert.deepEqual(e.refusals, [["r1", "empty"]]);
});
