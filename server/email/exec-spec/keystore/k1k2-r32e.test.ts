// r3.2e reducer-level: a take press on K2 while take A (K1) is open and stalled is a CLOSE of A (I6d-checked on K1) plus a NEW open on K2
// (own openedAt, own takeAuth, no capability, no tombstone of K1 or K2); and only the owner take press does it.
import { describe, expect, it } from "vitest";
import { CI_DOMAIN } from "./domain.ts";
import { addKey } from "./flux.ts";
import * as spec from "./invariants.current.ts";
import { fromStep } from "./invariants.registry.ts";
import { reduce } from "./reducer.ts";
import { seedTakeDeadTarget } from "./seeds.ts";
import { clone, enabledMoves, step } from "./world.ts";
import type { WorldX } from "./types.ts";

const DAY = 24 * 3600_000;
function world(): WorldX {
  const w = clone(seedTakeDeadTarget(CI_DOMAIN).world);
  w.now = 2 * DAY; w.flux = { ...w.flux, now: w.now };
  w.flux = addKey(w.flux, "b1:k2", "b1", "other");
  return w;
}
describe("K1 to K2 move during an open take", () => {
  it("take press over open take A is ignored; A closes at the Reconnect (I6d on K1); a LATER take press opens take B on K2", () => {
    const i6d = fromStep("I6d_takeDisownsFirst", spec.I6d_takeDisownsFirst as never);
    if (i6d.kind !== "step") throw new Error("step");
    const ok = (w: WorldX, r: ReturnType<typeof step>) => (r.commits.length ? r.commits : [r.action]).every((x) => i6d.check(w, x, r.world)); // same verdict as checker.stepPasses for I6d
    let w = world();
    const intentOf = (x: WorldX) => x.homes.h1.durable.intents.b1 as never as { origin: string; disowned?: string; openedAt?: number; ownerReconnect?: unknown } | undefined;
    const A = { ...intentOf(w)! }, authA = w.homes.h1.durable.takeAuth.b1;
    // 1. take press over the open (stalled) take A, with the twin marker already on K2: ignored, A untouched
    w.homes.h1.durable.twinKeyLive.b1 = "b1:k2";
    const t1 = step(w, { k: "owner", home: "h1", bot: "b1", press: "take" } as never, reduce, CI_DOMAIN);
    expect(t1.error).toBeUndefined();
    expect(intentOf(t1.world)!.disowned).toBe("b1:k1"); expect(t1.world.homes.h1.durable.takeAuth.b1).toEqual(authA);
    expect(ok(w, t1)).toBe(true);
    delete w.homes.h1.durable.twinKeyLive.b1; // a Reconnect press is ignored while a twin marker is set
    // 2. Reconnect press stamps, then the commit closes A with K1 in disk.prev, no tombstone, takeAuth dropped
    let r = step(w, { k: "owner", home: "h1", bot: "b1", press: "reconnect" } as never, reduce, CI_DOMAIN);
    expect(r.error).toBeUndefined(); expect(ok(w, r)).toBe(true); w = r.world;
    expect(intentOf(w)!.ownerReconnect).toBeDefined();
    for (let n = 0; n < 40 && intentOf(w)?.origin === "take"; n++) {
      const em = enabledMoves(w, CI_DOMAIN); const m = em.find((x) => x.k === "exec") ?? em.find((x) => x.k === "supStep") ?? em.find((x) => x.k === "ackDeliver" && !(x as { dup: boolean }).dup) ?? em.find((x) => x.k === "drive");
      if (!m) break;
      r = step(w, m, reduce, CI_DOMAIN); expect(r.error).toBeUndefined();
      expect(ok(w, r), `I6d on ${JSON.stringify(m)}`).toBe(true); w = r.world;
      if (process.env.KDBG) console.log("K1K2 step " + JSON.stringify(m) + " busy=" + JSON.stringify(w.homes.h1.memory) + " acts=" + JSON.stringify(r.reductions.map((x) => x.actions)));
    }
    console.log(`K1K2: after close intent=${JSON.stringify(intentOf(w))} prev=${JSON.stringify(w.homes.h1.durable.disk.prev)} tomb=${JSON.stringify(w.homes.h1.durable.tombstones)} auth=${JSON.stringify(w.homes.h1.durable.takeAuth.b1)}`);
    expect(intentOf(w)!.origin).not.toBe("take");
    w.homes.h1.durable.twinKeyLive.b1 = "b1:k2"; // the twin marker moves to K2
    expect(w.homes.h1.durable.disk.prev).toContain("b1:k1"); expect(w.homes.h1.durable.tombstones).not.toContain("b1:k1");
    expect(w.homes.h1.durable.takeAuth.b1).toBeUndefined();
    // 3. a LATER owner take press on K2 opens take B: own openedAt (= now), own takeAuth, no capability, K1/K2 not tombstoned
    w.now += 3_600_000; w.flux = { ...w.flux, now: w.now };
    delete (intentOf(w) as { unk?: unknown }).unk;
    const pre = clone(w);
    const t3 = step(pre, { k: "owner", home: "h1", bot: "b1", press: "take" } as never, reduce, CI_DOMAIN);
    expect(t3.error).toBeUndefined();
    const B = intentOf(t3.world)!, nb = t3.world.homes.h1.durable;
    console.log(`K1K2: take B intent=${JSON.stringify(B)} auth=${JSON.stringify(nb.takeAuth.b1)}`);
    expect(B.origin).toBe("take"); expect(B.disowned).toBe("b1:k2"); expect(B.openedAt).toBe(pre.now); expect(B.openedAt).not.toBe(A.openedAt);
    expect(nb.takeAuth.b1.target).toBe("b1:k2"); expect(nb.takeAuth.b1.opId).not.toBe(authA.opId); expect(B.ownerReconnect).toBeUndefined();
    expect(nb.tombstones).not.toContain("b1:k2");
    expect(ok(pre, t3)).toBe(true);
    // 4. no other press or event opens a take on K2
    for (const m of [{ k: "owner", home: "h1", bot: "b1", press: "reconnect" }, { k: "drive", home: "h1", bot: "b1" }, { k: "clock", to: 5 * DAY }] as never[]) {
      const q = step(pre, m, reduce, CI_DOMAIN);
      if (q.error !== undefined) continue;
      expect(intentOf(q.world)?.origin === "take" && intentOf(q.world)?.disowned === "b1:k2", `no K2 take from ${JSON.stringify(m)}`).toBe(false);
    }
  });
});
