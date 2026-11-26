// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { OwnWriteHolds, OwnWriteRefusal, OWN_WRITE_TTL_MS, ownWriteCard, sanitizeOwnWriteHoldsForRestore, type OwnWriteHost } from "./own-write-holds.ts";
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function rig() {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  let time = 1000, token: string | null = null, effects = 0, stamps = 0, projectFails = false;
  const events: string[] = [];
  const host: OwnWriteHost = { db: () => db, now: () => time, restoreToken: () => token,
    valid: () => true, stamp: () => { stamps++; events.push("stamp"); return true; },
    prepare: () => ({ run: before => { before(); events.push("effect"); effects++; return { status: 200, body: { done: true } }; } }),
    project: row => { events.push("project:" + row.state); if (projectFails) throw new Error("disk failed"); },
  };
  const service = new OwnWriteHolds(host);
  const create = (body: Record<string, unknown> = { targetBotId: "target", role: "Reviewed role" }) => service.create({ botId: "lead", threadId: "thread", generation: "generation", tool: "update_bot", body,
    frozen: { principal: { kind: "workspace-owner" } as never, writeKeys: ["bot:target", "roster:target"] }, active: () => true });
  return { db, service, host, create, events, effects: () => effects, stamps: () => stamps,
    advance: (ms: number) => { time += ms; }, restore: () => { token = "restored"; }, failProjection: () => { projectFails = true; } };
}
const approve = (r: ReturnType<typeof rig>, id: string, revision = 1) => r.service.answer(id, revision, "allow", { device: "desktop", at: 1000 }, () => true);
describe("Ask writer durable decisions", () => {
  it("does no effect before Allow and stamps both keys before the effect", async () => {
    const r = rig(), row = r.create(); expect(r.effects()).toBe(0);
    const wait = r.service.wait(row.id); expect((await approve(r, row.id)).status).toBe(200);
    expect(await wait).toEqual({ status: 200, body: { done: true } });
    expect(r.effects()).toBe(1); expect(r.stamps()).toBe(1);
    expect(r.events.indexOf("stamp")).toBeLessThan(r.events.indexOf("effect"));
  });
  it("two devices race on the proved revision and dispatch exactly once", async () => {
    const r = rig(), row = r.create();
    const results = await Promise.all([approve(r, row.id), approve(r, row.id)]);
    expect(results.map(x => x.status).sort()).toEqual([200, 409]); expect(r.effects()).toBe(1);
    expect((await approve(r, row.id)).status).toBe(409);
  });
  it("Deny, Stop, expiry and wrong revisions do not execute", async () => {
    for (const kind of ["deny", "stop", "expire", "revision"] as const) {
      const r = rig(), row = r.create();
      if (kind === "deny") await r.service.answer(row.id, 1, "deny", { device: "phone", at: 1000 }, () => true);
      if (kind === "stop") r.service.stop("thread", "generation");
      if (kind === "expire") { r.advance(OWN_WRITE_TTL_MS); await r.service.tick(); }
      if (kind === "revision") expect((await approve(r, row.id, 2)).status).toBe(409);
      expect(r.effects(), kind).toBe(0);
    }
  });
  it("a projection failure after approval cannot abandon execution", async () => {
    const r = rig(), row = r.create(); r.failProjection();
    await approve(r, row.id); expect(r.effects()).toBe(1); expect(r.service.get(row.id)?.state).toBe("applied");
  });
  it("an applying crash recovers as unknown and never repeats its effect", async () => {
    const r = rig(), row = r.create();
    r.db.prepare("UPDATE own_write_holds SET state='applying',revision=3 WHERE hold_id=?").run(row.id);
    const restarted = new OwnWriteHolds(r.host); await restarted.recover(); await restarted.tick();
    expect(restarted.get(row.id)?.state).toBe("unknown"); expect(r.effects()).toBe(0);
  });
  it("a durable approved request resumes once after restart, including a NULL restore token", async () => {
    const r = rig(), row = r.create();
    r.db.prepare("UPDATE own_write_holds SET state='approved',revision=2,receipt='{}',deadline=2000 WHERE hold_id=?").run(row.id);
    const restarted = new OwnWriteHolds(r.host); await restarted.recover(); await restarted.recover();
    expect(restarted.get(row.id)?.state).toBe("applied"); expect(r.effects()).toBe(1);
  });
  it("a durable approved request is declined on restart without dispatch, including a NULL restore token", async () => {
    const r = rig(), row = r.create();
    r.db.prepare("UPDATE own_write_holds SET state='approved',revision=2,receipt='{}',deadline=2000 WHERE hold_id=?").run(row.id);
    const restarted = new OwnWriteHolds(r.host); await restarted.recover(); await restarted.recover();
    expect(restarted.get(row.id)).toMatchObject({ state: "declined", result: "restart_before_apply", receipt: null, deadline: null });
    expect(r.effects()).toBe(0); expect(r.stamps()).toBe(0);
  });
  it("a restored pending request has no executable body and does not block an identical new request", async () => {
    const r = rig(), row = r.create(); sanitizeOwnWriteHoldsForRestore(r.db);
    expect(r.service.get(row.id)).toMatchObject({ bodyPresent: false, state: "declined", receipt: null });
    const next = r.create(); expect(next.id).not.toBe(row.id);
    expect((await approve(r, row.id)).status).toBe(409); expect(r.effects()).toBe(0);
  });
  it("a restore or target change during preparation prevents the effect", async () => {
    const r = rig(), row = r.create();
    r.host.prepare = () => { r.restore(); return { run: () => { throw new Error("must not dispatch"); } }; };
    await approve(r, row.id); expect(r.effects()).toBe(0); expect(r.service.get(row.id)?.state).toBe("declined");
  });
  it("deduplication, capacity and inactive insertion remain atomic", () => {
    const r = rig(), row = r.create(); expect(r.create().id).toBe(row.id);
    for (let n = 1; n < 8; n++) r.create({ targetBotId: "target", role: String(n) });
    expect(() => r.create({ role: "ninth" })).toThrow(OwnWriteRefusal);
    expect(r.db.prepare("SELECT count(*) n FROM own_write_holds").get()?.n).toBe(8);
  });
  it("a post-effect failure is unknown and a refused stamp runs nothing", async () => {
    const r = rig(), row = r.create(); r.host.prepare = () => ({ run: before => { before(); throw new Error("transport failed"); } });
    await approve(r, row.id); expect(r.service.get(row.id)?.state).toBe("unknown");
    const s = rig(), next = s.create(); s.host.stamp = () => false;
    await approve(s, next.id); expect(s.effects()).toBe(0); expect(s.service.get(next.id)?.state).toBe("declined");
  });
});

it("SQL rejects a forged writer card and binds every real card to its current hold revision", async () => {
  const r = rig();
  r.db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,kind TEXT,json TEXT)");
  const { initializeOwnWriteHolds, ownWriteCard } = await import("./own-write-holds.ts");
  initializeOwnWriteHolds(r.db);
  const row = r.create(), card = { kind: 'own-write', requestId: `own-${row.id}`, writer: ownWriteCard(row) };
  const insert = (value: unknown, id = `own-writer-card-${row.id}`) => r.db.prepare("INSERT INTO messages VALUES(?,?,'options',?)").run(row.threadId, id, JSON.stringify({ kind: 'options', card: value }));
  expect(() => insert({ ...card, writer: { ...card.writer, bodyHash: 'forged' } })).toThrow('writer-card-without-hold');
  expect(() => insert(card, 'another-row')).toThrow('writer-card-without-hold');
  insert(card);
  const { canEmit } = await import('./decision/records.ts');
  expect(canEmit(r.db, row.threadId, { id: `own-writer-card-${row.id}`, kind: 'options', card }, false)).toBe(true);
  expect(() => r.db.prepare("UPDATE messages SET json=?").run(JSON.stringify({ kind: 'options', card: { ...card, writer: { ...card.writer, stateRevision: 2 } } }))).toThrow('writer-card-action-changed');
  expect(r.effects()).toBe(0);
});

it("a changed principal or body after owner approval cannot reach its first effect", async () => {
  for (const change of ['principal', 'body'] as const) {
    const r = rig(), row = r.create();
    r.host.prepare = () => {
      if (change === 'principal') r.host.valid = () => false;
      else r.db.prepare("UPDATE own_write_holds SET body=? WHERE hold_id=?").run(JSON.stringify({ role: 'Different' }), row.id);
      return { run: before => { before(); return { status: 200, body: {} }; } };
    };
    await approve(r, row.id);
    expect(r.effects()).toBe(0); expect(r.service.get(row.id)?.state).toBe('declined');
  }
});

it("an unexpected handler failure before a reported effect is unknown rather than a claimed no-op", async () => {
  const r = rig(), row = r.create();
  r.host.prepare = () => ({ run: () => { throw new Error('unexpected handler failure'); } });
  await approve(r, row.id);
  expect(r.service.get(row.id)?.state).toBe('unknown');
});

it("the review keeps the complete bounded change, including a long instruction tail", async () => {
  const r = rig();
  const instructions = "Reviewed instruction. ".repeat(1000) + "VISIBLE FINAL CHANGE";
  const row = r.create({ targetBotId: "target", instructions });
  const { ownWriteCard } = await import("./own-write-holds.ts");
  expect(ownWriteCard(row).detail).toContain(instructions);
  expect(ownWriteCard(row).detail).toContain("VISIBLE FINAL CHANGE");
  expect(r.effects()).toBe(0);
});

it("restore terminalizes a real stored card with its hold and preserves no Allow authority", async () => {
  const r = rig();
  r.db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,kind TEXT,json TEXT)");
  const { initializeOwnWriteHolds, ownWriteCard, ownWriteCardAuthorized } = await import("./own-write-holds.ts");
  initializeOwnWriteHolds(r.db);
  const row = r.create();
  const id = `own-writer-card-${row.id}`;
  r.db.prepare("INSERT INTO messages VALUES(?,?,'options',?)").run(row.threadId, id,
    JSON.stringify({ id, kind: "options", card: { kind: "own-write", requestId: `own-${row.id}`, writer: ownWriteCard(row) } }));
  sanitizeOwnWriteHoldsForRestore(r.db);
  const saved = JSON.parse(String(r.db.prepare("SELECT json FROM messages").get()!.json));
  expect(saved.card.writer).toMatchObject({ state: "declined", stateRevision: 2, restored: true });
  expect(saved.card.answered).toBe("declined");
  expect(ownWriteCardAuthorized(r.db, row.threadId, saved)).toBe(true);
  expect((await approve(r, row.id, 2)).status).toBe(409);
  expect(r.service.get(row.id)).toMatchObject({ body: {}, bodyPresent: false, receipt: null });
});

it('the owner can review a complete accepted body beyond the former preview cut', () => {
  const r = rig(), role = 'Review this complete change. '.repeat(400) + 'VISIBLE-END';
  const row = r.create({ targetBotId: 'target', role });
  expect(ownWriteCard(row).detail.length).toBeGreaterThan(8192);
  expect(JSON.parse(ownWriteCard(row).detail).role).toBe(role);
  expect(r.effects()).toBe(0);
});

describe("1.0.22 idle: the 30 s recovery tick rewrites nothing that has not changed (q1022-idlerest W-HOLDS-IDLE)", () => {
  it("ten idle minutes of ticks: 0 projections and 0 row writes for a projected waiting hold and an already blanked old terminal hold", async () => {
    const r = rig(), waiting = r.create(), old = r.create({ targetBotId: "other", role: "Old role" });
    await r.service.answer(old.id, 1, "deny", { device: "desktop", at: 1000 }, () => true);
    // fixture age only: the declined hold was last touched 31 days ago, so the tick's blanking pass owns it
    r.db.prepare("UPDATE own_write_holds SET updated_at=? WHERE hold_id=?").run(1000 - 31 * 86_400_000, old.id);
    await r.service.tick();
    expect(r.db.prepare("SELECT body_present AS p, receipt FROM own_write_holds WHERE hold_id=?").get(old.id)).toEqual({ p: 0, receipt: null });
    const changes = () => Number(r.db.prepare("SELECT total_changes() AS n").get()!.n);
    const before = { events: r.events.length, changes: changes() };
    for (let tick = 0; tick < 20; tick++) { r.advance(30_000); await r.service.tick(); }
    expect({ projections: r.events.slice(before.events).filter(e => e.startsWith("project:")), writes: changes() - before.changes }).toEqual({ projections: [], writes: 0 });
    // the effect is kept: the waiting hold still expires and is projected at its TTL
    expect(r.service.get(waiting.id)?.state).toBe("waiting");
    r.advance(OWN_WRITE_TTL_MS); await r.service.tick();
    expect(r.service.get(waiting.id)?.state).toBe("expired");
    expect(r.events.at(-1)).toBe("project:expired");
  });
});
