// r3.2h product part, spec side (item 4) plus the Opus spec-check fix: driven scenarios on the REAL reducer and world.
import { describe, expect, it } from "vitest";
import { CI_DOMAIN, DAY } from "./domain.ts";
import { I13_reconnectStray24h } from "./invariants.current.ts";
import * as rm from "./reducer.ts";
import { bindLive, seedLV } from "./seeds.ts";
import type { Move } from "./types.ts";
import * as m from "./world.ts";

const D = { ...CI_DOMAIN, budgets: { ...CI_DOMAIN.budgets, calls: 4, lost: 3, clock: 4, crashes: 2 } };
const play = (w0: ReturnType<typeof m.emptyWorld>, moves: Move[]) => {
  let w = w0; w.budget = { ...D.budgets };
  for (const mv of moves) { const r = m.step(w, mv, rm.reduce, D); if (r.error) throw new Error(r.error); w = r.world; }
  return w;
};
// r3.2j (Astra 5): "no DELETE" is judged AFTER the outbox drains: a queued DELETE is seen in the outbox before it runs, and in the ops after.
const deleteSeen = (w0: ReturnType<typeof m.emptyWorld>) => {
  let w = w0, seen = false;
  for (let n = 0; n < 8 && w.homes.h1.outbox.length; n++) {
    seen = seen || w.homes.h1.outbox.some((a) => a.a === "call" && a.kind === "delete");
    w = play(w, [{ k: "exec", home: "h1" }]);
  }
  return seen || Object.values(w.ops).some((o) => o.kind === "delete");
};
// r3.2n (Fable L3): the I13 provenance is judged from the OBSERVED request and answer sequence in the world (a mint of h1 that was DELIVERED a 409 bot_key_exists naming the key),
// never from the reducer's own flag. Each DELETE the real reducer emitted must (a) name a key that sequence shows, (b) carry a flag equal to that observation (a reducer that drops or
// corrupts it dies), and (c) be rejected by the real I13 oracle when the mint is inside 24 h EVEN WITH the flag stripped (the oracle does not depend on the flag).
type WorldT = ReturnType<typeof m.emptyWorld>;
function provenanceIsIndependent(w: WorldT, seen: Array<Record<string, unknown>>) {
  for (const a of seen) {
    const keyId = String(a.keyId);
    const observed = Object.values(w.ops).some((o) => o.home === "h1" && o.kind === "mint" && o.delivered.some((r) => r.code === 409 && r.error === "bot_key_exists" && r.keyId === keyId));
    expect(observed).toBe(true);
    expect((a.cause as { via409?: boolean }).via409 === true).toBe(observed);
    const inside = JSON.parse(JSON.stringify(w)) as WorldT;
    for (const e of inside.homes.h1.durable.mintLog) if (e.keyId === keyId) e.at = inside.now - DAY / 2;
    const stripped = { kind: "call", call: { home: "h1", kind: "delete", keyId, opId: "m1", actor: "auto", cause: { ...(a.cause as object), via409: undefined } } };
    expect(I13_reconnectStray24h(inside as never, stripped as never, inside as never)).toBe(false);
    const flagged = { kind: "call", call: { home: "h1", kind: "delete", keyId, opId: "m1", actor: "auto", cause: a.cause } };
    expect(I13_reconnectStray24h(inside as never, flagged as never, inside as never)).toBe(false);
  }
}
const mintAnswer: Move[] = [{ k: "drive", home: "h1", bot: "b1" }, { k: "exec", home: "h1" }, { k: "apply", reqId: 1, outcome: "normal" }, { k: "deliver", reqId: 1, idx: 0, dup: false }];
const intent = (w: ReturnType<typeof m.emptyWorld>) => w.homes.h1.durable.intents.b1 as unknown as Record<string, unknown>;
const reconnectIntent = { origin: "reconnect", step: "recover", next: "RC", oldKeyId: "b1:k9", mintIdem: "h1:b1:m0", at: 0, sends: 0, strays: [] };

describe("reconnect mint meets a live key: 409 bot_key_exists {X} (r3.2h item 4)", () => {
  it("X is D(bot): alert rotation_live_conflict, the intent holds, no DELETE is ever issued", () => {
    const s = seedLV(D).world;
    s.homes.h1.durable.intents.b1 = { ...reconnectIntent, oldKeyId: "b1:k1" } as never;
    s.homes.h1.durable.mintLog.push({ keyId: "b1:k1", bot: "b1", opId: "x", wasDurable: false, at: -DAY } as never); // r3.2k: the held key is one this home minted (a never-minted durable X is the twin case, see the r3.2k describe)
    const w = play(s, mintAnswer);
    expect(w.alerts.some((a) => a.bot === "b1" && a.code === "rotation_live_conflict")).toBe(true);
    expect(intent(w).step).toBe("held");
    expect(intent(w).heldCode).toBe("rotation_live_conflict");
    expect(deleteSeen(w)).toBe(false);
  });
  it("X is a key this home minted 24 h ago and does not hold: it goes to strays and the mint is re-opped with a fresh idem", () => {
    const s = seedLV(D).world;
    s.homes.h1.durable.disk.bots.b1 = "b1:k9"; const mem = s.homes.h1.memory as unknown as { D: Record<string, string>; botKey: Record<string, string> }; mem.D.b1 = "b1:k9"; mem.botKey.b1 = "b1:k9"; const h1 = s.homes.h1 as unknown as { memory: { evidence?: { bots: Record<string, string> } }; durable: { proof?: { bots: Record<string, string> } } }; for (const e of [h1.memory.evidence, h1.durable.proof]) if (e) e.bots.b1 = "b1:k9";
    s.homes.h1.durable.mintLog.push({ keyId: "b1:k1", bot: "b1", opId: "x", wasDurable: false, at: -DAY } as never);
    s.homes.h1.durable.intents.b1 = reconnectIntent as never;
    const w = play(s, mintAnswer);
    expect(intent(w).strays).toContain("b1:k1");
    expect(intent(w).mintIdem).not.toBe("h1:b1:m0");
    expect(w.alerts.some((a) => a.code === "rotation_live_conflict")).toBe(false);
  });
  const ownNotHeld = (at: number | undefined) => {
    const s = seedLV(D).world;
    s.homes.h1.durable.disk.bots.b1 = "b1:k9"; const mem = s.homes.h1.memory as unknown as { D: Record<string, string>; botKey: Record<string, string> }; mem.D.b1 = "b1:k9"; mem.botKey.b1 = "b1:k9"; const h1 = s.homes.h1 as unknown as { memory: { evidence?: { bots: Record<string, string> } }; durable: { proof?: { bots: Record<string, string> } } }; for (const e of [h1.memory.evidence, h1.durable.proof]) if (e) e.bots.b1 = "b1:k9";
    if (at !== undefined) s.homes.h1.durable.mintLog.push({ keyId: "b1:k1", bot: "b1", opId: "x", wasDurable: false, at } as never);
    s.homes.h1.durable.intents.b1 = reconnectIntent as never;
    return play(s, mintAnswer);
  };
  it("r3.2i DRIVEN: an own X minted inside 24 h (not held) HOLDS with rotation_live_conflict, no stray, no DELETE", () => {
    const w = ownNotHeld(0);
    expect(w.alerts.some((a) => a.bot === "b1" && a.code === "rotation_live_conflict")).toBe(true);
    expect(intent(w).step).toBe("held");
    expect(intent(w).strays).not.toContain("b1:k1");
    expect(deleteSeen(w)).toBe(false);
  });
  it("r3.2i DRIVEN: an X this home never minted holds with rotation_live_conflict (twin marker stays), no stray, no DELETE", () => {
    const w = ownNotHeld(undefined);
    expect(w.alerts.some((a) => a.bot === "b1" && a.code === "rotation_live_conflict")).toBe(true);
    expect(w.homes.h1.durable.twinKeyLive.b1).toBe("b1:k1");
    expect(intent(w).strays).not.toContain("b1:k1");
    expect(deleteSeen(w)).toBe(false);
  });
});

describe("r3.2j spec follow-ups (Opus L1/L2, Astra 3)", () => {
  const setup = (mut: (h: ReturnType<typeof m.emptyWorld>["homes"]["h1"]) => void) => {
    const s = seedLV(D).world;
    s.homes.h1.durable.disk.bots.b1 = "b1:k9"; const mem = s.homes.h1.memory as unknown as { D: Record<string, string>; botKey: Record<string, string> }; mem.D.b1 = "b1:k9"; mem.botKey.b1 = "b1:k9";
    s.homes.h1.durable.intents.b1 = reconnectIntent as never;
    mut(s.homes.h1);
    return play(s, mintAnswer);
  };
  it("L1: an own X minted long ago but still protected in memory (not the disk key) holds with the alert, no stray, no DELETE", () => {
    const w = setup((h) => { h.durable.mintLog.push({ keyId: "b1:k1", bot: "b1", opId: "x", wasDurable: false, at: -DAY } as never); (h.memory as unknown as { botKey: Record<string, string> }).botKey.b1 = "b1:k1"; });
    expect(w.alerts.some((a) => a.bot === "b1" && a.code === "rotation_live_conflict")).toBe(true);
    expect(intent(w).strays).not.toContain("b1:k1");
    expect(deleteSeen(w)).toBe(false);
  });
  it("L2: an own minted X that is already tombstoned (handled) still shows the owner line: alert, no stray, no DELETE", () => {
    const w = setup((h) => { h.durable.mintLog.push({ keyId: "b1:k1", bot: "b1", opId: "x", wasDurable: false, at: -DAY } as never); h.durable.tombstones.push("b1:k1"); });
    expect(w.alerts.some((a) => a.bot === "b1" && a.code === "rotation_live_conflict")).toBe(true);
    expect(intent(w).strays).not.toContain("b1:k1");
    // r3.2k (Astra M2): ALERT AND HOLD: the step is held, and no further mint is ever queued or sent
    expect(intent(w).step).toBe("held");
    expect(intent(w).heldCode).toBe("rotation_live_conflict");
    const mintsBefore = Object.values(w.ops).filter((o) => o.kind === "mint").length;
    expect(deleteSeen(w)).toBe(false);
    const again = play(w, [{ k: "drive", home: "h1", bot: "b1" }]);
    expect(again.homes.h1.outbox.some((a) => a.a === "call" && a.kind === "mint")).toBe(false);
    expect(Object.values(again.ops).filter((o) => o.kind === "mint").length).toBe(mintsBefore);
  });
  it("L2/Astra 3: an X known only from disk.prev (never minted here) gets the twin marker, the alert and the hold; no mint is queued, no DELETE", () => {
    const w = setup((h) => { h.durable.disk.prev.push("b1:k1"); });
    expect(w.alerts.some((a) => a.bot === "b1" && a.code === "rotation_live_conflict")).toBe(true);
    expect(w.homes.h1.durable.twinKeyLive.b1).toBe("b1:k1");
    expect(w.homes.h1.outbox.some((a) => a.a === "call" && a.kind === "mint")).toBe(false);
    expect(deleteSeen(w)).toBe(false);
  });
});

describe("r3.2k spec follow-ups (Astra M2, M3; Opus L4)", () => {
  it("M3: the DURABLE key X with no mint-log entry (a copied foreign credential) gets the twin marker, the alert, no DELETE and no further mint", () => {
    const s = seedLV(D).world;
    s.homes.h1.durable.intents.b1 = { ...reconnectIntent, oldKeyId: "b1:k1" } as never; // D(bot) = b1:k1 (seedLV), no mint-log entry
    expect(s.homes.h1.durable.mintLog.some((e) => e.keyId === "b1:k1")).toBe(false);
    const w = play(s, mintAnswer);
    expect(w.homes.h1.durable.twinKeyLive.b1).toBe("b1:k1");
    expect(w.alerts.some((a) => a.bot === "b1" && a.code === "rotation_live_conflict")).toBe(true);
    expect(w.homes.h1.outbox.some((a) => a.a === "call" && a.kind === "mint")).toBe(false);
    expect(deleteSeen(w)).toBe(false);
  });
});

describe("r3.2l spec follow-ups (Fable M2)", () => {
  it("M2 DRIVEN: a queued re-send of the same mint is in the outbox when the 409 for an unknown X lands: the twin marker drops it (no call for b1 in the outbox, one mint op)", () => {
    const s = seedLV(D).world;
    s.homes.h1.durable.intents.b1 = { ...reconnectIntent, oldKeyId: "b1:k1" } as never; // X = D(bot) with no mint-log entry: the twin case
    const w = play(s, [{ k: "drive", home: "h1", bot: "b1" }, { k: "exec", home: "h1" }, { k: "timeout", reqId: 1 }, { k: "drive", home: "h1", bot: "b1" }]);
    // precondition: the lost-answer re-send is queued (so deleting the dropQueued of the twin branch changes the outcome)
    expect(w.homes.h1.outbox.some((a) => a.a === "call" && a.bot === "b1" && a.kind === "mint" && a.actor === "auto")).toBe(true);
    const w2 = play(w, [{ k: "apply", reqId: 1, outcome: "normal" }, { k: "deliver", reqId: 1, idx: 0, dup: false }]);
    expect(w2.homes.h1.durable.twinKeyLive.b1).toBe("b1:k1");
    expect(w2.homes.h1.outbox.some((a) => a.a === "call" && a.bot === "b1" && a.kind !== "list" && (a.actor === "auto" || a.actor === "reconcile"))).toBe(false);
    expect(Object.values(w2.ops).filter((o) => o.kind === "mint")).toHaveLength(1);
  });
  it("M2 (c409.twin): a queued RECONCILE call for the marked bot is dropped when the marker commits (not only auto calls)", () => {
    const s = seedLV(D).world;
    s.homes.h1.durable.intents.b1 = { ...reconnectIntent, oldKeyId: "b1:k1" } as never;
    const w = play(s, [{ k: "drive", home: "h1", bot: "b1" }, { k: "exec", home: "h1" }]);
    (w.homes.h1 as unknown as { outbox: Array<Record<string, unknown>> }).outbox.push({ a: "call", bot: "b1", kind: "delete", keyId: "b1:k8", actor: "reconcile", cause: { by: "reconcile", listOpId: "l0" } });
    const w2 = play(w, [{ k: "apply", reqId: 1, outcome: "normal" }, { k: "deliver", reqId: 1, idx: 0, dup: false }]);
    expect(w2.homes.h1.durable.twinKeyLive.b1).toBe("b1:k1");
    expect(w2.homes.h1.outbox.some((a) => a.a === "call" && a.bot === "b1" && a.actor === "reconcile")).toBe(false);
  });
  it("M1 (list.twin): a list answer for b1 that marks b2 also drops b2's queued automatic DELETE (two-bot home); b2's owner call and b1's calls are kept", () => {
    const D2 = { ...D, botsPerHome: 2 };
    const w = m.emptyWorld(D2);
    bindLive(w, "h1", "b1", "b1:k1"); bindLive(w, "h1", "b2", "b2:k1");
    const h = w.homes.h1 as unknown as { outbox: Array<Record<string, unknown>> };
    h.outbox.push({ a: "call", bot: "b2", kind: "delete", keyId: "b2:k7", actor: "auto", cause: { by: "stray", opId: "o7" } });
    h.outbox.push({ a: "call", bot: "b2", kind: "delete", keyId: "b2:k8", actor: "owner_take", cause: { by: "take" } });
    h.outbox.push({ a: "call", bot: "b1", kind: "delete", keyId: "b1:k7", actor: "auto", cause: { by: "stray", opId: "o8" } });
    h.outbox.push({ a: "call", bot: "b2", kind: "delete", keyId: "b2:k9", actor: "reconcile", cause: { by: "reconcile", listOpId: "l0" } }); // r3.2m: a queued RECONCILE call is dropped too
    const resp = { code: 200, list: [{ keyId: "b2:kX", status: "live", createdAt: 0, lastUsedAt: null, used: null, kind: "email:bot", bot: "b2" }] };
    const out = rm.reduce(w.homes.h1, { t: "response", now: 1000, reqId: 1, opId: "l1", bot: "b1", kind: "list", resp, duplicate: false } as never).state as unknown as { durable: { twinKeyLive: Record<string, string> }; outbox: Array<Record<string, unknown>> };
    expect(out.durable.twinKeyLive.b2).toBe("b2:kX");
    const left = out.outbox.map((a) => `${String(a.bot)}:${String(a.actor)}`);
    expect(left).not.toContain("b2:auto");
    expect(left).not.toContain("b2:reconcile");
    expect(left).toContain("b2:owner_take");
    expect(left).toContain("b1:auto");
  });
  it("r3.2m (Astra M2, Fable L2): a late foreign-key 409 for a REMOVED binding commits no twin marker, and the removed binding's own stray DELETE still goes out", () => {
    const w = m.emptyWorld(D);
    bindLive(w, "h1", "b1", "b1:k1");
    const h = w.homes.h1 as unknown as { durable: { bindings: Record<string, { state: string }>; intents: Record<string, unknown> }; };
    h.durable.bindings.b1.state = "removed";
    h.durable.intents.b1 = { origin: "recover", step: "drain", next: "close", oldKeyId: null, mintIdem: "h1:b1:m0", sends: 0, strays: ["b1:k1"], at: 0 };
    const out = rm.reduce(w.homes.h1, { t: "response", now: 1000, reqId: 1, opId: "m1", bot: "b1", kind: "mint", idem: "h1:b1:m0", resp: { code: 409, error: "bot_key_exists", keyId: "b1:kX" }, duplicate: false } as never).state as unknown as { durable: { twinKeyLive: Record<string, string> } };
    expect(out.durable.twinKeyLive.b1).toBeUndefined();
    // the same answer for a LIVE binding still commits the marker (the control)
    const live = m.emptyWorld(D); bindLive(live, "h1", "b1", "b1:k1");
    (live.homes.h1 as unknown as { durable: { intents: Record<string, unknown> } }).durable.intents.b1 = { origin: "recover", step: "recover", oldKeyId: null, mintIdem: "h1:b1:m0", sends: 0, strays: [], at: 0 };
    const out2 = rm.reduce(live.homes.h1, { t: "response", now: 1000, reqId: 1, opId: "m1", bot: "b1", kind: "mint", idem: "h1:b1:m0", resp: { code: 409, error: "bot_key_exists", keyId: "b1:kX" }, duplicate: false } as never).state as unknown as { durable: { twinKeyLive: Record<string, string> } };
    expect(out2.durable.twinKeyLive.b1).toBe("b1:kX");
  });
  it("r3.2m: the removed binding's drain proceeds after the late 409 (a DELETE for its stray is queued, nothing blocks it)", () => {
    const w = m.emptyWorld(D);
    bindLive(w, "h1", "b1", "b1:k1");
    const h = w.homes.h1 as unknown as { durable: { bindings: Record<string, { state: string }>; intents: Record<string, unknown> } };
    h.durable.bindings.b1.state = "removed";
    h.durable.intents.b1 = { origin: "recover", step: "drain", next: "close", oldKeyId: null, mintIdem: "h1:b1:m0", sends: 0, strays: ["b1:k7"], at: 0, unk: { kind: "mint", first: 0, last: 0 } };
    const out = rm.reduce(w.homes.h1, { t: "response", now: 1000, reqId: 1, opId: "m1", bot: "b1", kind: "mint", idem: "h1:b1:m0", resp: { code: 409, error: "bot_key_exists", keyId: "b1:kX" }, duplicate: false } as never).state as unknown as { durable: { twinKeyLive: Record<string, string> }; outbox: Array<Record<string, unknown>> };
    expect(out.durable.twinKeyLive.b1).toBeUndefined();
    (out as unknown as { memory: { busy: Record<string, string> } }).memory.busy = {}; // the world clears the in-flight mark when it delivers the answer; this direct reduce does not
    const driven = rm.reduce(out as never, { t: "drive", now: 2000, bot: "b1" } as never) as unknown as { actions: Array<Record<string, unknown>> };
    const queued = [...out.outbox, ...driven.actions];
    expect(queued.some((a) => a.a === "call" && a.kind === "delete" && a.keyId === "b1:k7" && a.bot === "b1")).toBe(true);
  });
  it("r3.2n (Fable L1): a NON-current 409 that commits the marker while the current op is unknown (unk) raises the current-operation alert; the marker still blocks, and no unk means no new alert", () => {
    const build = (withUnk: boolean) => {
      const w = m.emptyWorld(D); bindLive(w, "h1", "b1", "b1:k1");
      (w.homes.h1 as unknown as { durable: { intents: Record<string, unknown> } }).durable.intents.b1 = { origin: "reconnect", step: "recover", oldKeyId: null, mintIdem: "h1:b1:m1", sends: 1, strays: [], at: 0, ...(withUnk ? { unk: { kind: "mint", first: 0, last: 0 } } : {}) };
      return w;
    };
    type Out = { state: { durable: { twinKeyLive: Record<string, string> } }; actions: Array<Record<string, unknown>> };
    const lateAnswer = (w: WorldT, idem: string) => rm.reduce(w.homes.h1, { t: "response", now: 1000, reqId: 1, opId: "m0", bot: "b1", kind: "mint", idem, resp: { code: 409, error: "bot_key_exists", keyId: "b1:kX" }, duplicate: false } as never) as unknown as Out;
    const alerted = (o: Out) => o.actions.some((a) => a.a === "alert" && a.bot === "b1" && a.code === "rotation_live_conflict");
    const stale = lateAnswer(build(true), "h1:b1:m0"); // an answer of an EARLIER op (not the current mintIdem m1)
    expect(stale.state.durable.twinKeyLive.b1).toBe("b1:kX");
    expect(alerted(stale)).toBe(true);
    expect(alerted(lateAnswer(build(false), "h1:b1:m0"))).toBe(false); // no pending unknown operation: nothing stalled, behaviour unchanged
    expect(alerted(lateAnswer(build(true), "h1:b1:m1"))).toBe(true); // the current op keeps its own alert (control)
    // r3.2o (Astra L1 pin): the alert does not depend on the late answer being a MINT: a stale ROTATION answer (not the current op) naming a foreign key commits the marker and must alert too.
    const lateRotate = rm.reduce(build(true).homes.h1, { t: "response", now: 1000, reqId: 1, opId: "r0", bot: "b1", kind: "rotate", idem: "h1:b1:r0", resp: { code: 409, error: "bot_key_exists", keyId: "b1:kX" }, duplicate: false } as never) as unknown as Out;
    expect(lateRotate.state.durable.twinKeyLive.b1).toBe("b1:kX");
    expect(alerted(lateRotate)).toBe(true);
    // r3.2p (Astra r32o L1 pin, design line 86): the rotation's own 409 is `rotation_pending {S}`, not bot_key_exists. A stale rotation answer rotation_pending naming a foreign key,
    // while the current op is unknown, commits the marker and must alert too (the alert does not depend on the error code being bot_key_exists).
    const latePending = rm.reduce(build(true).homes.h1, { t: "response", now: 1000, reqId: 1, opId: "r0", bot: "b1", kind: "rotate", idem: "h1:b1:r0", resp: { code: 409, error: "rotation_pending", keyId: "b1:kX" }, duplicate: false } as never) as unknown as Out;
    expect(latePending.state.durable.twinKeyLive.b1).toBe("b1:kX");
    expect(alerted(latePending)).toBe(true);
    const latePendingNoUnk = rm.reduce(build(false).homes.h1, { t: "response", now: 1000, reqId: 1, opId: "r0", bot: "b1", kind: "rotate", idem: "h1:b1:r0", resp: { code: 409, error: "rotation_pending", keyId: "b1:kX" }, duplicate: false } as never) as unknown as Out;
    expect(alerted(latePendingNoUnk)).toBe(false); // control: no unknown operation, no new alert
  });
  it("I13 provenance across a restart: the 409 provenance (from409) is durable, so the stray DELETE after a power crash and boot still carries cause.via409", () => {
    const s = seedLV(D).world;
    s.homes.h1.durable.disk.bots.b1 = "b1:k9"; const mem = s.homes.h1.memory as unknown as { D: Record<string, string>; botKey: Record<string, string> }; mem.D.b1 = "b1:k9"; mem.botKey.b1 = "b1:k9";
    const h1 = s.homes.h1 as unknown as { memory: { evidence?: { bots: Record<string, string> } }; durable: { proof?: { bots: Record<string, string> } } };
    if (h1.memory.evidence) h1.memory.evidence.bots.b1 = "b1:k9"; if (h1.durable.proof) h1.durable.proof.bots.b1 = "b1:k9";
    s.homes.h1.durable.mintLog.push({ keyId: "b1:k1", bot: "b1", opId: "x", wasDurable: false, at: -DAY } as never);
    s.homes.h1.durable.intents.b1 = reconnectIntent as never;
    let w = play(s, mintAnswer);
    expect(intent(w).from409).toContain("b1:k1");
    w = play(w, [{ k: "crash", home: "h1", mode: "power" }, { k: "boot", home: "h1" }]);
    expect(intent(w).from409).toContain("b1:k1");
    const seen: Array<Record<string, unknown>> = [];
    for (let n = 0; n < 10; n++) {
      for (const a of w.homes.h1.outbox) if (a.a === "call" && a.kind === "delete" && a.keyId === "b1:k1") seen.push(a as unknown as Record<string, unknown>);
      w = play(w, [w.homes.h1.outbox.length ? { k: "exec", home: "h1" } : { k: "drive", home: "h1", bot: "b1" }]);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].cause).toMatchObject({ by: "stray" });
    provenanceIsIndependent(w, seen);
  });
  it("I13 provenance across TWO restarts: from409 survives a second power crash and boot, so the stray DELETE still carries cause.via409 (r3.2p, Astra r32o)", () => {
    const s = seedLV(D).world;
    s.homes.h1.durable.disk.bots.b1 = "b1:k9"; const mem = s.homes.h1.memory as unknown as { D: Record<string, string>; botKey: Record<string, string> }; mem.D.b1 = "b1:k9"; mem.botKey.b1 = "b1:k9";
    const h1 = s.homes.h1 as unknown as { memory: { evidence?: { bots: Record<string, string> } }; durable: { proof?: { bots: Record<string, string> } } };
    if (h1.memory.evidence) h1.memory.evidence.bots.b1 = "b1:k9"; if (h1.durable.proof) h1.durable.proof.bots.b1 = "b1:k9";
    s.homes.h1.durable.mintLog.push({ keyId: "b1:k1", bot: "b1", opId: "x", wasDurable: false, at: -DAY } as never);
    s.homes.h1.durable.intents.b1 = reconnectIntent as never;
    let w = play(s, mintAnswer);
    expect(intent(w).from409).toContain("b1:k1");
    for (let r = 1; r <= 2; r++) {
      w = play(w, [{ k: "crash", home: "h1", mode: "power" }, { k: "boot", home: "h1" }]);
      expect(intent(w).from409, `after restart ${r}`).toContain("b1:k1");
    }
    const seen: Array<Record<string, unknown>> = [];
    for (let n = 0; n < 10; n++) {
      for (const a of w.homes.h1.outbox) if (a.a === "call" && a.kind === "delete" && a.keyId === "b1:k1") seen.push(a as unknown as Record<string, unknown>);
      w = play(w, [w.homes.h1.outbox.length ? { k: "exec", home: "h1" } : { k: "drive", home: "h1", bot: "b1" }]);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].cause).toMatchObject({ by: "stray", via409: true });
    provenanceIsIndependent(w, seen);
  });
  it("I13 provenance DRIVEN: the real reducer's 409 stray DELETE carries cause.via409 (a mutant that stops recording from409 or drops via409 dies here)", () => {
    const s = seedLV(D).world;
    s.homes.h1.durable.disk.bots.b1 = "b1:k9"; const mem = s.homes.h1.memory as unknown as { D: Record<string, string>; botKey: Record<string, string> }; mem.D.b1 = "b1:k9"; mem.botKey.b1 = "b1:k9"; const h1 = s.homes.h1 as unknown as { memory: { evidence?: { bots: Record<string, string> } }; durable: { proof?: { bots: Record<string, string> } } }; for (const e of [h1.memory.evidence, h1.durable.proof]) if (e) e.bots.b1 = "b1:k9";
    s.homes.h1.durable.mintLog.push({ keyId: "b1:k1", bot: "b1", opId: "x", wasDurable: false, at: -DAY } as never);
    s.homes.h1.durable.intents.b1 = reconnectIntent as never;
    let w = play(s, mintAnswer);
    expect(intent(w).strays).toContain("b1:k1");
    const seen: Array<Record<string, unknown>> = [];
    for (let n = 0; n < 8 && w.homes.h1.outbox.length; n++) {
      for (const a of w.homes.h1.outbox) if (a.a === "call" && a.kind === "delete" && a.keyId === "b1:k1") seen.push(a as unknown as Record<string, unknown>);
      w = play(w, [{ k: "exec", home: "h1" }]);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].cause).toMatchObject({ by: "stray" });
    provenanceIsIndependent(w, seen);
  });
});
