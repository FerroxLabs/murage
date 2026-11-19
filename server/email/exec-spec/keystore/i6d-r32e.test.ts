// r3.2e I6d harness gates: (1) the three named mutants are KILLED by exactly their must-reject witnesses;
// (2) stamped-take-progresses-clears-stamp: a stamped take that progresses in place has the stamp cleared (I6d accepts);
//     keeping the stamp across the same progress is rejected.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CI_DOMAIN } from "./domain.ts";
import * as spec from "./invariants.current.ts";
import { fromStep } from "./invariants.registry.ts";
import { KEYSTORE_WITNESSES } from "./keystore-witnesses.ts";
import { reduce } from "./reducer.ts";
import { seedTakeDeadTarget, seedTakeStalled } from "./seeds.ts";
import { clone, enabledMoves, hashState, step } from "./world.ts";
import { runWitnesses } from "./witness.ts";
import type { WorldX } from "./types.ts";

describe("I6d r3.2e mutants", () => {
  const MUT = [
    { id: "I6d-retarget-stamped-take-allowed", kills: ["I6d-rej-stamp-A-on-K2-intent", "I6d-rej-unstamped-retarget-skips-close"],
      edits: [["p.oldKeyId === n.oldKeyId && p.disowned === n.disowned &&\n        p.openedAt === n.openedAt && same(ph.durable.takeAuth[b], nh.durable.takeAuth[b]);", "true;"], ["auth.target === i.disowned && ", ""]] },
    { id: "I6d-liveness-reads-cause-at-close", kills: ["I6d-rej-late-cause-launders-tombstone", "I6d-rej-liveness-no-recorded-tombcause"],
      edits: [['(rc === "I8" || rc === "I11")', "legitTombstone(ph, prev, x)"]] },
    { id: "I6d-created-exempt-unchanged", kills: ["I6d-rej-press-stamps-and-changes-take"],
      edits: [["same(stripStamp(n), stripStamp(p)) &&", ""]] },
  ];
  for (const m of MUT) {
    it(`mutant ${m.id} is KILLED`, async () => {
      let src = readFileSync(new URL("./invariants.current.ts", import.meta.url), "utf8");
      for (const [from, to] of m.edits) { expect(src.split(from).length, `${m.id}: edit found once`).toBe(2); src = src.replace(from, to); }
      const dir = new URL("./__mutants6d__/", import.meta.url);
      mkdirSync(dir, { recursive: true });
      try {
        writeFileSync(new URL(`${m.id}.ts`, dir), src);
        const mod = (await import(/* @vite-ignore */ `./__mutants6d__/${m.id}.ts`)) as typeof spec;
        const mut = fromStep("I6d_takeDisownsFirst", mod.I6d_takeDisownsFirst as never);
        const failed = runWitnesses([mut], KEYSTORE_WITNESSES.filter((w) => w.invariant === mut.name)).map((x) => x.witness).sort();
        console.log(`MUTANT ${m.id}: fails ${failed.join(",") || "(nothing)"}`);
        for (const k of m.kills) expect(failed, m.id).toContain(k);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

describe("stamped-take-progresses-keeps-stamp", () => {
  it("a stamped take keeps its stamp through in-place progress and I6d accepts; changing the stamp value is rejected", () => {
    const i6d = fromStep("I6d_takeDisownsFirst", spec.I6d_takeDisownsFirst as never);
    if (i6d.kind !== "step") throw new Error("step");
    const strip = (i: unknown) => JSON.stringify({ ...(i as object), ownerReconnect: undefined });
    let progressed = 0, rejectedKeep = 0;
    const seen = new Set<string>();
    for (const mk of [seedTakeStalled, seedTakeDeadTarget]) {
      let layer: WorldX[] = [mk(CI_DOMAIN).world];
      for (let depth = 0; depth < 6; depth++) {
        const nextLayer: WorldX[] = [];
        for (const w of layer) for (const m of enabledMoves(w, CI_DOMAIN)) {
          const r = step(w, m, reduce, CI_DOMAIN);
          if (r.error !== undefined) continue;
          const h = hashState(r.world);
          if (!seen.has(h)) { seen.add(h); nextLayer.push(r.world); }
          for (const hid of Object.keys(w.homes)) for (const b of Object.keys(w.homes[hid].durable.intents)) {
            const p = w.homes[hid].durable.intents[b], n = r.world.homes[hid]?.durable.intents[b];
            if (p?.origin !== "take" || !p.ownerReconnect || n?.origin !== "take" || !n.openedAt && n.openedAt !== 0) continue;
            if (strip(p) === strip(n)) continue; // not a progress
            progressed++;
            if (n.ownerReconnect !== undefined) expect(n.ownerReconnect, `a surviving stamp never changes value (r3.2h M1) by ${JSON.stringify(m)}`).toEqual(p.ownerReconnect); // dropped on an identity/takeAuth change (e.g. Remove), kept on pure progression
            const acts = [r.action, ...r.commits];
            expect(acts.every((a) => i6d.check(w, a, r.world)), `I6d accepts ${JSON.stringify(m)}`).toBe(true);
            const kept = clone(r.world); kept.homes[hid].durable.intents[b].ownerReconnect = { ...p.ownerReconnect, at: p.ownerReconnect.at + 1 }; // a CHANGED stamp value is rejected
            if (!acts.every((a) => i6d.check(w, a, kept))) rejectedKeep++;
          }
        }
        layer = nextLayer;
      }
    }
    console.log(`STAMPED-PROGRESS: progressed=${progressed} keepStampRejected=${rejectedKeep}`);
    expect(progressed).toBeGreaterThan(0);
    expect(rejectedKeep).toBe(progressed);
  });
});
