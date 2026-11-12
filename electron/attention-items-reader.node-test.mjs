// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { createItemsReader } from "../src/attention-ui/items-reader.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const populated = () => ({
  ok: true,
  items: [{ cardId: "card", display: { title: "Private request" }, actionToken: "old-action", openToken: "old-open" }],
  receipts: [{ text: "Private receipt" }], running: [{ doing: "Private work" }], chief: { name: "Chief" },
});
const fixture = () => {
  let result = populated(), state, calls = 0;
  const publications = [];
  const reader = createItemsReader({
    read: () => { calls++; return typeof result === "function" ? result() : Promise.resolve(result); },
    valid: data => Array.isArray(data.items),
    publish: value => { state = value; publications.push(value); },
  });
  return { reader, publications, setResult: value => { result = value; }, get state() { return state; }, get calls() { return calls; } };
};

for (const failure of ["reject", "refuse", "throw", "malformed"]) {
  test(`a populated reader redacts retained content after ${failure} and recovers only from a successful read`, async () => {
    const f = fixture();
    const original = await f.reader.refresh();
    const pending = deferred();
    f.setResult(() => pending.promise);
    const reading = f.reader.refresh();
    assert.equal(f.state.data, original);
    assert.equal(f.state.refreshing, true);
    if (failure === "reject") pending.reject(new Error("read failed"));
    else if (failure === "refuse") pending.resolve({ ok: false });
    else if (failure === "malformed") pending.resolve({ ok: true, items: null });
    else f.setResult(() => { throw new Error("read failed"); });
    assert.equal(await reading, null);
    assert.equal(f.state.data, null);
    assert.equal(f.state.failed, true);
    assert.equal(f.state.refreshing, false);
    assert.equal(JSON.stringify(f.state).includes("Private"), false);
    const recovery = deferred();
    f.setResult(() => recovery.promise);
    const recovering = f.reader.refresh();
    assert.equal(f.state.data, null);
    assert.equal(f.state.refreshing, true);
    const fresh = populated(); fresh.items[0].actionToken = "fresh-action";
    recovery.resolve(fresh);
    assert.equal(await recovering, fresh);
    assert.equal(f.state.failed, false);
    assert.equal(f.state.refreshing, false);
    assert.equal(f.calls, 3);
  });
}

test("refreshes retain card identity, coalesce pushes into one drain, and publish every accepted commit", async () => {
  const f = fixture();
  const original = await f.reader.refresh();
  const first = deferred(), second = deferred();
  const pending = [first, second];
  f.setResult(() => pending.shift().promise);
  const reading = f.reader.refresh();
  assert.equal(f.reader.refresh(), reading);
  assert.equal(f.reader.refresh(), reading);
  assert.equal(f.state.data, original);
  assert.equal(f.state.refreshing, true);
  const stale = populated(); stale.items[0].actionToken = "discarded-action";
  const fresh = populated(); fresh.items[0].actionToken = "fresh-action"; fresh.items[0].openToken = "fresh-open";
  first.resolve(stale); second.resolve(fresh);
  assert.equal(await reading, fresh);
  assert.equal(f.calls, 3);
  assert.equal(f.state.data.items[0].cardId, original.items[0].cardId);
  assert.equal(f.state.data.items[0].actionToken, "fresh-action");
  assert.equal(f.state.data.items[0].openToken, "fresh-open");
  assert.equal(f.publications.some(state => state.data === stale && state.refreshing === true), true, "an accepted commit is never hidden behind a later read");
  const during = f.publications.slice(3, -1);
  assert.ok(during.length > 0);
  assert.ok(during.every(state => state.refreshing));
  assert.equal(f.state.refreshing, false);
});

test("a rejected read redacts content even while the queued read is pending", async () => {
  const f = fixture(); await f.reader.refresh();
  const nextRead = deferred(), recovery = deferred();
  let calls = 0;
  f.setResult(() => {
    if (++calls === 1) return Promise.reject(new Error("read failed"));
    nextRead.resolve(); return recovery.promise;
  });
  const reading = f.reader.refresh(); f.reader.refresh();
  await nextRead.promise;
  assert.equal(f.state.data, null); assert.equal(f.state.refreshing, true);
  assert.equal(f.state.failed, true);
  const fresh = populated(); recovery.resolve(fresh);
  assert.equal(await reading, fresh); assert.equal(f.state.failed, false);
});

test("surface validation refuses incomplete data after a populated read", async () => {
  let value = { ...populated(), pill: { state: "expanded" } }, state;
  const reader = createItemsReader({ read: async () => value, valid: data => Boolean(data.pill), publish: next => { state = next; } });
  await reader.refresh();
  value = populated();
  assert.equal(await reader.refresh(), null);
  assert.equal(state.data, null); assert.equal(state.failed, true);
});

test("disposal suppresses pending publications, queued reads and subsequent refreshes", async () => {
  const f = fixture(); await f.reader.refresh();
  const pending = deferred(), started = deferred();
  f.setResult(() => { started.resolve(); return pending.promise; });
  const reading = f.reader.refresh(); f.reader.refresh();
  await started.promise;
  f.reader.dispose();
  const count = f.publications.length;
  pending.resolve(populated());
  assert.equal(await reading, null); assert.equal(await f.reader.refresh(), null);
  assert.equal(f.publications.length, count); assert.equal(f.calls, 2);
});

test("disposal before a scheduled read prevents the bridge call", async () => {
  const f = fixture();
  const reading = f.reader.refresh();
  f.reader.dispose();
  assert.equal(await reading, null);
  assert.equal(f.calls, 0);
});

// ---- S8R: superseded is a wait, never a failure (design Q4/Q6 R1..R7) ----
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const superseded = { ok: false, reason: "superseded" };
const withRev = (rev, patch = {}) => ({ ...populated(), rev, ...patch });
const timerFixture = (results, { onRead } = {}) => {
  const timers = new Map(); let id = 0, calls = 0, state; const publications = [];
  const reader = createItemsReader({
    read: () => { calls++; onRead?.(calls, reader); const next = results[Math.min(calls - 1, results.length - 1)]; return Promise.resolve(typeof next === "function" ? next() : next); },
    valid: data => Array.isArray(data.items), publish: value => { state = value; publications.push(value); },
    setTimer: (callback, ms) => { timers.set(++id, { callback, ms }); return id; }, clearTimer: key => { timers.delete(key); },
  });
  const fire = async () => { const [key, timer] = [...timers.entries()][0]; timers.delete(key); timer.callback(); await flush(); };
  return { reader, timers, publications, fire, get state() { return state; }, get calls() { return calls; } };
};

test("R1 a superseded read is a wait: nothing is ever published as failed or empty and the fresh data lands", async () => {
  const f = fixture(); await f.reader.refresh(); const before = f.publications.length;
  const fresh = populated(); fresh.items[0].actionToken = "fresh-action"; let n = 0;
  f.setResult(() => Promise.resolve(++n === 1 ? superseded : fresh));
  await f.reader.refresh();
  const during = f.publications.slice(before);
  assert.ok(during.every(s => s.data !== null && s.failed !== true), `publications: ${JSON.stringify(during.map(s => [s.data === null, s.failed]))}`);
  assert.equal(f.state.data, fresh); assert.equal(f.state.refreshing, false);
});
test("R2 a superseded read with no push queued still reads again", async () => {
  const f = fixture(); await f.reader.refresh(); const fresh = populated(); let n = 0;
  f.setResult(() => Promise.resolve(++n === 1 ? superseded : fresh));
  assert.equal(await f.reader.refresh(), fresh); assert.equal(f.calls, 3);
});
test("R1d a superseded read waits for its re-read: nothing is published as empty or failed, the old data and draft stay, refreshing stays true", async () => {
  const f = fixture(); await f.reader.refresh(); f.reader.setDraft("card", { text: "words", replying: true });
  const old = f.state.data, callsAfterInitial = f.calls, before = f.publications.length;
  const d1 = deferred(), d2 = deferred(); let n = 0;
  f.setResult(() => (++n === 1 ? d1.promise : d2.promise));
  const pending = f.reader.refresh();
  d1.resolve(superseded); await flush();
  assert.equal(f.calls - callsAfterInitial, 2, "the superseded read and exactly one re-read");
  const during = f.publications.slice(before);
  assert.ok(during.every(s => s.data !== null && s.failed !== true), `publications: ${JSON.stringify(during.map(s => [s.data === null, s.failed]))}`);
  assert.equal(f.state.data, old); assert.equal(f.state.drafts.card.text, "words"); assert.equal(f.state.refreshing, true);
  const fresh = populated(); fresh.items[0].actionToken = "fresh-action"; d2.resolve(fresh);
  await pending;
  assert.equal(f.state.data, fresh); assert.equal(f.state.drafts.card.text, "words"); assert.equal(f.state.refreshing, false);
});
test("R3 a result whose integer rev is not newer than the applied one is read again, not applied", async () => {
  const f = fixture(); const first = withRev(5); f.setResult(first); await f.reader.refresh();
  const stale = withRev(5, { items: [{ cardId: "card", display: { title: "stale" }, actionToken: "stale-action", openToken: "o" }] }), fresh = withRev(6);
  let n = 0; f.setResult(() => Promise.resolve(++n === 1 ? stale : fresh));
  await f.reader.refresh();
  assert.equal(f.publications.some(s => s.data === stale), false, "stale rev published");
  assert.equal(f.state.data, fresh);
});
test("R3b a result without rev (legacy fakes) is applied", async () => {
  const f = fixture(); const legacy = populated(); f.setResult(legacy);
  assert.equal(await f.reader.refresh(), legacy);
});
test("R4 eight misses publish stalled once, keep data and drafts, then back off and recover with no push", async () => {
  const fresh = withRev(2), first = withRev(1);
  const f = timerFixture([first, ...Array(9).fill(superseded), fresh]);
  await f.reader.refresh(); const cardId = first.items[0].cardId; f.reader.setDraft?.(cardId, { text: "keep", replying: true });
  const reading = f.reader.refresh(); await flush();
  assert.equal(f.calls, 1 + 8, "eight reads before the stall");
  assert.equal(f.publications.filter(s => s.stalled === true).length, 1);
  assert.equal(f.state.stalled, true); assert.equal(f.state.refreshing, true); assert.equal(f.state.failed, false);
  assert.equal(f.state.data, first); assert.equal(f.state.drafts?.[cardId]?.text, "keep");
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].ms, 250);
  await f.fire(); assert.equal(f.calls, 1 + 9); assert.equal([...f.timers.values()][0].ms, 500);
  assert.equal(f.publications.filter(s => s.stalled === true).length, 1, "stall published once");
  await f.fire(); assert.equal(await reading, fresh); assert.equal(f.calls, 1 + 10);
  assert.equal(f.state.stalled, false); assert.equal(f.state.refreshing, false); assert.equal(f.state.data, fresh);
});
test("R4 dispose during a backoff cancels the timer and reads no more", async () => {
  const f = timerFixture([withRev(1), superseded]); await f.reader.refresh();
  const reading = f.reader.refresh(); await flush(); const calls = f.calls; assert.equal(f.timers.size, 1);
  f.reader.dispose(); assert.equal(f.timers.size, 0);
  await Promise.race([reading, new Promise(resolve => setTimeout(resolve, 200))]); await flush();
  assert.equal(f.calls, calls);
});
test("R6 a redacted commit is published even while a push is queued, and drafts are gone while stalled", async () => {
  const first = withRev(1), redacted = withRev(2, { items: [{ cardId: "redacted", display: null, openToken: "o" }] });
  const f = timerFixture([first, redacted, ...Array(20).fill(superseded)]);
  await f.reader.refresh(); f.reader.setDraft?.("card", { text: "secret reply", replying: true });
  const reading = f.reader.refresh(); f.reader.refresh(); await flush();
  const last = [...f.publications].reverse().find(s => s.data !== null);
  assert.ok(last, "data was never published after the redacted commit");
  assert.equal(last.data.items[0].cardId, "redacted"); assert.equal(JSON.stringify(last).includes("Private request"), false);
  assert.equal(JSON.stringify(last).includes("secret reply"), false); assert.deepEqual(last.drafts ?? {}, {});
  assert.equal(f.state.stalled, true);
  f.reader.dispose(); await Promise.race([reading, new Promise(resolve => setTimeout(resolve, 200))]);
});
test("R7 under continuous pushes every accepted commit is published and the miss count resets", async () => {
  const f = timerFixture([withRev(1), superseded, withRev(2), superseded, withRev(3), superseded, withRev(4)], { onRead: (n, reader) => { if (n >= 3 && n <= 6) void reader.refresh(); } });
  await f.reader.refresh(); const reading = f.reader.refresh(); await flush(); await reading;
  assert.deepEqual(f.publications.filter(s => s.data && s.data.rev >= 2).map(s => s.data.rev).filter((rev, i, all) => all.indexOf(rev) === i), [2, 3, 4]);
  assert.equal(f.publications.some(s => s.stalled === true), false); assert.equal(f.state.refreshing, false);
});
test("R5 drafts survive a commit that keeps the cardId, are pruned when it is absent, and are emptied on failure or dispose", async () => {
  for (const ending of ["reject", "refuse", "malformed", "dispose"]) {
    const f = timerFixture([withRev(1), withRev(2), withRev(3, { items: [] }), () => { throw new Error("x"); }]);
    await f.reader.refresh(); f.reader.setDraft("card", { text: "words", replying: true }); f.reader.setDraft("ghost", { text: "x", replying: true });
    assert.deepEqual(Object.keys(f.state.drafts), ["card"], "setDraft ignores an unknown cardId");
    await f.reader.refresh(); assert.equal(f.state.drafts.card.text, "words");
    await f.reader.refresh(); assert.deepEqual(f.state.drafts, {}, "pruned when the card is gone");
    const g = timerFixture([withRev(1), ending === "refuse" ? { ok: false } : ending === "malformed" ? { ok: true, items: null } : () => { throw new Error("x"); }]);
    await g.reader.refresh(); g.reader.setDraft("card", { text: "words", replying: true });
    if (ending === "dispose") { const count = g.publications.length; g.reader.dispose(); g.reader.setDraft("card", { text: "again", replying: true }); assert.equal(g.publications.length, count, "no publication after dispose"); } else { await g.reader.refresh(); assert.deepEqual(g.state.drafts, {}, ending); }
  }
});
