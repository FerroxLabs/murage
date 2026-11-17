// Seeds: start states for the checker (F6). Single-home seeds are mid-flight states (an open intent) as well as LV; two-home
// seeds put two homes on one owner account. These are shapes, built from the state type only (no predicate details).
import { DAY, MARGIN } from "./domain.ts";
import type { Domain } from "./domain.ts";
import { addKey } from "./flux.ts";
import { clone, emptyWorld } from "./world.ts";
import type { BotId, HomeId, Intent, KeyId, ReqX, WorldX } from "./types.ts";

export interface Seed { name: string; world: WorldX; needsHomes: number }
/** two-home seeds are built with two homes and dropped by `allSeeds` when the domain has one */
const two = (d: Domain): Domain => ({ ...d, homes: Math.max(2, d.homes) });
const K = (bot: BotId, n: number): KeyId => `${bot}:k${n}`;

/** Give `home` a running, proven, active binding for `bot` holding `key` (disk, proof, memory all agree). */
export function bindLive(w: WorldX, home: HomeId, bot: BotId, key: KeyId, state: "active" | "restored_unverified" = "active"): WorldX {
  const h = w.homes[home];
  h.durable.bindings[bot] = { state, emailKeyRef: key };
  h.durable.disk.bots[bot] = key;
  h.durable.proof = { gen: h.durable.disk.gen, bots: { ...h.durable.disk.bots } };
  h.memory.evidence = clone(h.durable.proof);
  h.memory.D[bot] = key; h.memory.botKey[bot] = key; h.memory.running = true;
  h.repairVisible[bot] = false;
  return w;
}
export const openIntent = (o: Partial<Intent> & Pick<Intent, "origin" | "step" | "oldKeyId">, now = 0): Intent =>
  ({ sends: 1, strays: [], deadlineAt: now + DAY - MARGIN, ...(o.rotateIdem !== undefined || o.mintIdem !== undefined ? { at: now } : {}), ...o }) as Intent; // r3.2h: intent.at = the decision time of its op (first send)

export function seedLV(d: Domain): Seed {
  const w = emptyWorld(d);
  w.flux = addKey(w.flux, K("b1", 1), "b1", "h1");
  bindLive(w, "h1", "b1", K("b1", 1));
  return { name: "LV", world: w, needsHomes: 1 };
}
/** Intent already open, rotate POST not yet sent (the idempotency key and deadline committed first). */
export function seedIntentOpen(d: Domain, step: Intent["step"] = "rotate"): Seed {
  const s = seedLV(d);
  s.world.homes.h1.durable.intents.b1 = openIntent({ origin: "rotate", step, oldKeyId: K("b1", 1), rotateIdem: "h1:b1:i1" });
  return { name: `intent-open:${step}`, world: s.world, needsHomes: 1 };
}
/** Mid-flight: Flux already issued K2 and answered 201, the answer is still in the network; the home waits. */
export function seedRotateInFlight(d: Domain): Seed {
  const s = seedIntentOpen(d, "rotate");
  const w = s.world;
  w.flux = addKey(w.flux, K("b1", 2), "b1", "h1", { status: "successor_pending", replaces: K("b1", 1) });
  w.flux.keys[K("b1", 1)].deadlineAt = w.now + DAY; w.flux.keys[K("b1", 1)].successor = K("b1", 2);
  w.flux.holds["h1:b1:i1"] = { idem: "h1:b1:i1", bodyHash: `rotate|b1|${K("b1", 1)}`, keyId: K("b1", 2), until: w.now + DAY };
  const opId = `op${w.nextReq}`;
  w.ops[opId] = { opId, home: "h1", bot: "b1", kind: "rotate", keyId: K("b1", 1), idem: "h1:b1:i1", bodyHash: `rotate|b1|${K("b1", 1)}`, firstSentAt: w.now, outcome: "unknown", delivered: [] };
  w.flux.keys[K("b1", 2)].issuedFor = { home: "h1", opId };
  { const it = w.homes.h1.durable.intents.b1 as unknown as Record<string, unknown>; it.sends = 1; it.unk = { kind: "rotate", first: w.now, last: w.now }; }
  const req: ReqX = { reqId: w.nextReq++, opId, appliedAtFlux: true, inbound: [{ code: 201, keyId: K("b1", 2), oldKeyExpiresAt: w.now + DAY }], dupLeft: 0, answered: false, timedOut: false, dropped: false };
  w.requests.push(req);
  w.budget.calls = Math.max(0, w.budget.calls - 1);
  return { name: "rotate-in-flight", world: w, needsHomes: 1 };
}
/** Two homes, one owner account: the twin holds the source's key (restored backup). */
export function seedTwinHoldsSourceKey(d: Domain): Seed {
  const w = seedLV(two(d)).world;
  bindLive(w, "h2", "b1", K("b1", 1), "restored_unverified");
  return { name: "twin-holds-source-key", world: w, needsHomes: 2 };
}
/** The source rotated since the backup: Flux has K1 (deadline running) -> K2; the source holds K2, the twin still holds K1. */
export function seedSourceRotatedSinceBackup(d: Domain): Seed {
  const w = emptyWorld(two(d));
  w.flux = addKey(w.flux, K("b1", 1), "b1", "h1", { deadlineAt: DAY });
  w.flux = addKey(w.flux, K("b1", 2), "b1", "h1", { status: "successor_pending", replaces: K("b1", 1) });
  w.flux.keys[K("b1", 1)].successor = K("b1", 2);
  bindLive(w, "h1", "b1", K("b1", 2));
  bindLive(w, "h2", "b1", K("b1", 1), "restored_unverified");
  return { name: "source-rotated-since-backup", world: w, needsHomes: 2 };
}
/** After a take: h2 pressed "Use email on this home" and holds an open take intent (disowned K1); h1 was taken over. */
export function seedAfterTake(d: Domain): Seed {
  const w = seedTwinHoldsSourceKey(d).world;
  w.homes.h2.durable.intents.b1 = openIntent({ origin: "take", step: "rotate", oldKeyId: K("b1", 1), disowned: K("b1", 1), rotateIdem: "h2:b1:i1" });
  // h2 pressed take: the press created takeAuth for (h2, b1, K1, op); the take operation is still to be sent
  w.homes.h2.durable.takeAuth.b1 = { target: K("b1", 1), opId: "take-op1" };
  return { name: "after-take", world: w, needsHomes: 2 };
}
/** Shared body of the two stalled-take seeds: h1 pressed "Use email on this home" and holds an open take (disowned K1, which it still holds durably); the source home is not modelled (ci profiles are one-home). */
function takeBase(d: Domain): WorldX {
  const w = seedLV(d).world;
  // r3.2e shape: the owner take press has opened the take (openedAt = 0) on the twin's key K1 and DISOWNED it first: K1 is out of disk, D and
  // the memory key; the binding is active (a Reconnect press on a restored_unverified binding is ignored, so the close path would be unreachable).
  { const h = w.homes.h1; h.durable.bindings.b1 = { state: "active", emailKeyRef: K("b1", 1) };
    delete h.durable.disk.bots.b1; h.durable.disk.gen = Math.max(2, h.durable.disk.gen + 1); h.memory.D = {}; h.memory.botKey = {}; h.memory.evidence = { gen: h.durable.disk.gen, bots: {} }; }
  w.homes.h1.durable.intents.b1 = openIntent({ origin: "take", step: "rotate", oldKeyId: K("b1", 1), disowned: K("b1", 1), rotateIdem: "h1:b1:i1", openedAt: 0 } as never);
  w.homes.h1.durable.takeAuth.b1 = { target: K("b1", 1), opId: "take-op1" };
  w.ops["take-op1"] = { opId: "take-op1", home: "h1", bot: "b1", kind: "rotate", keyId: K("b1", 1), idem: "h1:b1:i1", bodyHash: `rotate|b1|${K("b1", 1)}`, firstSentAt: 0, outcome: "unknown", delivered: [], replayForgone: false, sends: 1 } as never;
  const it = w.homes.h1.durable.intents.b1 as unknown as Record<string, unknown>; it.sends = 1; it.unk = { kind: "rotate", first: 0, last: 0 };
  w.budget.calls = Math.max(0, w.budget.calls - 1);
  return w;
}
/** Coverage seed (stalled-take path): the take's operation is UNKNOWN and the clock is one step (1 h) short of holdEnd = first send + 24 h, so
 *  one clock move makes the take STALLED by time and the Reconnect-close path becomes reachable inside depth 6. */
export function seedTakeStalled(d: Domain): Seed {
  const w = takeBase(d);
  w.now = DAY - 3_600_000; w.flux = { ...w.flux, now: w.now };
  return { name: "take-stalled", world: w, needsHomes: 1 };
}
/** Coverage seed (stalled-take path): the take target K1 is revoked in Flux and h1 has OBSERVED it (observedDead). The take is STALLED by death; no clock move needed. */
export function seedTakeDeadTarget(d: Domain): Seed {
  const w = takeBase(d);
  w.flux.keys[K("b1", 1)].status = "revoked";
  w.homes.h1.durable.observedDead.b1 = K("b1", 1);
  w.homes.h1.repairVisible.b1 = true;
  return { name: "take-dead-target", world: w, needsHomes: 1 };
}
/** Coverage seed (stalled-take CLOSE within depth 6): as take-dead-target, but the owner Reconnect already stamped the take (capability bound to takeAuth
 *  take-op1) and the disowned K1 is already in disk.prev, so the first drive CLOSES the take (reconnect intent, takeAuth dropped). The full path from the bare
 *  press (stamp, save, exec, 4 supSteps, ack, drive) is 8+ steps, beyond the exhaustive depth. */
export function seedTakeStampedClose(d: Domain): Seed {
  const w = seedTakeDeadTarget(d).world;
  w.now = DAY; w.flux = { ...w.flux, now: w.now }; // = holdEnd of the take op (lastSentAt 0): the replay window is over, so I7/I12 allow the new mint
  (w.homes.h1.durable.intents.b1 as unknown as Record<string, unknown>).ownerReconnect = { at: 1, takeAuthOp: "take-op1" };
  w.homes.h1.durable.disk.prev = [K("b1", 1)];
  return { name: "take-stamped-close", world: w, needsHomes: 1 };
}
/** Single home, an unknown live key (kind absent = email:bot) of the same bot that the home has never seen: reconcile must commit twin_key_live. */
export function seedUnknownLiveKey(d: Domain): Seed {
  const w = seedLV(d).world;
  w.flux = addKey(w.flux, K("b1", 2), "b1", "other");
  return { name: "unknown-live-key", world: w, needsHomes: 1 };
}
/** Single home, its own leaked MODEL key in the mint log (never durable here), created 3 days ago, never used: the usage prune may take it. */
export function seedLeakedModelKey(d: Domain): Seed {
  const w = seedLV(d).world;
  w.now = 3 * DAY;
  w.flux = { ...w.flux, now: w.now };
  w.flux = addKey(w.flux, K("b1", 2), "b1", "h1", { kind: "model:x", createdAt: 0 });
  w.flux.keys[K("b1", 1)].createdAt = 0;
  w.homes.h1.durable.mintLog.push({ keyId: K("b1", 2), bot: "b1", opId: "seed-leak", wasDurable: false, at: 0 });
  return { name: "leaked-model-key", world: w, needsHomes: 1 };
}
export function allSeeds(d: Domain): Seed[] {
  const all = [seedLV(d), seedIntentOpen(d, "rotate"), seedIntentOpen(d, "save"), seedIntentOpen(d, "retire_old"), seedRotateInFlight(d),
    seedTwinHoldsSourceKey(d), seedSourceRotatedSinceBackup(d), seedAfterTake(d), seedUnknownLiveKey(d), seedLeakedModelKey(d), seedTakeStalled(d), seedTakeDeadTarget(d), seedTakeStampedClose(d)];
  return all.filter((s) => s.needsHomes <= d.homes);
}
